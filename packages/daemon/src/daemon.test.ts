import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntentConflict, Provider } from "@lineage/contracts";
import { MockLineageCore, fixtureIntent } from "@lineage/contracts/testing";
import { createFakeIssuer, startRelay, type RelayHandle } from "@lineage/relay";
import { TransportError } from "@lineage/transport";
import { DaemonClient } from "./client";
import { startDaemon, type DaemonHandle, type PromptResolver } from "./daemon";
import type { ApprovalIo } from "./approval";
import type { AgentAnswerer } from "./agent-answerer";
import type { RefreshIndexOptions } from "@lineage/prompt-index";
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
  options: {
    io?: ScriptedIo;
    core?: MockLineageCore;
    answerer?: AgentAnswerer;
    resolvePrompt?: PromptResolver;
    contextResolver?: (prompt: string) => Promise<string[]>;
    cwd?: string;
    promptIndexOptions?: RefreshIndexOptions;
    approvalMode?: "terminal" | "external";
  } = {},
): Promise<TestDaemon> {
  const stateDir = mkdtempSync(join(tmpdir(), `lineage-daemon-${userId}-`));
  tempDirs.push(stateDir);
  const io = options.io ?? new ScriptedIo();
  const core = options.core ?? new MockLineageCore();
  const handle = await startDaemon({
    cwd: options.cwd ?? stateDir,
    io,
    stateDir,
    repoId: "repo-1",
    network: { relayUrl: relay!.url, roomToken: TOKEN, userId, provider },
    openRuntime: async () => ({ core, close: () => {} }),
    answerer: options.answerer ?? (async () => {}),
    ...(options.resolvePrompt ? { resolvePrompt: options.resolvePrompt } : {}),
    ...(options.contextResolver ? { contextResolver: options.contextResolver } : {}),
    ...(options.promptIndexOptions ? { promptIndexOptions: options.promptIndexOptions } : {}),
    ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
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

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
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
      expect(request.quotedPrompt).toBe("implement cookie auth for server rendering");
      await bobClient!.reply({
        requestId: request.requestId,
        text: `Answering "${request.question.text}" from history.`,
        evidence: [{ kind: "commit", value: "abcdef1234567890" }],
      });
    };
    const bob = await startTestDaemon("bob", "codex", {
      io: new ScriptedIo(["a"]),
      answerer,
      resolvePrompt: async () => "implement cookie auth for server rendering",
    });
    bobClient = bob.client;

    const answer = await alice.client.ask({
      recipient: "bob",
      text: "Why the cookie approach?",
      evidence: [{ kind: "file", value: "src/auth.ts:42" }],
    });
    expect(answer.mode).toBe("agent");
    expect(answer.text).toContain("Why the cookie approach?");
    expect(answer.evidence).toHaveLength(1);
    expect(answer.quotedPrompt).toBe("implement cookie auth for server rendering");
    const entries = await bob.client.inbox();
    expect(entries[0]!.status).toBe("answered");
  });

  test("external dispatch returns approved context to the active agent", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await startTestDaemon("alice", "codex");
    const bob = await startTestDaemon("bob", "claude", {
      approvalMode: "external",
      resolvePrompt: async () => "Use cookies for server rendering",
      contextResolver: async (prompt) => [`<second-brain-context>${prompt}</second-brain-context>`],
    });

    const pending = alice.client.ask({
      recipient: "bob",
      text: "Why cookies?",
      evidence: [{ kind: "file", value: "src/auth.ts:1" }],
    });
    await until(() => bob.handle.inbox.open().length === 1);
    const requestId = bob.handle.inbox.open()[0]!.requestId;
    const dispatched = await bob.client.respond({ requestId, action: "dispatch" }) as {
      rendered: string;
    };
    expect(dispatched.rendered).toContain("Use cookies for server rendering");
    expect(dispatched.rendered).toContain('You are answering as Lineage user "bob"');
    expect(dispatched.rendered).toContain(
      "<second-brain-context>Why cookies?</second-brain-context>",
    );
    expect(bob.handle.inbox.get(requestId)?.status).toBe("approved_agent");

    await bob.client.reply({ requestId, text: "Cookies are available during SSR." });
    expect((await pending).text).toBe("Cookies are available during SSR.");
  });

  test("approved cross-agent answer resolves and returns the exact native-session prompt", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const repo = mkdtempSync(join(tmpdir(), "lineage-provenance-repo-"));
    const claudeRoot = mkdtempSync(join(tmpdir(), "lineage-provenance-claude-"));
    const codexRoot = mkdtempSync(join(tmpdir(), "lineage-provenance-codex-"));
    tempDirs.push(repo, claudeRoot, codexRoot);
    runGit(repo, ["init", "-q"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "Joe"]);
    mkdirSync(join(repo, ".git", "lineage"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    await Bun.write(join(repo, ".git", "lineage", "repo.json"), JSON.stringify({ protocolVersion: 1, repoId: "repo-1" }));
    const exactPrompt = "Use cookies because authentication must be readable during server rendering";
    await Bun.write(join(claudeRoot, "joe.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "joe-session", cwd: repo, timestamp: new Date().toISOString(), message: { content: exactPrompt } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: join(repo, "src", "auth.ts") } }] } }),
    ].join("\n") + "\n");
    await Bun.write(join(repo, "src", "auth.ts"), "export const authCookie = 'session';\n");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-qm", "Add server-side authentication"]);

    const alice = await startTestDaemon("alice", "codex", { cwd: repo });
    let bobClient: DaemonClient | undefined;
    const bob = await startTestDaemon("bob", "claude", {
      cwd: repo,
      io: new ScriptedIo(["a"]),
      promptIndexOptions: {
        indexPath: join(repo, ".git", "lineage", "test-global-index.json"),
        claudeRoot,
        codexRoot,
      },
      answerer: async ({ request }) => {
        expect(request.quotedPrompt).toBe(exactPrompt);
        expect(request.repositoryAuthorship?.recipientCommitCount).toBe(1);
        expect(request.repositoryAuthorship?.recentRecipientCommits[0]).toMatchObject({
          summary: "Add server-side authentication",
          belongsToRecipient: true,
          matchBasis: "email",
        });
        await bobClient!.reply({ requestId: request.requestId, text: "Cookies support server rendering." });
      },
    });
    bobClient = bob.client;

    const answer = await alice.client.ask({
      recipient: "bob",
      text: "Why this authentication design?",
      evidence: [{ kind: "file", value: "src/auth.ts:1" }],
    });
    expect(answer.text).toBe("Cookies support server rendering.");
    expect(answer.quotedPrompt).toBe(exactPrompt);
    expect(bob.io.printed).toContain("Matched an exact local prompt. It will be shared only in this approved answer.");
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

  test("daemons on an Auth0 relay connect with tokens and use the verified identity", async () => {
    const audience = "https://lineage.example/api";
    const issuer = await createFakeIssuer({ audience });
    relay = startRelay({
      port: 0,
      token: TOKEN,
      auth: { issuer: issuer.issuer, audience, jwks: issuer.jwks },
    });

    async function authSettings(sub: string, email: string) {
      return {
        domain: issuer.issuer,
        clientId: "client-1",
        audience,
        accessToken: await issuer.sign({ sub, email }),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        identity: email,
      };
    }

    const aliceStateDir = mkdtempSync(join(tmpdir(), "lineage-auth-alice-"));
    const bobStateDir = mkdtempSync(join(tmpdir(), "lineage-auth-bob-"));
    tempDirs.push(aliceStateDir, bobStateDir);
    const aliceIo = new ScriptedIo();
    const alice = await startDaemon({
      cwd: aliceStateDir,
      io: aliceIo,
      stateDir: aliceStateDir,
      repoId: "repo-1",
      // network.json still says "alice"; the verified identity must win.
      network: { relayUrl: relay.url, roomToken: TOKEN, userId: "alice", provider: "claude" },
      auth: await authSettings("auth0|1", "alice@example.com"),
      openRuntime: async () => ({ core: new MockLineageCore(), close: () => {} }),
      answerer: async () => {},
    });
    daemons.push(alice);
    expect(alice.actor.userId).toBe("alice@example.com");
    expect(
      aliceIo.printed.some((line) => line.includes('Auth0 identity "alice@example.com"')),
    ).toBeTrue();

    const bob = await startDaemon({
      cwd: bobStateDir,
      io: new ScriptedIo(["m", "Because rotation limits replay."]),
      stateDir: bobStateDir,
      repoId: "repo-1",
      network: { relayUrl: relay.url, roomToken: TOKEN, userId: "bob@example.com", provider: "codex" },
      auth: await authSettings("auth0|2", "bob@example.com"),
      openRuntime: async () => ({ core: new MockLineageCore(), close: () => {} }),
      answerer: async () => {},
    });
    daemons.push(bob);

    const aliceClient = DaemonClient.forPort(alice.port, alice.secret);
    const answer = await aliceClient.ask({
      recipient: "bob@example.com",
      text: "Why rotate refresh tokens?",
    });
    expect(answer.mode).toBe("manual");
    expect(answer.text).toBe("Because rotation limits replay.");
  });

  test("a daemon without a login cannot join an Auth0 relay", async () => {
    const audience = "https://lineage.example/api";
    const issuer = await createFakeIssuer({ audience });
    relay = startRelay({
      port: 0,
      token: TOKEN,
      auth: { issuer: issuer.issuer, audience, jwks: issuer.jwks },
    });
    const stateDir = mkdtempSync(join(tmpdir(), "lineage-auth-anon-"));
    tempDirs.push(stateDir);
    const error = await startDaemon({
      cwd: stateDir,
      io: new ScriptedIo(),
      stateDir,
      repoId: "repo-1",
      network: { relayUrl: relay.url, roomToken: TOKEN, userId: "alice", provider: "claude" },
      auth: null,
      openRuntime: async () => ({ core: new MockLineageCore(), close: () => {} }),
      answerer: async () => {},
    })
      .then(() => undefined)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
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
