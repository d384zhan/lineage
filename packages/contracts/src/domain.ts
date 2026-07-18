import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const IdentifierSchema = z.string().min(1);
export const UtcTimestampSchema = z.iso.datetime({ offset: true });
export const ProviderSchema = z.enum(["claude", "codex"]);

export const ActorSchema = z.object({
  userId: IdentifierSchema,
  provider: ProviderSchema.optional(),
  sessionId: IdentifierSchema.optional(),
});

export const AssumptionSchema = z.object({
  key: z.string().trim().min(1),
  value: z.string().trim().min(1),
});

export const IntentStatusSchema = z.enum([
  "active",
  "completed",
  "cancelled",
]);

export const IntentRecordSchema = z.object({
  id: IdentifierSchema,
  repoId: IdentifierSchema,
  author: ActorSchema,
  summary: z.string().trim().min(1),
  files: z.array(z.string()),
  symbols: z.array(z.string()),
  assumptions: z.array(AssumptionSchema),
  status: IntentStatusSchema,
  createdAt: UtcTimestampSchema,
});

export const DecisionRecordSchema = z.object({
  id: IdentifierSchema,
  repoId: IdentifierSchema,
  author: ActorSchema,
  commitSha: z.string().min(7),
  summary: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  alternatives: z.array(z.string()),
  assumptions: z.array(AssumptionSchema),
  files: z.array(z.string()),
  symbols: z.array(z.string()),
  evidence: z.array(z.lazy(() => EvidenceRefSchema)),
  sourceRequestId: IdentifierSchema.optional(),
  createdAt: UtcTimestampSchema,
});

export const EvidenceRefSchema = z.object({
  kind: z.enum([
    "commit",
    "decision",
    "intent",
    "file",
    "symbol",
    "request",
    "agent_answer",
  ]),
  value: z.string().min(1),
  label: z.string().optional(),
});

export const IntentConflictSchema = z.object({
  type: z.literal("assumption_mismatch"),
  key: z.string().min(1),
  left: z.object({
    intentId: IdentifierSchema,
    author: ActorSchema,
    value: z.string(),
  }),
  right: z.object({
    intentId: IdentifierSchema,
    author: ActorSchema,
    value: z.string(),
  }),
  detectedAt: UtcTimestampSchema,
});

export const IntentInputSchema = IntentRecordSchema.omit({
  id: true,
  status: true,
  createdAt: true,
});

export const DecisionInputSchema = DecisionRecordSchema.omit({
  id: true,
  createdAt: true,
});

export const AnnounceResultSchema = z.object({
  intent: IntentRecordSchema,
  conflicts: z.array(IntentConflictSchema),
});

export const HistoryQuerySchema = z
  .object({
    path: z.string().optional(),
    symbol: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((query) => Boolean(query.path || query.symbol || query.text), {
    message: "At least one history query field is required",
  });

export const TimelineFilterSchema = z.object({
  path: z.string().optional(),
  symbol: z.string().optional(),
  limit: z.number().int().positive().max(500).default(50),
});

export const WhyMatchSchema = z.object({
  decision: DecisionRecordSchema,
  matchedBy: z.array(z.enum(["path", "symbol", "text"])),
});

export const WhyResultSchema = z.object({
  query: HistoryQuerySchema,
  matches: z.array(WhyMatchSchema),
});

export const TimelineEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("intent"), record: IntentRecordSchema }),
  z.object({ kind: z.literal("decision"), record: DecisionRecordSchema }),
]);

export const TimelineResultSchema = z.object({
  entries: z.array(TimelineEntrySchema),
});

export type Provider = z.infer<typeof ProviderSchema>;
export type Actor = z.infer<typeof ActorSchema>;
export type Assumption = z.infer<typeof AssumptionSchema>;
export type IntentStatus = z.infer<typeof IntentStatusSchema>;
export type IntentRecord = z.infer<typeof IntentRecordSchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type IntentConflict = z.infer<typeof IntentConflictSchema>;
export type IntentInput = z.input<typeof IntentInputSchema>;
export type DecisionInput = z.input<typeof DecisionInputSchema>;
export type AnnounceResult = z.infer<typeof AnnounceResultSchema>;
export type HistoryQuery = z.input<typeof HistoryQuerySchema>;
export type TimelineFilter = z.input<typeof TimelineFilterSchema>;
export type WhyMatch = z.infer<typeof WhyMatchSchema>;
export type WhyResult = z.infer<typeof WhyResultSchema>;
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
export type TimelineResult = z.infer<typeof TimelineResultSchema>;
