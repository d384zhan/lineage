import { createInterface } from "node:readline/promises";
import { networkInterfaces } from "node:os";
import {
  ProviderSchema,
  type AnnounceResult,
  type EvidenceRef,
  type LineageCommand,
} from "@lineage/contracts";
import {
  DaemonClient,
  deleteAuthSettings,
  detectGitIdentities,
  parseGitIdentity,
  pollForTokens,
  readAuthSettings,
  readHostSettings,
  readMembershipSettings,
  readNetworkSettings,
  readRepoId,
  requestDeviceCode,
  resolveStateDir,
  resolveUserStateDir,
  startDaemon,
  toAuthSettings,
  writeAuthSettings,
  writeHostSettings,
  writeMembershipSettings,
  writeNetworkSettings,
  type ApprovalIo,
  type Fetcher,
  type OAuthConfig,
} from "@lineage/daemon";
import { startRelay } from "@lineage/relay";
import type { MembershipAuthorizer } from "@lineage/relay";
import { TransportError } from "@lineage/transport";
import { CommandArguments, historyCommands } from "@lineage/commands-history";
import { runAgent } from "./run-wrapper";
import { refreshPromptIndex, traceCodeLine } from "@lineage/prompt-index";
import { ensureMcpRegistrations } from "./mcp-register";

const NEVER = new Promise<never>(() => {});
const HOST_APPROVAL_TOKEN = "host-approved-auth0-room";

function localLanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

export async function createHostMembershipAuthorizer(options: {
  repoId: string;
  stateDir: string;
  hostIdentity?: string;
  prompt: (question: string) => Promise<string>;
  print?: (line: string) => void;
}): Promise<MembershipAuthorizer> {
  const print = options.print ?? ((line: string) => console.log(line));
  const settings = await readMembershipSettings(options.stateDir);
  const approved = new Set(settings.members.map((member) => member.identity.toLowerCase()));
  if (options.hostIdentity && !approved.has(options.hostIdentity.toLowerCase())) {
    settings.members.push({
      identity: options.hostIdentity,
      approvedAt: new Date().toISOString(),
    });
    approved.add(options.hostIdentity.toLowerCase());
    await writeMembershipSettings(options.stateDir, settings);
  }
  const pending = new Map<string, Promise<boolean>>();
  return async ({ repoId, actor }) => {
    if (repoId !== options.repoId) return false;
    const key = actor.userId.toLowerCase();
    if (approved.has(key)) return true;
    const existing = pending.get(key);
    if (existing) return await existing;
    const request = (async () => {
      print("");
      const gitName = actor.gitIdentities?.[0]?.name;
      const detail = gitName ? ` (${gitName})` : "";
      const answer = await options.prompt(
        `${actor.userId}${detail} wants to join this repository. Approve? [y/N] `,
      );
      if (!["y", "yes"].includes(answer.trim().toLowerCase())) return false;
      settings.members.push({ identity: actor.userId, approvedAt: new Date().toISOString() });
      approved.add(key);
      await writeMembershipSettings(options.stateDir, settings);
      print(`Approved ${actor.userId}. Future sessions reconnect automatically.`);
      return true;
    })().finally(() => pending.delete(key));
    pending.set(key, request);
    return await request;
  };
}

interface InitDependencies {
  registerMcp: typeof ensureMcpRegistrations;
  refreshIndex: typeof refreshPromptIndex;
}

export function createInitCommand(
  dependencies: InitDependencies = {
    registerMcp: ensureMcpRegistrations,
    refreshIndex: refreshPromptIndex,
  },
): LineageCommand {
  return {
    name: "init",
    description: "Initialize local Lineage identity, MCP tools, and prompt index",
    async run(rawArgs, context) {
      const local = historyCommands.find((command) => command.name === "init");
      if (!local) throw new Error("history init command is missing");
      const initialized = await local.run(rawArgs, context) as {
        repoId: string;
        root: string;
        state: string;
        worktreeChanged: boolean;
        notes: string[];
      };
      const args = new CommandArguments(rawArgs);
      const mcp = args.get("no-mcp") === "true"
        ? { claude: "skipped", codex: "skipped", errors: [] }
        : await dependencies.registerMcp({ cwd: initialized.root });
      let index:
        | { status: "indexed"; entries: number }
        | { status: "skipped" | "failed"; error?: string };
      if (args.get("no-index") === "true") {
        index = { status: "skipped" };
      } else {
        try {
          const refreshed = await dependencies.refreshIndex();
          index = { status: "indexed", entries: refreshed.entries.length };
        } catch (error) {
          index = {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const result = { ...initialized, mcp, index };
      if (context.json) return result;
      const indexText = index.status === "indexed"
        ? `${index.entries} prompts indexed`
        : `index ${index.status}${index.error ? `: ${index.error}` : ""}`;
      return [
        `Lineage initialized for ${initialized.repoId}.`,
        `Local state: ${initialized.state} (worktree unchanged)`,
        `MCP: Claude ${mcp.claude}, Codex ${mcp.codex}`,
        `History: ${indexText}`,
        ...mcp.errors,
      ].join("\n");
    },
  };
}

export const initCommand = createInitCommand();

function parseEvidence(values: readonly string[]): EvidenceRef[] {
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`Evidence must use kind=value (e.g. file=src/auth.ts): ${value}`);
    }
    const kind = value.slice(0, separator);
    const allowed = ["commit", "decision", "intent", "file", "symbol", "request", "agent_answer"];
    if (!allowed.includes(kind)) {
      throw new Error(`Evidence kind must be one of ${allowed.join(", ")}: ${value}`);
    }
    return { kind: kind as EvidenceRef["kind"], value: value.slice(separator + 1) };
  });
}

function friendlyAskError(error: unknown, recipient: string): Error {
  if (error instanceof TransportError) {
    switch (error.code) {
      case "recipient_offline":
        return new Error(
          `${error.message}. Their recorded history is still available: try \`lineage why <path>\`.`,
        );
      case "recipient_ambiguous":
        return new Error(error.message);
      case "request_rejected":
        return new Error(`${recipient} declined the question: ${error.message}`);
      case "request_timeout":
        return new Error(`${recipient} did not answer in time.`);
      default:
        return new Error(`${error.code}: ${error.message}`);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

export const hostCommand: LineageCommand = {
  name: "host",
  description: "Run the relay other laptops connect to (pair with `lineage tunnel`)",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    const stateDir = resolveStateDir(context.cwd);
    const savedHost = await readHostSettings(stateDir);
    const savedNetwork = await readNetworkSettings(stateDir);
    const login = await readAuthSettings(resolveUserStateDir()).catch(() => undefined);
    const port = Number(args.get("port") ?? savedHost?.port ?? "8787");
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("--port must be a valid TCP port");
    }
    const token =
      args.get("token") ??
      savedHost?.roomToken ??
      savedNetwork?.roomToken ??
      crypto.randomUUID().replaceAll("-", "");
    const authDisabled = args.get("no-auth0") === "true";
    const auth0Domain = authDisabled
      ? undefined
      : args.get("auth0-domain") ?? process.env["LINEAGE_AUTH0_DOMAIN"] ?? login?.domain;
    const auth0Audience = authDisabled
      ? undefined
      : args.get("auth0-audience") ?? process.env["LINEAGE_AUTH0_AUDIENCE"] ?? login?.audience;
    if ((auth0Domain && !auth0Audience) || (!auth0Domain && auth0Audience)) {
      throw new Error("--auth0-domain and --auth0-audience must be set together");
    }
    const repoId = await readRepoId(context.cwd);
    const membershipReadline = auth0Domain
      ? createInterface({ input: process.stdin, output: process.stdout })
      : undefined;
    const authorize = auth0Domain
      ? await createHostMembershipAuthorizer({
          repoId,
          stateDir,
          ...(login?.identity ? { hostIdentity: login.identity } : {}),
          prompt: (question) => membershipReadline!.question(question),
        })
      : undefined;
    const relay = startRelay({
      port,
      token,
      hostname: args.get("hostname") ?? "0.0.0.0",
      ...(auth0Domain && auth0Audience
        ? { auth: { issuer: auth0Domain, audience: auth0Audience } }
        : {}),
      ...(authorize ? { authorize } : {}),
      log: (line) => console.log(`[relay] ${line}`),
    });
    await writeHostSettings(stateDir, { roomToken: token, port: relay.port });
    console.log(`lineage relay listening on ws://localhost:${relay.port}`);
    if (auth0Domain) {
      console.log(`Auth0 verification enabled (${auth0Domain}); joiners must \`lineage login\` first.`);
    }
    console.log("");
    console.log("Teammates on this network join with:");
    const advertisedHost = localLanAddress() ?? "<your-ip>";
    console.log(
      auth0Domain
        ? `  lineage join --relay ws://${advertisedHost}:${relay.port}`
        : `  lineage join --relay ws://${advertisedHost}:${relay.port} --token ${token} --user <name>`,
    );
    console.log("  (paste once; Lineage remembers this room on that computer)");
    console.log("");
    console.log("For other networks, expose it with:");
    console.log(`  lineage tunnel --port ${relay.port}`);
    console.log(auth0Domain ? "  (verified teammates request host approval)" : `  (room token: ${token})`);
    return NEVER;
  },
};

export const tunnelCommand: LineageCommand = {
  name: "tunnel",
  description: "Expose the local relay through a free Cloudflare Quick Tunnel",
  async run(rawArgs) {
    const args = new CommandArguments(rawArgs);
    const port = Number(args.get("port") ?? "8787");
    const cloudflared = Bun.which("cloudflared");
    if (!cloudflared) {
      throw new Error(
        [
          "cloudflared is not installed.",
          "Install it with `brew install cloudflared` (macOS) or `winget install Cloudflare.cloudflared` (Windows).",
          `Then run: cloudflared tunnel --url http://localhost:${port}`,
          "Teammates join the printed https://....trycloudflare.com URL as wss://....trycloudflare.com",
        ].join("\n"),
      );
    }
    const child = Bun.spawn(
      [cloudflared, "tunnel", "--url", `http://localhost:${port}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    console.log(`Starting Cloudflare Quick Tunnel for localhost:${port}...`);
    const decoder = new TextDecoder();
    const scan = async (stream: ReadableStream<Uint8Array>) => {
      let buffer = "";
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk);
        const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          const wss = match[0].replace("https://", "wss://");
          console.log("");
          console.log(`Tunnel ready. Teammates join with:`);
          console.log(`  lineage join --relay ${wss} --token <room token> --user <name>`);
          console.log("");
        }
      }
    };
    void scan(child.stdout);
    void scan(child.stderr);
    const code = await child.exited;
    throw new Error(`cloudflared exited with code ${code}`);
  },
};

export function createJoinCommand(userStateDir = resolveUserStateDir()): LineageCommand {
  return {
    name: "join",
    description: "Save the relay URL, room token, and your user name for this repo",
    async run(rawArgs, context) {
      const args = new CommandArguments(rawArgs);
      const stateDir = resolveStateDir(context.cwd);
      const saved = await readNetworkSettings(stateDir);
      const login = await readAuthSettings(userStateDir).catch(() => undefined);
      let relayUrl = args.get("relay") ?? saved?.relayUrl;
      if (!relayUrl) throw new Error("Missing --relay");
      if (relayUrl.startsWith("https://")) relayUrl = `wss://${relayUrl.slice(8)}`;
      if (relayUrl.startsWith("http://")) relayUrl = `ws://${relayUrl.slice(7)}`;
      if (!relayUrl.startsWith("ws://") && !relayUrl.startsWith("wss://")) {
        throw new Error("--relay must be a ws://, wss://, http://, or https:// URL");
      }
      const providerValue = args.get("provider");
      const gitIdentities = detectGitIdentities(
        context.cwd,
        args.all("git-identity").map(parseGitIdentity),
      );
      const settings = {
        relayUrl,
        roomToken:
          args.get("token") ??
          saved?.roomToken ??
          (login ? HOST_APPROVAL_TOKEN : args.require("token")),
        userId: args.get("user") ?? login?.identity ?? saved?.userId ?? args.require("user"),
        ...(providerValue
          ? { provider: ProviderSchema.parse(providerValue) }
          : saved?.provider
            ? { provider: saved.provider }
            : {}),
        ...(gitIdentities.length ? { gitIdentities } : {}),
      };
      const repoId = await readRepoId(context.cwd);
      await writeNetworkSettings(stateDir, settings);
      if (!context.json) {
        return [
          `Joined room ${repoId} as ${settings.userId} via ${relayUrl}.`,
          ...(gitIdentities.length
            ? [`Git identity: ${gitIdentities.map((identity) => `${identity.name} <${identity.email}>`).join(", ")}.`]
            : ["Git identity: none detected; configure Git or pass --git-identity \"Name <email>\"."]),
          `Next: run \`lineage run ${settings.provider ?? "claude"}\` to start your agent with messaging.`,
        ].join("\n");
      }
      return { repoId, ...settings, roomToken: "<saved>" };
    },
  };
}

export const joinCommand = createJoinCommand();

export const identityCommand: LineageCommand = {
  name: "identity",
  description: "List or add Git identities mapped to your Lineage user",
  async run(rawArgs, context) {
    const [action = "list", ...values] = rawArgs;
    const stateDir = resolveStateDir(context.cwd);
    const settings = await readNetworkSettings(stateDir);
    if (!settings) throw new Error("Run `lineage join` before managing identities.");
    if (action === "add") {
      if (!values.length) {
        throw new Error('Usage: lineage identity add "Name <email@example.com>"');
      }
      const aliases = values.map(parseGitIdentity);
      settings.gitIdentities = detectGitIdentities(context.cwd, [
        ...(settings.gitIdentities ?? []),
        ...aliases,
      ]);
      await writeNetworkSettings(stateDir, settings);
    } else if (action === "refresh") {
      settings.gitIdentities = detectGitIdentities(context.cwd, settings.gitIdentities ?? []);
      await writeNetworkSettings(stateDir, settings);
    } else if (action !== "list") {
      throw new Error("Usage: lineage identity [list|refresh|add \"Name <email>\"]");
    }
    const identities = detectGitIdentities(context.cwd, settings.gitIdentities ?? []);
    if (context.json) return { userId: settings.userId, gitIdentities: identities };
    return identities.length
      ? identities.map((identity) => `${identity.name} <${identity.email}>`).join("\n")
      : "No Git identities configured.";
  },
};

export interface LoginDependencies {
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  print?: (line: string) => void;
  userStateDir?: string;
}

export function createLoginCommand(dependencies: LoginDependencies = {}): LineageCommand {
  return {
    name: "login",
    description: "Sign in with Auth0 so relays can verify your identity",
    async run(rawArgs, context) {
      const print = dependencies.print ?? ((line: string) => console.log(line));
      const args = new CommandArguments(rawArgs);
      const userStateDir = dependencies.userStateDir ?? resolveUserStateDir();
      let stored = await readAuthSettings(userStateDir).catch(() => undefined);
      if (!stored) {
        const repoStateDir = (() => {
          try {
            return resolveStateDir(context.cwd);
          } catch {
            return undefined;
          }
        })();
        stored = repoStateDir
          ? await readAuthSettings(repoStateDir).catch(() => undefined)
          : undefined;
        if (stored) await writeAuthSettings(userStateDir, stored);
      }
      const domain =
        args.get("domain") ?? process.env["LINEAGE_AUTH0_DOMAIN"] ?? stored?.domain;
      const clientId =
        args.get("client-id") ?? process.env["LINEAGE_AUTH0_CLIENT_ID"] ?? stored?.clientId;
      const audience =
        args.get("audience") ?? process.env["LINEAGE_AUTH0_AUDIENCE"] ?? stored?.audience;
      if (!domain || !clientId || !audience) {
        throw new Error(
          [
            "Auth0 tenant settings are missing. Provide them once via flags or env vars:",
            '  lineage login --domain dev-xyz.us.auth0.com --client-id <id> --audience "https://lineage/api"',
            "  (or set LINEAGE_AUTH0_DOMAIN / LINEAGE_AUTH0_CLIENT_ID / LINEAGE_AUTH0_AUDIENCE)",
            "See README.md → \"Auth0 identity\" for tenant setup steps.",
          ].join("\n"),
        );
      }
      const config: OAuthConfig = { domain, clientId, audience };
      const device = await requestDeviceCode(config, dependencies.fetcher);
      print("To sign in, open this URL in any browser:");
      print(`  ${device.verification_uri_complete ?? device.verification_uri}`);
      print(`and confirm the code: ${device.user_code}`);
      print("Waiting for the browser login...");
      const tokens = await pollForTokens(config, device, {
        ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
        ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
      });
      const settings = toAuthSettings(config, tokens);
      await writeAuthSettings(userStateDir, settings);
      if (context.json) {
        return { identity: settings.identity, expiresAt: settings.expiresAt };
      }
      return [
        `Signed in as ${settings.identity}.`,
        `The daemon will connect with this identity as your userId${
          settings.refreshToken ? " and refresh the session automatically" : ""
        }.`,
      ].join("\n");
    },
  };
}

export const loginCommand = createLoginCommand();

export function createLogoutCommand(userStateDir = resolveUserStateDir()): LineageCommand {
  return {
    name: "logout",
    description: "Remove the machine-wide Auth0 login",
    async run(_rawArgs, context) {
      deleteAuthSettings(userStateDir);
      return context.json ? { ok: true } : "Logged out. Lineage daemons will connect unauthenticated.";
    },
  };
}

export const logoutCommand = createLogoutCommand();

export const membersCommand: LineageCommand = {
  name: "members",
  description: "List or revoke host-approved repository members",
  async run(rawArgs, context) {
    const [action = "list", ...identityParts] = rawArgs;
    const stateDir = resolveStateDir(context.cwd);
    const settings = await readMembershipSettings(stateDir);
    if (action === "revoke") {
      const identity = identityParts.join(" ").trim();
      if (!identity) throw new Error("Usage: lineage members revoke <identity>");
      const remaining = settings.members.filter(
        (member) => member.identity.toLowerCase() !== identity.toLowerCase(),
      );
      if (remaining.length === settings.members.length) {
        throw new Error(`No approved member matches "${identity}"`);
      }
      settings.members = remaining;
      await writeMembershipSettings(stateDir, settings);
    } else if (action !== "list") {
      throw new Error("Usage: lineage members [list|revoke <identity>]");
    }
    if (context.json) return settings;
    if (!settings.members.length) return "No approved members.";
    return settings.members
      .map((member) => `${member.identity} (approved ${member.approvedAt})`)
      .join("\n");
  },
};

export const daemonCommand: LineageCommand = {
  name: "daemon",
  description: "Legacy standalone messaging process (lineage run starts this automatically)",
  async run(_rawArgs, context) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const io: ApprovalIo = {
      print: (line) => console.log(line),
      prompt: (question) => readline.question(question),
    };
    const daemon = await startDaemon({ cwd: context.cwd, io });
    const shutdown = async () => {
      console.log("\nStopping lineage daemon...");
      await daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return NEVER;
  },
};

export const runCommand: LineageCommand = {
  name: "run",
  description: "Start claude or codex with Lineage; Claude notifications are enabled by default",
  async run(rawArgs, context) {
    const [providerValue, ...extraArgs] = rawArgs;
    const provider = ProviderSchema.parse(providerValue ?? "");
    const requestedChannel = extraArgs.includes("--lineage-channel");
    const disabledChannel = extraArgs.includes("--no-lineage-channel");
    if ((requestedChannel || disabledChannel) && provider !== "claude") {
      throw new Error("Lineage Channel flags are supported only by Claude Code");
    }
    const channel = provider === "claude" && !disabledChannel;
    const agentArgs = extraArgs.filter(
      (arg) => arg !== "--lineage-channel" && arg !== "--no-lineage-channel",
    );
    const result = await runAgent({ cwd: context.cwd, provider, channel, extraArgs: agentArgs });
    return context.json ? result : `exit code ${result.exitCode}`;
  },
};

export const indexCommand: LineageCommand = {
  name: "index",
  description: "Index local Claude and Codex history without copying raw prompts",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    const indexPath = args.get("path");
    const claudeRoot = args.get("claude-root");
    const codexRoot = args.get("codex-root");
    const result = await refreshPromptIndex({
      ...(indexPath ? { indexPath } : {}),
      ...(claudeRoot ? { claudeRoot } : {}),
      ...(codexRoot ? { codexRoot } : {}),
    });
    const byProvider = {
      claude: result.entries.filter((entry) => entry.provider === "claude").length,
      codex: result.entries.filter((entry) => entry.provider === "codex").length,
    };
    if (context.json) return { updatedAt: result.updatedAt, entries: result.entries.length, byProvider };
    return `Indexed ${result.entries.length} prompts (${byProvider.claude} Claude, ${byProvider.codex} Codex). Raw prompt text remains in the original session files.`;
  },
};

export const askCommand: LineageCommand = {
  name: "ask",
  description: "Send a question, context, or request to a teammate's agent",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    const recipient = args.get("to") ?? args.positional[0];
    const kind = args.get("kind") ?? "question";
    if (!["question", "context", "request"].includes(kind)) {
      throw new Error("--kind must be question, context, or request");
    }
    const lineSpec = args.get("line");
    const suppliedText = args.get("text") ?? args.positional.slice(1).join(" ");
    const text = suppliedText ||
      (lineSpec ? `Why was ${lineSpec} implemented this way? Return the originating exact prompt if your local history can match it.` : "");
    if (!recipient || !text) {
      throw new Error('Usage: lineage ask <user> "question" or lineage ask <user> --line path:line');
    }
    const evidence = parseEvidence(args.all("evidence"));
    if (lineSpec) {
      const trace = await traceCodeLine(context.cwd, lineSpec);
      evidence.push(
        { kind: "file", value: lineSpec },
        { kind: "commit", value: trace.commitSha, label: trace.summary },
      );
    }
    const client = await DaemonClient.open(context.cwd);
    console.log(
      kind === "context"
        ? `Waiting for ${recipient} to accept the context...`
        : `Waiting for ${recipient} to approve and answer...`,
    );
    let answer;
    try {
      answer = await client.ask({
        recipient,
        kind: kind as "question" | "context" | "request",
        text,
        evidence,
      });
    } catch (error) {
      throw friendlyAskError(error, recipient);
    }
    if (context.json) return answer;
    if (kind === "context") {
      return `Context accepted by ${recipient}.`;
    }
    const lines = [`${recipient} answered (${answer.mode}):`, "", answer.text];
    if (answer.quotedPrompt) {
      lines.push("", "originating exact prompt:", answer.quotedPrompt);
    }
    if (answer.evidence.length) {
      lines.push("", "evidence:");
      for (const item of answer.evidence) {
        lines.push(`  - ${item.kind}: ${item.value}${item.label ? ` (${item.label})` : ""}`);
      }
    }
    return lines.join("\n");
  },
};

export const replyCommand: LineageCommand = {
  name: "reply",
  description: "Answer an inbound question by requestId (see `lineage inbox`)",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    const requestId = args.get("request") ?? args.positional[0];
    const text = args.get("text") ?? args.positional.slice(1).join(" ");
    if (!requestId || !text) {
      throw new Error('Usage: lineage reply <requestId> "answer" (or --request <id> --text "...")');
    }
    const client = await DaemonClient.open(context.cwd);
    await client.reply({
      requestId,
      text,
      evidence: parseEvidence(args.all("evidence")),
      mode: "manual",
    });
    return context.json ? { ok: true, requestId } : `Answer sent for ${requestId}.`;
  },
};

export const inboxCommand: LineageCommand = {
  name: "inbox",
  description: "List inbound questions and their status",
  async run(_rawArgs, context) {
    const client = await DaemonClient.open(context.cwd);
    const entries = await client.inbox();
    if (context.json) return { entries };
    if (!entries.length) return "Inbox is empty.";
    return entries
      .map(
        (entry) =>
          `[${entry.status}] ${entry.requestId}\n  from ${entry.sender.userId}: ${entry.question.text}` +
          (entry.answer ? `\n  answered (${entry.answer.mode}): ${entry.answer.text}` : ""),
      )
      .join("\n\n");
  },
};

/**
 * Network-aware announce: records the intent locally via the history
 * implementation, then broadcasts it through the daemon so teammates see the
 * announcement (and any conflicts) live. Registered after historyCommands so
 * it replaces the local-only announce in the CLI.
 */
export const announceCommand: LineageCommand = {
  name: "announce",
  description: "Publish a structured implementation intent (broadcast live when the daemon runs)",
  async run(rawArgs, context) {
    const local = historyCommands.find((command) => command.name === "announce");
    if (!local) throw new Error("history announce command is missing");
    const result = (await local.run(rawArgs, context)) as AnnounceResult;
    let broadcast = false;
    try {
      const client = await DaemonClient.open(context.cwd);
      await client.publishIntent(result.intent);
      broadcast = true;
    } catch {
      // Recording locally still succeeded.
    }
    if (context.json) return { ...result, broadcast };
    const lines = [
      `Announced: ${result.intent.summary} (intent ${result.intent.id})`,
      broadcast
        ? "Broadcast to connected teammates."
        : "Daemon not running — recorded locally only.",
    ];
    for (const conflict of result.conflicts) {
      lines.push(
        "",
        `!! ASSUMPTION CONFLICT on "${conflict.key}"`,
        `   ${conflict.left.author.userId} assumes "${conflict.left.value}"`,
        `   ${conflict.right.author.userId} assumes "${conflict.right.value}"`,
      );
    }
    return lines.join("\n");
  },
};

export const networkCommands: readonly LineageCommand[] = [
  initCommand,
  hostCommand,
  tunnelCommand,
  joinCommand,
  identityCommand,
  loginCommand,
  logoutCommand,
  membersCommand,
  daemonCommand,
  runCommand,
  indexCommand,
  askCommand,
  replyCommand,
  inboxCommand,
  announceCommand,
];
