import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLineageCore } from "@lineage/contracts/testing";
import {
  readNetworkSettings,
  startDaemon,
  type ApprovalIo,
  type DaemonHandle,
} from "@lineage/daemon";
import { startRelay, type RelayHandle } from "@lineage/relay";
import { announceCommand, askCommand, inboxCommand, joinCommand, replyCommand } from "./commands";
import { ensureClaudeMcpConfig } from "./mcp-register";
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
  mkdirSync(join(dir, ".lineage"), { recursive: true });
  await Bun.write(
    join(dir, ".lineage", "repo.json"),
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
  test("writes, preserves, and does not duplicate .mcp.json entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-mcpjson-"));
    tempDirs.push(dir);
    await Bun.write(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );
    expect(await ensureClaudeMcpConfig(dir, join(dir, "server.ts"))).toBe("updated");
    expect(await ensureClaudeMcpConfig(dir, join(dir, "server.ts"))).toBe("unchanged");
    const config = await Bun.file(join(dir, ".mcp.json")).json();
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.lineage.command).toBe("bun");
    expect(config.mcpServers.lineage.args).toEqual(["server.ts"]);
  });
});

describe("network commands", () => {
  test("join validates and stores connection settings", async () => {
    const repo = await makeTempRepo();
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
    });
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
  test("propagates lineage env to the agent and captures the transcript", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const repo = await makeTempRepo();
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
        "}));",
      ].join("\n"),
    );

    const result = await runAgent({
      cwd: repo,
      provider: "claude",
      userId: "alice",
      print: () => {},
      agentCommand: ["bun", agentScript, outFile, claudeRoot],
      indexOptions: { indexPath, claudeRoot, codexRoot },
    });
    expect(result.exitCode).toBe(0);

    const agentEnv = await Bun.file(outFile).json();
    expect(agentEnv.session).toBe(result.sessionId);
    expect(agentEnv.user).toBe("alice");
    expect(agentEnv.provider).toBe("claude");

    // .mcp.json was registered for Claude Code.
    expect(await Bun.file(join(repo, ".mcp.json")).exists()).toBeTrue();

    const index = await loadPromptIndex(indexPath);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]!.sessionId).toBe("claude-session");
    expect(JSON.stringify(index)).not.toContain("demo prompt");
  });
});
