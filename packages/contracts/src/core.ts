import { z } from "zod";
import {
  ActorSchema,
  AnnounceResultSchema,
  DecisionInputSchema,
  DecisionRecordSchema,
  HistoryQuerySchema,
  IdentifierSchema,
  IntentConflictSchema,
  IntentInputSchema,
  IntentRecordSchema,
  IntentStatusSchema,
  SessionEventSchema,
  TimelineFilterSchema,
  TimelineResultSchema,
  WhyResultSchema,
  type AnnounceResult,
  type DecisionInput,
  type DecisionRecord,
  type HistoryQuery,
  type IntentConflict,
  type IntentInput,
  type IntentRecord,
  type SessionEvent,
  type TimelineFilter,
  type TimelineResult,
  type WhyResult,
} from "./domain";

export const LinkCommitInputSchema = z.object({
  commitSha: z.string().min(1),
  sessionId: IdentifierSchema,
  author: ActorSchema,
  rationale: z.string().trim().min(1).optional(),
  alternatives: z.array(z.string()).default([]),
  assumptions: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
  symbols: z.array(z.string()).default([]),
});

export const UpdateIntentInputSchema = z.object({
  intentId: IdentifierSchema,
  status: IntentStatusSchema,
  commitSha: z.string().min(1).optional(),
});

export const CoreMethodSchemas = {
  appendSessionEvent: {
    input: SessionEventSchema,
    output: z.void(),
  },
  announce: {
    input: IntentInputSchema,
    output: AnnounceResultSchema,
  },
  ingestRemoteIntent: {
    input: IntentRecordSchema,
    output: z.array(IntentConflictSchema),
  },
  updateIntent: {
    input: UpdateIntentInputSchema,
    output: IntentRecordSchema,
  },
  recordDecision: {
    input: DecisionInputSchema,
    output: DecisionRecordSchema,
  },
  linkCommit: {
    input: LinkCommitInputSchema,
    output: DecisionRecordSchema,
  },
  why: {
    input: HistoryQuerySchema,
    output: WhyResultSchema,
  },
  timeline: {
    input: TimelineFilterSchema,
    output: TimelineResultSchema,
  },
} as const;

export type LinkCommitInput = z.input<typeof LinkCommitInputSchema>;
export type UpdateIntentInput = z.input<typeof UpdateIntentInputSchema>;

export interface LineageCore {
  appendSessionEvent(event: SessionEvent): Promise<void>;
  announce(input: IntentInput): Promise<AnnounceResult>;
  ingestRemoteIntent(intent: IntentRecord): Promise<IntentConflict[]>;
  updateIntent(input: UpdateIntentInput): Promise<IntentRecord>;
  recordDecision(input: DecisionInput): Promise<DecisionRecord>;
  linkCommit(input: LinkCommitInput): Promise<DecisionRecord>;
  why(query: HistoryQuery): Promise<WhyResult>;
  timeline(filter: TimelineFilter): Promise<TimelineResult>;
}
