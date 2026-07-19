import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINEAGE_PROVIDER_ENV,
  LINEAGE_SESSION_ID_ENV,
  LINEAGE_USER_ID_ENV,
  MCP_TOOL_NAMES,
} from "@lineage/contracts";
import { MockLineageCore } from "@lineage/contracts/testing";
import { DaemonClient, startDaemon, type ApprovalIo, type DaemonHandle } from "@lineage/daemon";
import { startRelay, type RelayHandle } from "@lineage/relay";
import { FakeMcpClient } from "../test/fake-client";

const SERVER_PATH = join(import.meta.dir, "index.ts");
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
const clients: FakeMcpClient[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const client of clients) await client.close();
  clients.length = 0;
  for (const daemon of daemons) await daemon.stop();
  daemons.length = 0;
  relay?.stop();
  relay = undefined;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "lineage-mcp-"));
  tempDirs.push(dir);
  const git = Bun.spawn(["git", "init", "-q"], { cwd: dir });
  if ((await git.exited) !== 0) throw new Error("git init failed");
  mkdirSync(join(dir, ".git", "lineage"), { recursive: true });
  await Bun.write(
    join(dir, ".git", "lineage", "repo.json"),
    JSON.stringify({ protocolVersion: 1, repoId: "repo-1" }, null, 2),
  );
  await Bun.write(join(dir, "README.md"), "# Test repository\n");
  for (const args of [
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test User"],
    ["add", "README.md"],
    ["commit", "-qm", "Initialize repository"],
  ]) {
    const command = Bun.spawn(["git", ...args], { cwd: dir });
    if ((await command.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  }
  return dir;
}

async function makeClient(cwd: string, env: Record<string, string> = {}): Promise<FakeMcpClient> {
  const client = new FakeMcpClient(SERVER_PATH, { cwd, env });
  clients.push(client);
  await client.initialize();
  return client;
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await Bun.sleep(50);
  }
}

describe("mcp server", () => {
  test("lists exactly the shared lineage tool names", async () => {
    const repo = await makeTempRepo();
    const client = await makeClient(repo);
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      Object.values(MCP_TOOL_NAMES).sort(),
    );
  });

  test("lineage_why queries the real runtime and lineage_announce records an intent", async () => {
    const repo = await makeTempRepo();
    const client = await makeClient(repo, {
      [LINEAGE_USER_ID_ENV]: "alice",
      [LINEAGE_PROVIDER_ENV]: "claude",
      [LINEAGE_SESSION_ID_ENV]: "session-1",
    });

    const why = await client.callTool(MCP_TOOL_NAMES.why, { path: "src/auth.ts" });
    expect(why.isError).toBeFalse();
    expect(JSON.parse(why.text).matches).toEqual([]);

    const announce = await client.callTool(MCP_TOOL_NAMES.announce, {
      summary: "Implement token refresh",
      files: ["src/auth.ts"],
      assumptions: [{ key: "auth.token_storage", value: "httpOnly-cookie" }],
    });
    expect(announce.isError).toBeFalse();
    expect(announce.text).toContain("daemon is not running");
    const body = JSON.parse(announce.text.split("\n\n")[0]!);
    expect(body.intent.summary).toBe("Implement token refresh");
    expect(body.conflicts).toEqual([]);

    const decision = await client.callTool(MCP_TOOL_NAMES.recordDecision, {
      commitSha: "HEAD",
      summary: "Store auth in an HttpOnly cookie",
      rationale: "Server-rendered requests need access without exposing the token to browser JavaScript.",
      files: ["src/auth.ts"],
    });
    expect(decision.isError).toBeFalse();
    expect(JSON.parse(decision.text).summary).toContain("HttpOnly cookie");

    const explained = await client.callTool(MCP_TOOL_NAMES.why, { path: "src/auth.ts" });
    expect(JSON.parse(explained.text).matches).toHaveLength(1);

    // The announced intent is now queryable through the timeline tool.
    const timeline = await client.callTool(MCP_TOOL_NAMES.timeline, {});
    expect(timeline.isError).toBeFalse();
    expect(JSON.parse(timeline.text).entries).toHaveLength(2);
  });

  test("bad input surfaces as a tool error, not a crash", async () => {
    const repo = await makeTempRepo();
    const client = await makeClient(repo);
    const result = await client.callTool(MCP_TOOL_NAMES.why, {});
    expect(result.isError).toBeTrue();
    expect(result.text).toContain("Error:");
  });

  test("an approved question is answered end-to-end through lineage_reply", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const repo = await makeTempRepo();

    // Bob's daemon lives in the repo the MCP server will run in.
    const bob = await startDaemon({
      cwd: repo,
      io: new ScriptedIo(["a"]),
      stateDir: join(repo, ".git", "lineage"),
      repoId: "repo-1",
      network: { relayUrl: relay.url, roomToken: TOKEN, userId: "bob", provider: "codex" },
      openRuntime: async () => ({ core: new MockLineageCore(), close: () => {} }),
      answerer: async () => {}, // the MCP client below plays the sub-agent
    });
    daemons.push(bob);

    const aliceState = mkdtempSync(join(tmpdir(), "lineage-alice-"));
    tempDirs.push(aliceState);
    const alice = await startDaemon({
      cwd: aliceState,
      io: new ScriptedIo(),
      stateDir: aliceState,
      repoId: "repo-1",
      network: { relayUrl: relay.url, roomToken: TOKEN, userId: "alice", provider: "claude" },
      openRuntime: async () => ({ core: new MockLineageCore(), close: () => {} }),
      answerer: async () => {},
    });
    daemons.push(alice);

    const { DaemonClient } = await import("@lineage/daemon");
    const askerClient = DaemonClient.forPort(alice.port, alice.secret);
    const pendingAnswer = askerClient.ask({
      recipient: "bob",
      text: "Why the cookie approach?",
    });
    await until(() => bob.inbox.open().some((entry) => entry.status === "approved_agent"));
    const requestId = bob.inbox.open()[0]!.requestId;

    // The headless sub-agent: an MCP client in bob's repo.
    const subAgent = await makeClient(repo, { [LINEAGE_USER_ID_ENV]: "bob" });
    const inboxResult = await subAgent.callTool(MCP_TOOL_NAMES.inbox);
    expect(inboxResult.text).toContain(requestId);
    expect(inboxResult.text).toContain("Why the cookie approach?");

    const replyResult = await subAgent.callTool(MCP_TOOL_NAMES.reply, {
      requestId,
      text: "HttpOnly cookies survive XSS.",
      evidence: [{ kind: "file", value: "src/auth.ts" }],
    });
    expect(replyResult.isError).toBeFalse();

    const answer = await pendingAnswer;
    expect(answer.mode).toBe("agent");
    expect(answer.text).toBe("HttpOnly cookies survive XSS.");
    expect(answer.requestId).toBe(requestId);
  });

  test("pushes a pending question into Claude and handles it in the active session", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const repo = await makeTempRepo();
    const bob = await startDaemon({
      cwd: repo,
      io: new ScriptedIo(),
      approvalMode: "external",
      stateDir: join(repo, ".git", "lineage"),
      repoId: "repo-1",
      network: { relayUrl: relay.url, roomToken: TOKEN, userId: "bob", provider: "claude" },
      openRuntime: async () => ({ core: new MockLineageCore(), close: () => {} }),
      resolvePrompt: async () => "Implement cookie auth for SSR",
    });
    daemons.push(bob);

    const aliceState = mkdtempSync(join(tmpdir(), "lineage-alice-channel-"));
    tempDirs.push(aliceState);
    const alice = await startDaemon({
      cwd: aliceState,
      io: new ScriptedIo(),
      stateDir: aliceState,
      repoId: "repo-1",
      network: { relayUrl: relay.url, roomToken: TOKEN, userId: "alice", provider: "codex" },
      openRuntime: async () => ({ core: new MockLineageCore(), close: () => {} }),
    });
    daemons.push(alice);

    const activeClaude = await makeClient(repo, {
      [LINEAGE_USER_ID_ENV]: "bob",
      [LINEAGE_PROVIDER_ENV]: "claude",
    });
    const asking = DaemonClient.forPort(alice.port, alice.secret).ask({
      recipient: "bob",
      text: "Why cookies?",
    });
    await until(() =>
      activeClaude.notifications.some(
        (notification) => notification.method === "notifications/claude/channel",
      ),
    );
    const requestId = bob.inbox.open()[0]!.requestId;
    const dispatched = await activeClaude.callTool(MCP_TOOL_NAMES.respond, {
      requestId,
      action: "dispatch",
    });
    expect(dispatched.text).toContain("Implement cookie auth for SSR");
    await activeClaude.callTool(MCP_TOOL_NAMES.reply, {
      requestId,
      text: "Cookies are readable during server rendering.",
    });
    expect((await asking).text).toBe("Cookies are readable during server rendering.");
  });
});
