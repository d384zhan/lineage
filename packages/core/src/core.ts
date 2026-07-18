import { createHash } from "node:crypto";
import {
  DecisionInputSchema,
  DecisionRecordSchema,
  HistoryQuerySchema,
  IntentInputSchema,
  IntentRecordSchema,
  LinkCommitInputSchema,
  SessionEventSchema,
  TimelineFilterSchema,
  UpdateIntentInputSchema,
  type AnnounceResult,
  type DecisionInput,
  type DecisionRecord,
  type HistoryQuery,
  type IntentConflict,
  type IntentInput,
  type IntentRecord,
  type LineageCore,
  type LinkCommitInput,
  type SessionEvent,
  type TimelineFilter,
  type TimelineResult,
  type UpdateIntentInput,
  type WhyResult,
} from "@lineage/contracts";
import { detectIntentConflicts } from "./conflicts";
import type { CommitInspector, LineageStore } from "./store";

export interface DefaultLineageCoreOptions {
  store: LineageStore;
  commitInspector: CommitInspector;
  now?: () => string;
  id?: () => string;
}

export class DefaultLineageCore implements LineageCore {
  private readonly store: LineageStore;
  private readonly commitInspector: CommitInspector;
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(options: DefaultLineageCoreOptions) {
    this.store = options.store;
    this.commitInspector = options.commitInspector;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  async appendSessionEvent(event: SessionEvent): Promise<void> {
    await this.store.appendSessionEvent(SessionEventSchema.parse(event));
  }

  async announce(input: IntentInput): Promise<AnnounceResult> {
    const parsed = IntentInputSchema.parse(input);
    await this.assertRepoId(parsed.repoId);
    const intent = IntentRecordSchema.parse({
      ...parsed,
      id: this.id(),
      status: "active",
      createdAt: this.now(),
    });
    const conflicts = await this.conflictsFor(intent);
    await this.store.saveIntent(intent);
    return { intent, conflicts };
  }

  async ingestRemoteIntent(intent: IntentRecord): Promise<IntentConflict[]> {
    const parsed = IntentRecordSchema.parse(intent);
    await this.assertRepoId(parsed.repoId);
    const conflicts = await this.conflictsFor(parsed);
    await this.store.saveIntent(parsed);
    return conflicts;
  }

  async updateIntent(input: UpdateIntentInput): Promise<IntentRecord> {
    const parsed = UpdateIntentInputSchema.parse(input);
    const current = await this.store.getIntent(parsed.intentId);
    if (!current) throw new Error(`Unknown intent: ${parsed.intentId}`);
    const updated = IntentRecordSchema.parse({ ...current, status: parsed.status });
    await this.store.saveIntent(updated, parsed.commitSha ? { commitSha: parsed.commitSha } : undefined);
    return updated;
  }

  async recordDecision(input: DecisionInput): Promise<DecisionRecord> {
    const parsed = DecisionInputSchema.parse(input);
    await this.assertRepoId(parsed.repoId);
    const decision = DecisionRecordSchema.parse({
      ...parsed,
      id: this.id(),
      createdAt: this.now(),
    });
    await this.store.saveDecision(decision);
    return decision;
  }

  async linkCommit(input: LinkCommitInput): Promise<DecisionRecord> {
    const parsed = LinkCommitInputSchema.parse(input);
    const commit = await this.commitInspector.inspectCommit(parsed.commitSha);
    const events = await this.store.getSessionEvents(parsed.sessionId);
    const relevantIntents = (await this.store.listIntents({ limit: 500 })).filter(
      (intent) =>
        intent.status === "active" &&
        intent.author.userId === parsed.author.userId &&
        (intent.author.sessionId === parsed.sessionId ||
          intent.files.some((file) => commit.files.includes(file))),
    );
    const promptHashes = events
      .filter((event) => event.kind === "user_prompt")
      .map((event) => createHash("sha256").update(event.content).digest("hex"));
    const rationale = parsed.rationale ?? (commit.body.trim() || commit.summary);
    const assumptions = mergeByKey(
      parsed.assumptions,
      relevantIntents.flatMap((intent) => intent.assumptions),
    );
    const symbols = [
      ...new Set([
        ...parsed.symbols,
        ...relevantIntents.flatMap((intent) => intent.symbols),
      ]),
    ];

    const decision = await this.recordDecision({
      repoId: await this.store.getRepoId(),
      author: parsed.author,
      commitSha: commit.commitSha,
      summary: commit.summary,
      rationale,
      alternatives: parsed.alternatives,
      assumptions,
      files: commit.files,
      symbols,
      sessionId: parsed.sessionId,
      promptHashes,
    });
    await Promise.all(
      relevantIntents.map((intent) =>
        this.store.saveIntent(
          IntentRecordSchema.parse({ ...intent, status: "completed" }),
          { commitSha: commit.commitSha },
        ),
      ),
    );
    return decision;
  }

  async why(query: HistoryQuery): Promise<WhyResult> {
    const parsed = HistoryQuerySchema.parse(query);
    const decisions = await this.store.findDecisions(parsed);
    return {
      query: parsed,
      matches: decisions.map((decision) => ({
        decision,
        matchedBy: matchedBy(decision, parsed),
      })),
    };
  }

  async timeline(filter: TimelineFilter): Promise<TimelineResult> {
    const parsed = TimelineFilterSchema.parse(filter);
    const [intents, decisions] = await Promise.all([
      this.store.listIntents(parsed),
      this.store.listDecisions(parsed),
    ]);
    const entries: TimelineResult["entries"] = [
      ...intents.map((record) => ({ kind: "intent" as const, record })),
      ...decisions.map((record) => ({ kind: "decision" as const, record })),
    ];
    entries.sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
    return { entries: entries.slice(0, parsed.limit) };
  }

  private async conflictsFor(intent: IntentRecord): Promise<IntentConflict[]> {
    const active = (await this.store.listIntents({ limit: 500 })).filter(
      (record) => record.status === "active",
    );
    return detectIntentConflicts(intent, active, this.now());
  }

  private async assertRepoId(repoId: string): Promise<void> {
    const expected = await this.store.getRepoId();
    if (repoId !== expected) {
      throw new Error(`Repository mismatch: expected ${expected}, received ${repoId}`);
    }
  }

}

function mergeByKey<T extends { key: string }>(
  preferred: readonly T[],
  fallback: readonly T[],
): T[] {
  const merged = new Map<string, T>();
  for (const item of fallback) merged.set(item.key.toLowerCase(), item);
  for (const item of preferred) merged.set(item.key.toLowerCase(), item);
  return [...merged.values()];
}

function matchedBy(
  decision: DecisionRecord,
  query: HistoryQuery,
): Array<"path" | "symbol" | "text"> {
  const result: Array<"path" | "symbol" | "text"> = [];
  if (query.path && decision.files.some((file) => file.includes(query.path!))) result.push("path");
  if (query.symbol && decision.symbols.some((symbol) => symbol.includes(query.symbol!))) {
    result.push("symbol");
  }
  if (query.text) {
    const text = `${decision.summary} ${decision.rationale} ${decision.alternatives.join(" ")}`.toLowerCase();
    if (text.includes(query.text.toLowerCase())) result.push("text");
  }
  return result;
}
