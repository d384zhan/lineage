import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@lineage/contracts";
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
import { parseClaudeTranscriptLine, startTranscriptTailer } from "./transcript-tail";

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

describe("transcript parsing", () => {
  test("maps user and assistant entries and skips noise", () => {
    expect(
      parseClaudeTranscriptLine(
        JSON.stringify({ type: "user", message: { role: "user", content: "add rotation" } }),
      ),
    ).toEqual({ kind: "user_prompt", content: "add rotation" });
    expect(
      parseClaudeTranscriptLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Done." }, { type: "tool_use", name: "x" }] },
        }),
      ),
    ).toEqual({ kind: "assistant_output", content: "Done." });
    // Tool results, meta lines, summaries, and garbage are skipped.
    expect(
      parseClaudeTranscriptLine(
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", content: "output" }] },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseClaudeTranscriptLine(
        JSON.stringify({ type: "user", isMeta: true, message: { content: "meta" } }),
      ),
    ).toBeUndefined();
    expect(parseClaudeTranscriptLine(JSON.stringify({ type: "summary" }))).toBeUndefined();
    expect(parseClaudeTranscriptLine("not json")).toBeUndefined();
  });

  test("tailer emits events as the transcript grows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-tail-"));
    tempDirs.push(dir);
    const transcript = join(dir, "session.jsonl");
    const events: SessionEvent[] = [];
    const tailer = startTranscriptTailer({
      transcriptDir: dir,
      since: Date.now() - 1_000,
      sessionId: "session-1",
      provider: "claude",
      emit: async (event) => {
        events.push(event);
      },
      pollMs: 25,
    });
    await Bun.write(
      transcript,
      `${JSON.stringify({ type: "user", message: { content: "first prompt" } })}\n`,
    );
    await until(() => events.length === 1);
    await Bun.write(
      transcript,
      `${JSON.stringify({ type: "user", message: { content: "first prompt" } })}\n${JSON.stringify(
        { type: "assistant", message: { content: [{ type: "text", text: "reply" }] } },
      )}\n`,
    );
    await until(() => events.length === 2);
    await tailer.stop();
    expect(events[0]!.kind).toBe("user_prompt");
    expect(events[0]!.content).toBe("first prompt");
    expect(events[1]!.kind).toBe("assistant_output");
    expect(events[1]!.sessionId).toBe("session-1");
  });
});

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
    const alice = await startRepoDaemon(repo, "alice");

    const outFile = join(repo, "agent-env.json");
    const transcriptDir = mkdtempSync(join(tmpdir(), "lineage-transcript-"));
    tempDirs.push(transcriptDir);
    const agentScript = join(repo, "fake-agent.ts");
    await Bun.write(
      agentScript,
      [
        "const transcript = `${process.argv[3]}/live.jsonl`;",
        "await Bun.write(transcript, `${JSON.stringify({ type: \"user\", message: { content: \"demo prompt\" } })}\\n`);",
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
      agentCommand: ["bun", agentScript, outFile, transcriptDir],
      transcriptDir,
    });
    expect(result.exitCode).toBe(0);

    const agentEnv = await Bun.file(outFile).json();
    expect(agentEnv.session).toBe(result.sessionId);
    expect(agentEnv.user).toBe("alice");
    expect(agentEnv.provider).toBe("claude");

    // .mcp.json was registered for Claude Code.
    expect(await Bun.file(join(repo, ".mcp.json")).exists()).toBeTrue();

    // Session events reached the daemon: start marker + transcript prompt.
    const kinds = alice.core.calls
      .filter((call) => call.method === "appendSessionEvent")
      .map((call) => (call.input as SessionEvent).kind);
    expect(kinds).toContain("user_prompt");
    const contents = alice.core.calls
      .filter((call) => call.method === "appendSessionEvent")
      .map((call) => (call.input as SessionEvent).content);
    expect(contents.some((content) => content.includes("demo prompt"))).toBeTrue();
  });
});
