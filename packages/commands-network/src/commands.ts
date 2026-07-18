import { createInterface } from "node:readline/promises";
import {
  ProviderSchema,
  type AnnounceResult,
  type EvidenceRef,
  type LineageCommand,
} from "@lineage/contracts";
import {
  DaemonClient,
  readRepoId,
  resolveStateDir,
  startDaemon,
  writeNetworkSettings,
  type ApprovalIo,
} from "@lineage/daemon";
import { startRelay } from "@lineage/relay";
import { TransportError } from "@lineage/transport";
import { CommandArguments, historyCommands } from "@lineage/commands-history";
import { runAgent } from "./run-wrapper";

const NEVER = new Promise<never>(() => {});

function parseEvidence(values: readonly string[]): EvidenceRef[] {
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`Evidence must use kind=value (e.g. file=src/auth.ts): ${value}`);
    }
    const kind = value.slice(0, separator);
    const allowed = ["commit", "decision", "intent", "file", "symbol", "prompt_hash"];
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
          `${recipient} is not connected right now. Their recorded history is still available: try \`lineage why <path>\`.`,
        );
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
  async run(rawArgs) {
    const args = new CommandArguments(rawArgs);
    const port = Number(args.get("port") ?? "8787");
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("--port must be a valid TCP port");
    }
    const token = args.get("token") ?? crypto.randomUUID().replaceAll("-", "");
    const relay = startRelay({ port, token, log: (line) => console.log(`[relay] ${line}`) });
    console.log(`lineage relay listening on ws://localhost:${relay.port}`);
    console.log("");
    console.log("Teammates on this network join with:");
    console.log(`  lineage join --relay ws://<your-ip>:${relay.port} --token ${token} --user <name>`);
    console.log("");
    console.log("For other networks, expose it with:");
    console.log(`  lineage tunnel --port ${relay.port}`);
    console.log(`  (room token: ${token})`);
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
          "Install it with: winget install Cloudflare.cloudflared",
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

export const joinCommand: LineageCommand = {
  name: "join",
  description: "Save the relay URL, room token, and your user name for this repo",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    let relayUrl = args.require("relay");
    if (relayUrl.startsWith("https://")) relayUrl = `wss://${relayUrl.slice(8)}`;
    if (relayUrl.startsWith("http://")) relayUrl = `ws://${relayUrl.slice(7)}`;
    if (!relayUrl.startsWith("ws://") && !relayUrl.startsWith("wss://")) {
      throw new Error("--relay must be a ws://, wss://, http://, or https:// URL");
    }
    const providerValue = args.get("provider");
    const settings = {
      relayUrl,
      roomToken: args.require("token"),
      userId: args.require("user"),
      ...(providerValue ? { provider: ProviderSchema.parse(providerValue) } : {}),
    };
    const repoId = await readRepoId(context.cwd);
    await writeNetworkSettings(resolveStateDir(context.cwd), settings);
    if (!context.json) {
      return [
        `Joined room ${repoId} as ${settings.userId} via ${relayUrl}.`,
        "Next: run `lineage daemon` in a separate terminal to go online.",
      ].join("\n");
    }
    return { repoId, ...settings, roomToken: "<saved>" };
  },
};

export const daemonCommand: LineageCommand = {
  name: "daemon",
  description: "Go online: connect to the relay and approve incoming questions here",
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
  description: "Start claude or codex with lineage session capture and MCP tools",
  async run(rawArgs, context) {
    const [providerValue, ...extraArgs] = rawArgs;
    const provider = ProviderSchema.parse(providerValue ?? "");
    const result = await runAgent({ cwd: context.cwd, provider, extraArgs: [...extraArgs] });
    return context.json ? result : `exit code ${result.exitCode}`;
  },
};

export const askCommand: LineageCommand = {
  name: "ask",
  description: "Ask a teammate's agent a question (they approve before answering)",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    const recipient = args.get("to") ?? args.positional[0];
    const text = args.get("text") ?? args.positional.slice(1).join(" ");
    if (!recipient || !text) {
      throw new Error('Usage: lineage ask <user> "question" (or --to <user> --text "...")');
    }
    const client = await DaemonClient.open(context.cwd);
    console.log(`Waiting for ${recipient} to approve and answer...`);
    let answer;
    try {
      answer = await client.ask({
        recipient,
        text,
        evidence: parseEvidence(args.all("evidence")),
      });
    } catch (error) {
      throw friendlyAskError(error, recipient);
    }
    if (context.json) return answer;
    const lines = [`${recipient} answered (${answer.mode}):`, "", answer.text];
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
  hostCommand,
  tunnelCommand,
  joinCommand,
  daemonCommand,
  runCommand,
  askCommand,
  replyCommand,
  inboxCommand,
  announceCommand,
];
