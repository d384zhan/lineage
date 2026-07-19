import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLineageCore } from "@lineage/contracts/testing";
import {
  readAuthSettings,
  readMembershipSettings,
  readNetworkSettings,
  startDaemon,
  writeAuthSettings,
  type ApprovalIo,
  type DaemonHandle,
} from "@lineage/daemon";
import { startRelay, type RelayHandle } from "@lineage/relay";
import { announceCommand, askCommand, createHostMembershipAuthorizer, createInitCommand, createJoinCommand, createLoginCommand, createLogoutCommand, identityCommand, inboxCommand, initCommand, joinCommand, membersCommand, replyCommand } from "./commands";
import { ensureMcpRegistrations } from "./mcp-register";
import { runAgent } from "./run-wrapper";
import { loadPromptIndex } from "@lineage/prompt-index";

const TOKEN = "room-secret";

class ScriptedIo implements ApprovalIo {
  readonly printed: string[] = [];
  constructor(private readonly answers: string[] = []) {}
  print(line: string): void {
    this.printed.push(line);
  }
  async prompt(question: string): Promise<string> {
    this.printed.push(question);
    return this.answers.shift() ?? "";
  }
}

let relay: RelayHandle | undefined;
const daemons: DaemonHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const daemon of daemons) await daemon.stop();
  daemons.length = 0;
  relay?.stop();
  relay = undefined;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "lineage-cmd-"));
  tempDirs.push(dir);
  const git = Bun.spawn(["git", "init", "-q"], { cwd: dir });
  if ((await git.exited) !== 0) throw new Error("git init failed");
  mkdirSync(join(dir, ".git", "lineage"), { recursive: true });
  await Bun.write(
    join(dir, ".git", "lineage", "repo.json"),
    JSON.stringify({ protocolVersion: 1, repoId: "repo-1" }, null, 2),
  );
  return dir;
}

async function startRepoDaemon(
  repo: string,
  userId: string,
  options: { io?: ScriptedIo; core?: MockLineageCore } = {},
): Promise<{ handle: DaemonHandle; core: MockLineageCore; io: ScriptedIo }> {
  const io = options.io ?? new ScriptedIo();
  const core = options.core ?? new MockLineageCore();
  const handle = await startDaemon({
    cwd: repo,
    io,
    auth: null,
    stateDir: join(repo, ".git", "lineage"),
    repoId: "repo-1",
    network: {
      relayUrl: relay!.url,
      roomToken: TOKEN,
      userId,
      provider: userId === "alice" ? "claude" : "codex",
    },
    openRuntime: async () => ({ core, close: () => {} }),
    answerer: async () => {},
  });
  daemons.push(handle);
  return { handle, core, io };
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await Bun.sleep(25);
  }
}

describe("mcp registration", () => {
  test("registers installed providers through their supported local CLIs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-mcpjson-"));
    tempDirs.push(dir);
    const calls: string[][] = [];
    const result = await ensureMcpRegistrations({
      cwd: dir,
      serverPath: join(dir, "server.ts"),
      which: (name) => `/bin/${name}`,
      run: (command) => {
        calls.push(command);
        return { exitCode: command.includes("get") ? 1 : 0, stdout: "", stderr: "" };
      },
    });
    expect(result).toEqual({ claude: "registered", codex: "registered", errors: [] });
    expect(calls).toContainEqual([
      "/bin/claude", "mcp", "add", "--scope", "local", "lineage", "--", "bun", join(dir, "server.ts"),
    ]);
    expect(calls).toContainEqual([
      "/bin/codex", "mcp", "add", "lineage", "--", "bun", join(dir, "server.ts"),
    ]);
    expect(await Bun.file(join(dir, ".mcp.json")).exists()).toBeFalse();
  });

  test("does not duplicate existing provider registrations", async () => {
    const calls: string[][] = [];
    const result = await ensureMcpRegistrations({
      cwd: "/tmp",
      which: (name) => `/bin/${name}`,
      run: (command) => {
        calls.push(command);
        return { exitCode: 0, stdout: "configured", stderr: "" };
      },
    });
    expect(result.claude).toBe("unchanged");
    expect(result.codex).toBe("unchanged");
    expect(calls.filter((command) => command.includes("add"))).toHaveLength(0);
  });
});

describe("network commands", () => {
  test("init keeps the worktree clean and can skip optional setup", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lineage-init-"));
    tempDirs.push(repo);
    let command = Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    expect(command.exitCode).toBe(0);
    command = Bun.spawnSync([
      "git", "remote", "add", "origin", "git@github.com:example/demo.git",
    ], { cwd: repo });
    expect(command.exitCode).toBe(0);
    const result = await initCommand.run(["--no-mcp", "--no-index"], {
      cwd: repo,
      json: true,
    }) as {
      repoId: string;
      worktreeChanged: boolean;
      mcp: { claude: string; codex: string; errors: string[] };
      index: { status: string };
    };
    expect(result.repoId).toMatch(/^repo-[a-f0-9]{32}$/);
    expect(result.worktreeChanged).toBeFalse();
    expect(result.mcp).toEqual({ claude: "skipped", codex: "skipped", errors: [] });
    expect(result.index.status).toBe("skipped");
    expect(await Bun.file(join(repo, ".git", "lineage", "repo.json")).exists()).toBeTrue();
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo });
    expect(new TextDecoder().decode(status.stdout)).toBe("");
  });

  test("init registers MCP clients and indexes existing sessions by default", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lineage-init-default-"));
    tempDirs.push(repo);
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    expect(Bun.spawnSync([
      "git", "remote", "add", "origin", "https://github.com/example/demo.git",
    ], { cwd: repo }).exitCode).toBe(0);
    let registeredCwd = "";
    let indexed = false;
    const command = createInitCommand({
      registerMcp: async (options) => {
        registeredCwd = options.cwd;
        return { claude: "registered", codex: "unchanged", errors: [] };
      },
      refreshIndex: async () => {
        indexed = true;
        return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
      },
    });
    const result = await command.run([], { cwd: repo, json: true }) as {
      mcp: { claude: string; codex: string };
      index: { status: string; entries: number };
    };
    expect(registeredCwd.replaceAll("\\", "/")).toBe(realpathSync(repo).replaceAll("\\", "/"));
    expect(indexed).toBeTrue();
    expect(result.mcp).toMatchObject({ claude: "registered", codex: "unchanged" });
    expect(result.index).toEqual({ status: "indexed", entries: 0 });
  });

  test("join validates and stores connection settings", async () => {
    const repo = await makeTempRepo();
    expect(Bun.spawnSync(["git", "config", "user.name", "Alice"], { cwd: repo }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "config", "user.email", "alice@example.com"], { cwd: repo }).exitCode).toBe(0);
    const output = await joinCommand.run(
      ["--relay", "https://demo.trycloudflare.com", "--token", TOKEN, "--user", "alice", "--provider", "claude"],
      { cwd: repo, json: false },
    );
    expect(String(output)).toContain("Joined room repo-1 as alice");
    const settings = await readNetworkSettings(join(repo, ".git", "lineage"));
    expect(settings).toEqual({
      relayUrl: "wss://demo.trycloudflare.com",
      roomToken: TOKEN,
      userId: "alice",
      provider: "claude",
      gitIdentities: [{ name: "Alice", email: "alice@example.com" }],
    });
  });

  test("join uses machine login identity and remembers room credentials", async () => {
    const repo = await makeTempRepo();
    const userStateDir = mkdtempSync(join(tmpdir(), "lineage-user-"));
    tempDirs.push(userStateDir);
    await writeAuthSettings(userStateDir, {
      domain: "tenant.example.com",
      clientId: "client-1",
      audience: "https://lineage.example/api",
      accessToken: "header.payload.signature",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      identity: "lorena@example.com",
    });
    const joinWithLogin = createJoinCommand(userStateDir);

    await joinWithLogin.run(
      ["--relay", "ws://192.168.1.10:8787"],
      { cwd: repo, json: true },
    );
    const repeated = await joinWithLogin.run(
      ["--provider", "claude"],
      { cwd: repo, json: true },
    ) as { userId: string; relayUrl: string };

    expect(repeated.userId).toBe("lorena@example.com");
    expect(repeated.relayUrl).toBe("ws://192.168.1.10:8787");
  });

  test("host approval persists verified members and auto-approves the host", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lineage-members-"));
    tempDirs.push(stateDir);
    const prompts: string[] = [];
    const authorize = await createHostMembershipAuthorizer({
      repoId: "repo-1",
      stateDir,
      hostIdentity: "dawang@example.com",
      prompt: async (question) => {
        prompts.push(question);
        return "yes";
      },
      print: () => {},
    });

    expect(await authorize({ repoId: "repo-1", actor: { userId: "dawang@example.com" } })).toBeTrue();
    expect(await authorize({ repoId: "repo-1", actor: { userId: "lorena@example.com" } })).toBeTrue();
    expect(await authorize({ repoId: "repo-1", actor: { userId: "lorena@example.com" } })).toBeTrue();
    expect(await authorize({ repoId: "other-repo", actor: { userId: "mallory@example.com" } })).toBeFalse();
    expect(prompts).toHaveLength(1);
    expect((await readMembershipSettings(stateDir)).members.map((member) => member.identity)).toEqual([
      "dawang@example.com",
      "lorena@example.com",
    ]);

    const repo = await makeTempRepo();
    await Bun.write(
      join(repo, ".git", "lineage", "members.json"),
      JSON.stringify(await readMembershipSettings(stateDir)),
    );
    await membersCommand.run(["revoke", "lorena@example.com"], { cwd: repo, json: true });
    expect((await readMembershipSettings(join(repo, ".git", "lineage"))).members).toHaveLength(1);
  });

  test("adds Git identity aliases without requiring another join", async () => {
    const repo = await makeTempRepo();
    expect(Bun.spawnSync(["git", "config", "user.name", "Alice"], { cwd: repo }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "config", "user.email", "alice@example.com"], { cwd: repo }).exitCode).toBe(0);
    await joinCommand.run(
      ["--relay", "ws://localhost:8787", "--token", TOKEN, "--user", "alice"],
      { cwd: repo, json: true },
    );
    const listed = await identityCommand.run(["list"], { cwd: repo, json: true }) as {
      gitIdentities: Array<{ name: string; email: string }>;
    };
    expect(listed.gitIdentities).toEqual([
      { name: "Alice", email: "alice@example.com" },
    ]);
    expect(Bun.spawnSync(["git", "config", "user.name", "Alice New"], { cwd: repo }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "config", "user.email", "alice.new@example.com"], { cwd: repo }).exitCode).toBe(0);
    const result = await identityCommand.run(
      ["add", "Alice Work <alice@work.example>"],
      { cwd: repo, json: true },
    ) as { gitIdentities: Array<{ name: string; email: string }> };
    expect(result.gitIdentities).toEqual([
      { name: "Alice New", email: "alice.new@example.com" },
      { name: "Alice", email: "alice@example.com" },
      { name: "Alice Work", email: "alice@work.example" },
    ]);
  });

  test("ask fails helpfully when the daemon is not running", async () => {
    const repo = await makeTempRepo();
    const error = await askCommand
      .run(["bob", "why?"], { cwd: repo, json: false })
      .then(() => undefined)
      .catch((failure: unknown) => failure);
    expect((error as Error).message).toContain("daemon is not running");
  });

  test("ask, inbox, and reply flow between two live daemons", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const repoA = await makeTempRepo();
    const repoB = await makeTempRepo();
    await startRepoDaemon(repoA, "alice");
    const bob = await startRepoDaemon(repoB, "bob", {
      io: new ScriptedIo(["m", "Cookies survive XSS."]),
    });

    const output = await askCommand.run(["bob", "Why", "cookies?"], {
      cwd: repoA,
      json: false,
    });
    expect(String(output)).toContain("bob answered (manual)");
    expect(String(output)).toContain("Cookies survive XSS.");

    await bob.handle.approvals.idle();
    const inboxText = await inboxCommand.run([], { cwd: repoB, json: false });
    expect(String(inboxText)).toContain("[answered]");
    expect(String(inboxText)).toContain("Why cookies?");

    const replyError = await replyCommand
      .run(["missing-id", "text"], { cwd: repoB, json: false })
      .then(() => undefined)
      .catch((failure: unknown) => failure);
    expect((replyError as Error).message).toContain("Unknown requestId");
  });

  test("announce records locally and broadcasts to teammates", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const repoA = await makeTempRepo();
    const repoB = await makeTempRepo();
    await startRepoDaemon(repoA, "alice");
    const bob = await startRepoDaemon(repoB, "bob");

    const result = (await announceCommand.run(
      [
        "--summary",
        "Implement token refresh",
        "--user",
        "alice",
        "--assume",
        "auth.token_storage=httpOnly-cookie",
      ],
      { cwd: repoA, json: true },
    )) as { broadcast: boolean; intent: { summary: string } };
    expect(result.broadcast).toBeTrue();
    expect(result.intent.summary).toBe("Implement token refresh");

    await until(() => bob.core.calls.some((call) => call.method === "ingestRemoteIntent"));
    const ingest = bob.core.calls.find((call) => call.method === "ingestRemoteIntent");
    expect((ingest!.input as { summary: string }).summary).toBe("Implement token refresh");
  });
});

describe("run wrapper", () => {
  test("does not write daemon presence events into the active agent terminal", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const repo = await makeTempRepo();
    await joinCommand.run(
      ["--relay", relay.url, "--token", TOKEN, "--user", "alice", "--provider", "codex"],
      { cwd: repo, json: true },
    );
    const script = join(repo, "fake-agent.ts");
    await Bun.write(script, "await Bun.sleep(400);\n");
    const claudeRoot = mkdtempSync(join(tmpdir(), "lineage-silent-claude-"));
    const codexRoot = mkdtempSync(join(tmpdir(), "lineage-silent-codex-"));
    tempDirs.push(claudeRoot, codexRoot);
    const printed: string[] = [];
    const running = runAgent({
      cwd: repo,
      provider: "codex",
      print: (line) => printed.push(line),
      agentCommand: ["bun", script],
      indexOptions: {
        indexPath: join(repo, ".git", "lineage", "silent-index.json"),
        claudeRoot,
        codexRoot,
      },
    });
    await until(() => existsSync(join(repo, ".git", "lineage", "daemon.json")));
    await startRepoDaemon(await makeTempRepo(), "bob");
    await Bun.sleep(50);
    await running;

    expect(printed.some((line) => line.includes("bob is online"))).toBeFalse();
    expect(printed).toContain("Lineage messaging is online in this session.");
  });

  test("propagates lineage env to the agent and captures the transcript", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const repo = await makeTempRepo();
    expect(Bun.spawnSync(["git", "config", "user.name", "Alice"], { cwd: repo }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "config", "user.email", "alice@example.com"], { cwd: repo }).exitCode).toBe(0);
    await startRepoDaemon(repo, "alice");

    const outFile = join(repo, "agent-env.json");
    const claudeRoot = mkdtempSync(join(tmpdir(), "lineage-claude-"));
    const codexRoot = mkdtempSync(join(tmpdir(), "lineage-codex-"));
    tempDirs.push(claudeRoot, codexRoot);
    const indexPath = join(repo, ".git", "lineage", "test-index.json");
    const agentScript = join(repo, "fake-agent.ts");
    await Bun.write(
      agentScript,
      [
        "const transcript = `${process.argv[3]}/live.jsonl`;",
        `await Bun.write(transcript, JSON.stringify({ type: "user", sessionId: "claude-session", cwd: ${JSON.stringify(repo)}, timestamp: new Date().toISOString(), message: { content: "demo prompt" } }) + "\\n");`,
        "await Bun.write(process.argv[2], JSON.stringify({",
        "  session: process.env.LINEAGE_SESSION_ID,",
        "  user: process.env.LINEAGE_USER_ID,",
        "  provider: process.env.LINEAGE_PROVIDER,",
        "  channel: process.env.LINEAGE_CHANNEL,",
        "  gitIdentities: JSON.parse(process.env.LINEAGE_GIT_IDENTITIES || '[]'),",
        "}));",
      ].join("\n"),
    );

    const result = await runAgent({
      cwd: repo,
      provider: "claude",
      userId: "alice",
      channel: true,
      print: () => {},
      agentCommand: ["bun", agentScript, outFile, claudeRoot],
      indexOptions: { indexPath, claudeRoot, codexRoot },
    });
    expect(result.exitCode).toBe(0);

    const agentEnv = await Bun.file(outFile).json();
    expect(agentEnv.session).toBe(result.sessionId);
    expect(agentEnv.user).toBe("alice");
    expect(agentEnv.provider).toBe("claude");
    expect(agentEnv.channel).toBe("1");
    expect(agentEnv.gitIdentities).toEqual([
      { name: "Alice", email: "alice@example.com" },
    ]);

    const index = await loadPromptIndex(indexPath);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]!.sessionId).toBe("claude-session");
    expect(JSON.stringify(index)).not.toContain("demo prompt");
  });
});

describe("login command", () => {
  function fakeJwt(claims: Record<string, unknown>): string {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
  }

  test("walks the device flow and stores the verified identity", async () => {
    const repo = await makeTempRepo();
    const accessToken = fakeJwt({ sub: "auth0|7", email: "loren@example.com" });
    let polls = 0;
    const auth0 = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/oauth/device/code") {
          return Response.json({
            device_code: "device-123",
            user_code: "ABCD-EFGH",
            verification_uri: "https://issuer.test/activate",
            expires_in: 300,
            interval: 1,
          });
        }
        if (url.pathname === "/oauth/token") {
          polls += 1;
          if (polls === 1) {
            return Response.json({ error: "authorization_pending" }, { status: 403 });
          }
          return Response.json({
            access_token: accessToken,
            refresh_token: "refresh-1",
            expires_in: 3600,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const printed: string[] = [];
      const userStateDir = mkdtempSync(join(tmpdir(), "lineage-user-"));
      tempDirs.push(userStateDir);
      const login = createLoginCommand({
        sleep: async () => {},
        print: (line) => printed.push(line),
        userStateDir,
      });
      const result = await login.run(
        [
          "--domain", `http://127.0.0.1:${auth0.port}`,
          "--client-id", "client-1",
          "--audience", "https://lineage.example/api",
        ],
        { cwd: repo, json: true },
      );
      expect(result).toEqual({
        identity: "loren@example.com",
        expiresAt: expect.any(String),
      });
      expect(printed.join("\n")).toContain("ABCD-EFGH");

      const stored = await readAuthSettings(userStateDir);
      expect(stored!.accessToken).toBe(accessToken);
      expect(stored!.identity).toBe("loren@example.com");

      // Re-login reuses the stored tenant settings without flags.
      const again = await login.run([], { cwd: repo, json: true });
      expect(again).toEqual({
        identity: "loren@example.com",
        expiresAt: expect.any(String),
      });

      await createLogoutCommand(userStateDir).run([], { cwd: repo, json: true });
      expect(await readAuthSettings(userStateDir)).toBeUndefined();
    } finally {
      auth0.stop(true);
    }
  });

  test("explains what to do when tenant settings are missing", async () => {
    const repo = await makeTempRepo();
    const saved = {
      domain: process.env["LINEAGE_AUTH0_DOMAIN"],
      clientId: process.env["LINEAGE_AUTH0_CLIENT_ID"],
      audience: process.env["LINEAGE_AUTH0_AUDIENCE"],
    };
    delete process.env["LINEAGE_AUTH0_DOMAIN"];
    delete process.env["LINEAGE_AUTH0_CLIENT_ID"];
    delete process.env["LINEAGE_AUTH0_AUDIENCE"];
    try {
      const userStateDir = mkdtempSync(join(tmpdir(), "lineage-user-"));
      tempDirs.push(userStateDir);
      const login = createLoginCommand({ print: () => {}, userStateDir });
      const error = await login
        .run([], { cwd: repo, json: false })
        .then(() => undefined)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("LINEAGE_AUTH0_DOMAIN");
    } finally {
      if (saved.domain !== undefined) process.env["LINEAGE_AUTH0_DOMAIN"] = saved.domain;
      if (saved.clientId !== undefined) process.env["LINEAGE_AUTH0_CLIENT_ID"] = saved.clientId;
      if (saved.audience !== undefined) process.env["LINEAGE_AUTH0_AUDIENCE"] = saved.audience;
    }
  });
});
