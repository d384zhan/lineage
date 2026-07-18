import { describe, expect, test } from "bun:test";
import type {
  DecisionRecord,
  HistoryQuery,
  IntentRecord,
  SessionEvent,
  TimelineFilter,
} from "@lineage/contracts";
import { DefaultLineageCore } from "./core";
import type {
  CommitInspector,
  LineageStore,
  SaveIntentOptions,
} from "./store";

class MemoryStore implements LineageStore {
  events: SessionEvent[] = [];
  intents: IntentRecord[] = [];
  decisions: DecisionRecord[] = [];

  async getRepoId() { return "repo-1"; }
  async appendSessionEvent(event: SessionEvent) { this.events.push(event); }
  async getSessionEvents(sessionId: string) {
    return this.events.filter((event) => event.sessionId === sessionId);
  }
  async saveIntent(intent: IntentRecord, _options?: SaveIntentOptions) {
    this.intents = [...this.intents.filter((item) => item.id !== intent.id), intent];
  }
  async getIntent(intentId: string) { return this.intents.find((item) => item.id === intentId); }
  async listIntents(_filter?: TimelineFilter) { return this.intents; }
  async saveDecision(decision: DecisionRecord) { this.decisions.push(decision); }
  async findDecisions(_query: HistoryQuery) { return this.decisions; }
  async listDecisions(_filter?: TimelineFilter) { return this.decisions; }
}

const inspector: CommitInspector = {
  async inspectCommit(commitSha) {
    return {
      commitSha,
      summary: "Rotate refresh tokens",
      body: "Limit replay attacks",
      files: ["src/auth.ts"],
    };
  },
};

function createCore(store = new MemoryStore()) {
  let id = 0;
  return {
    store,
    core: new DefaultLineageCore({
      store,
      commitInspector: inspector,
      now: () => "2026-07-18T19:00:00.000Z",
      id: () => `id-${++id}`,
    }),
  };
}

describe("DefaultLineageCore", () => {
  test("detects different values for the same normalized assumption key", async () => {
    const { core } = createCore();
    await core.announce({
      repoId: "repo-1",
      author: { userId: "alice" },
      summary: "Use cookies",
      files: ["src/auth.ts"],
      symbols: [],
      assumptions: [{ key: "Auth.Token_Storage", value: "HTTPOnly Cookie" }],
    });
    const result = await core.announce({
      repoId: "repo-1",
      author: { userId: "bob" },
      summary: "Use browser storage",
      files: ["src/auth.ts"],
      symbols: [],
      assumptions: [{ key: "auth.token_storage", value: "localStorage" }],
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.type).toBe("assumption_mismatch");
  });

  test("does not conflict when normalized values match", async () => {
    const { core } = createCore();
    const base = {
      repoId: "repo-1",
      files: [] as string[],
      symbols: [] as string[],
      assumptions: [{ key: "runtime", value: "Bun  " }],
    };
    await core.announce({ ...base, author: { userId: "alice" }, summary: "Runtime" });
    const result = await core.announce({
      ...base,
      author: { userId: "bob" },
      summary: "Same runtime",
      assumptions: [{ key: "runtime", value: "bun" }],
    });
    expect(result.conflicts).toHaveLength(0);
  });

  test("hashes prompts without copying raw content into a decision", async () => {
    const { core, store } = createCore();
    await core.announce({
      repoId: "repo-1",
      author: { userId: "alice", sessionId: "session-1" },
      summary: "Auth",
      files: ["src/auth.ts"],
      symbols: ["refreshToken"],
      assumptions: [{ key: "auth.storage", value: "cookie" }],
    });
    await core.appendSessionEvent({
      id: "event-1",
      sessionId: "session-1",
      provider: "claude",
      kind: "user_prompt",
      content: "secret raw prompt",
      createdAt: "2026-07-18T18:00:00.000Z",
    });
    const decision = await core.linkCommit({
      commitSha: "abcdef1234567890",
      sessionId: "session-1",
      author: { userId: "alice", provider: "claude" },
    });
    expect(decision.promptHashes[0]).toHaveLength(64);
    expect(decision.assumptions).toEqual([{ key: "auth.storage", value: "cookie" }]);
    expect(decision.symbols).toEqual(["refreshToken"]);
    expect(store.intents[0]?.status).toBe("completed");
    expect(JSON.stringify(store.decisions)).not.toContain("secret raw prompt");
  });
});
