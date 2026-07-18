import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntentConflict, Provider } from "@lineage/contracts";
import { MockLineageCore, fixtureIntent } from "@lineage/contracts/testing";
import { startRelay, type RelayHandle } from "@lineage/relay";
import { TransportError } from "@lineage/transport";
import { DaemonClient } from "./client";
import { startDaemon, type DaemonHandle } from "./daemon";
import type { ApprovalIo } from "./approval";
import type { AgentAnswerer } from "./agent-answerer";
import { DAEMON_SECRET_HEADER } from "./http";

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

interface TestDaemon {
  handle: DaemonHandle;
  client: DaemonClient;
  core: MockLineageCore;
  io: ScriptedIo;
}

async function startTestDaemon(
  userId: string,
  provider: Provider,
  options: { io?: ScriptedIo; core?: MockLineageCore; answerer?: AgentAnswerer } = {},
): Promise<TestDaemon> {
  const stateDir = mkdtempSync(join(tmpdir(), `lineage-daemon-${userId}-`));
  tempDirs.push(stateDir);
  const io = options.io ?? new ScriptedIo();
  const core = options.core ?? new MockLineageCore();
  const handle = await startDaemon({
    cwd: stateDir,
    io,
    stateDir,
    repoId: "repo-1",
    network: { relayUrl: relay!.url, roomToken: TOKEN, userId, provider },
    openRuntime: async () => ({ core, close: () => {} }),
    answerer: options.answerer ?? (async () => {}),
  });
  daemons.push(handle);
  return { handle, client: DaemonClient.forPort(handle.port, handle.secret), core, io };
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await Bun.sleep(25);
  }
}

const conflictFixture: IntentConflict = {
  type: "assumption_mismatch",
  key: "auth.token_storage",
  left: {
    intentId: "intent-1",
    author: { userId: "alice", provider: "claude" },
    value: "httpOnly-cookie",
  },
  right: {
    intentId: "intent-2",
    author: { userId: "bob", provider: "codex" },
    value: "localStorage",
  },
  detectedAt: new Date().toISOString(),
};

describe("daemon", () => {
  test("manual approval answers the asking daemon", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await startTestDaemon("alice", "claude");
    const bob = await startTestDaemon("bob", "codex", {
      io: new ScriptedIo(["m", "Because rotation limits replay."]),
    });

    const answer = await alice.client.ask({
      recipient: "bob",
      text: "Why rotate refresh tokens?",
    });
    expect(answer.mode).toBe("manual");
    expect(answer.text).toBe("Because rotation limits replay.");

    await bob.handle.approvals.idle();
    const entries = await bob.client.inbox();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("answered");
  });

  test("rejection surfaces as request_rejected for the asker", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await startTestDaemon("alice", "claude");
    await startTestDaemon("bob", "codex", {
      io: new ScriptedIo(["r", "Busy with a deploy"]),
    });

    const error = await alice.client
      .ask({ recipient: "bob", text: "Got a minute?" })
      .then(() => undefined)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("request_rejected");
    expect((error as TransportError).message).toBe("Busy with a deploy");
  });

  test("agent approval routes the answer through /reply with mode agent", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await startTestDaemon("alice", "claude");

    // Stand-in for the headless sub-agent: it "reads" the rendered request
    // and replies through the daemon HTTP API exactly like the MCP tool does.
    let bobClient: DaemonClient | undefined;
    const answerer: AgentAnswerer = async ({ request }) => {
      await bobClient!.reply({
        requestId: request.requestId,
        text: `Answering "${request.question.text}" from history.`,
        evidence: [{ kind: "commit", value: "abcdef1234567890" }],
      });
    };
    const bob = await startTestDaemon("bob", "codex", {
      io: new ScriptedIo(["a"]),
      answerer,
    });
    bobClient = bob.client;

    const answer = await alice.client.ask({
      recipient: "bob",
      text: "Why the cookie approach?",
    });
    expect(answer.mode).toBe("agent");
    expect(answer.text).toContain("Why the cookie approach?");
    expect(answer.evidence).toHaveLength(1);
    const entries = await bob.client.inbox();
    expect(entries[0]!.status).toBe("answered");
  });

  test("remote intents are ingested and conflicts printed", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await startTestDaemon("alice", "claude");
    const bobCore = new MockLineageCore();
    bobCore.conflicts = [conflictFixture];
    const bob = await startTestDaemon("bob", "codex", { core: bobCore });

    const intent = fixtureIntent({
      author: { userId: "alice", provider: "claude" },
      repoId: "repo-1",
    });
    await alice.client.publishIntent(intent);

    await until(() =>
      bobCore.calls.some((call) => call.method === "ingestRemoteIntent"),
    );
    await until(() =>
      bob.io.printed.some((line) => line.includes("ASSUMPTION CONFLICT")),
    );
    const call = bobCore.calls.find((entry) => entry.method === "ingestRemoteIntent");
    expect(call!.input).toEqual(intent);
    // Alice's own broadcast must not be re-ingested by herself.
    expect(
      alice.core.calls.filter((entry) => entry.method === "ingestRemoteIntent"),
    ).toHaveLength(0);
  });

  test("session events reach the core through the HTTP API", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await startTestDaemon("alice", "claude");
    await alice.client.sessionEvent({
      id: crypto.randomUUID(),
      sessionId: "session-1",
      provider: "claude",
      kind: "user_prompt",
      content: "add refresh token rotation",
      createdAt: new Date().toISOString(),
    });
    const call = alice.core.calls.find((entry) => entry.method === "appendSessionEvent");
    expect(call).toBeDefined();
  });

  test("requests without the daemon secret are refused", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await startTestDaemon("alice", "claude");
    const response = await fetch(`http://127.0.0.1:${alice.handle.port}/status`);
    expect(response.status).toBe(401);
    const withSecret = await fetch(`http://127.0.0.1:${alice.handle.port}/status`, {
      headers: { [DAEMON_SECRET_HEADER]: alice.handle.secret },
    });
    expect(withSecret.status).toBe(200);
  });
});
