import type {
  DecisionRecord,
  HistoryQuery,
  IntentRecord,
  SessionEvent,
  TimelineFilter,
} from "@lineage/contracts";

export interface SaveIntentOptions {
  commitSha?: string;
}

export interface LineageStore {
  getRepoId(): Promise<string>;
  appendSessionEvent(event: SessionEvent): Promise<void>;
  getSessionEvents(sessionId: string): Promise<SessionEvent[]>;
  saveIntent(intent: IntentRecord, options?: SaveIntentOptions): Promise<void>;
  getIntent(intentId: string): Promise<IntentRecord | undefined>;
  listIntents(filter?: TimelineFilter): Promise<IntentRecord[]>;
  saveDecision(decision: DecisionRecord): Promise<void>;
  findDecisions(query: HistoryQuery): Promise<DecisionRecord[]>;
  listDecisions(filter?: TimelineFilter): Promise<DecisionRecord[]>;
}

export interface CommitMetadata {
  commitSha: string;
  summary: string;
  body: string;
  files: string[];
}

export interface CommitInspector {
  inspectCommit(commitSha: string): Promise<CommitMetadata>;
}
