import {
  type Ack,
  type Actor,
  type AgentAnswer,
  type AnnounceResult,
  type AskInput,
  type ConnectionConfig,
  type DecisionInput,
  type DecisionRecord,
  type HistoryQuery,
  type IntentConflict,
  type IntentInput,
  type IntentRecord,
  type LineageCore,
  type LineageTransport,
  type LinkCommitInput,
  type MessageHandler,
  type TimelineFilter,
  type TimelineResult,
  type UpdateIntentInput,
  type WhyResult,
  type WireEnvelope,
} from "./index";

const NOW = "2026-07-18T19:00:00.000Z";

export function fixtureActor(overrides: Partial<Actor> = {}): Actor {
  return { userId: "alice", provider: "claude", sessionId: "session-1", ...overrides };
}

export function fixtureIntent(
  overrides: Partial<IntentRecord> = {},
): IntentRecord {
  return {
    id: "intent-1",
    repoId: "repo-1",
    author: fixtureActor(),
    summary: "Implement token refresh",
    files: ["src/auth.ts"],
    symbols: ["refreshToken"],
    assumptions: [{ key: "auth.token_storage", value: "httpOnly-cookie" }],
    status: "active",
    createdAt: NOW,
    ...overrides,
  };
}

export function fixtureDecision(
  overrides: Partial<DecisionRecord> = {},
): DecisionRecord {
  return {
    id: "decision-1",
    repoId: "repo-1",
    author: fixtureActor(),
    commitSha: "abcdef1234567890",
    summary: "Rotate refresh tokens",
    rationale: "Limit replay after a token is used",
    alternatives: ["Long-lived refresh token"],
    assumptions: [{ key: "auth.token_storage", value: "httpOnly-cookie" }],
    files: ["src/auth.ts"],
    symbols: ["refreshToken"],
    evidence: [{ kind: "commit", value: "abcdef1234567890" }],
    createdAt: NOW,
    ...overrides,
  };
}

export class MockLineageCore implements LineageCore {
  readonly calls: Array<{ method: string; input: unknown }> = [];
  intent = fixtureIntent();
  decision = fixtureDecision();
  conflicts: IntentConflict[] = [];

  async announce(input: IntentInput): Promise<AnnounceResult> {
    this.calls.push({ method: "announce", input });
    return { intent: this.intent, conflicts: this.conflicts };
  }

  async ingestRemoteIntent(intent: IntentRecord): Promise<IntentConflict[]> {
    this.calls.push({ method: "ingestRemoteIntent", input: intent });
    return this.conflicts;
  }

  async updateIntent(input: UpdateIntentInput): Promise<IntentRecord> {
    this.calls.push({ method: "updateIntent", input });
    this.intent = { ...this.intent, status: input.status };
    return this.intent;
  }

  async recordDecision(input: DecisionInput): Promise<DecisionRecord> {
    this.calls.push({ method: "recordDecision", input });
    return this.decision;
  }

  async linkCommit(input: LinkCommitInput): Promise<DecisionRecord> {
    this.calls.push({ method: "linkCommit", input });
    return this.decision;
  }

  async why(query: HistoryQuery): Promise<WhyResult> {
    this.calls.push({ method: "why", input: query });
    return {
      query,
      matches: [{ decision: this.decision, matchedBy: ["text"] }],
    };
  }

  async timeline(filter: TimelineFilter): Promise<TimelineResult> {
    this.calls.push({ method: "timeline", input: filter });
    return {
      entries: [
        { kind: "intent", record: this.intent },
        { kind: "decision", record: this.decision },
      ],
    };
  }
}

export class MockLineageTransport implements LineageTransport {
  readonly published: WireEnvelope[] = [];
  readonly asks: AskInput[] = [];
  connection: ConnectionConfig | undefined;
  answer: AgentAnswer = {
    requestId: "request-1",
    mode: "agent",
    text: "Token rotation limits replay.",
    quotedPrompt: "Implement rotating refresh tokens and prevent replay.",
    evidence: [{ kind: "commit", value: "abcdef1234567890" }],
  };
  private handlers = new Set<MessageHandler>();

  async connect(config: ConnectionConfig): Promise<void> {
    this.connection = config;
  }

  isConnected(): boolean {
    return this.connection !== undefined;
  }

  async publish(message: WireEnvelope): Promise<Ack> {
    this.published.push(message);
    return {
      messageId: message.id,
      delivered: true,
      receivedAt: NOW,
    };
  }

  async ask(input: AskInput): Promise<AgentAnswer> {
    this.asks.push(input);
    return this.answer;
  }

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async emit(message: WireEnvelope): Promise<void> {
    await Promise.all([...this.handlers].map((handler) => handler(message)));
  }

  async close(): Promise<void> {
    this.connection = undefined;
    this.handlers.clear();
  }
}
