import { z } from "zod";
import {
  ActorSchema,
  EvidenceRefSchema,
  IdentifierSchema,
  IntentRecordSchema,
  PROTOCOL_VERSION,
  UtcTimestampSchema,
} from "./domain";

export const AgentQuestionSchema = z.object({
  text: z.string().trim().min(1),
  evidence: z.array(EvidenceRefSchema),
});

export const AgentAnswerSchema = z.object({
  requestId: IdentifierSchema,
  mode: z.enum(["agent", "manual", "history"]),
  text: z.string().trim().min(1),
  quotedPrompt: z.string().min(1).optional(),
  evidence: z.array(EvidenceRefSchema),
});

export const AckSchema = z.object({
  messageId: IdentifierSchema,
  delivered: z.boolean(),
  receivedAt: UtcTimestampSchema,
});

export const ErrorCodeSchema = z.enum([
  "invalid_token",
  "unsupported_version",
  "unsupported_message_type",
  "recipient_offline",
  "request_rejected",
  "request_timeout",
]);

export const WireErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  requestId: IdentifierSchema.optional(),
});

const EnvelopeBaseSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: IdentifierSchema,
  repoId: IdentifierSchema,
  sender: ActorSchema,
  recipient: IdentifierSchema.optional(),
  requestId: IdentifierSchema.optional(),
  createdAt: UtcTimestampSchema,
});

export const WireEnvelopeSchema = z.discriminatedUnion("type", [
  EnvelopeBaseSchema.extend({
    type: z.literal("hello"),
    payload: z.object({ roomToken: z.string().min(1) }),
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal("presence"),
    payload: z.object({ status: z.enum(["online", "busy", "offline"]) }),
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal("intent.announce"),
    payload: IntentRecordSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal("question.ask"),
    recipient: IdentifierSchema,
    requestId: IdentifierSchema,
    payload: AgentQuestionSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal("question.answer"),
    recipient: IdentifierSchema,
    requestId: IdentifierSchema,
    payload: AgentAnswerSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal("question.reject"),
    recipient: IdentifierSchema,
    requestId: IdentifierSchema,
    payload: z.object({ reason: z.string().optional() }),
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal("ack"),
    payload: AckSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal("error"),
    payload: WireErrorSchema,
  }),
]).superRefine((message, context) => {
  if (
    message.type === "question.answer" &&
    message.requestId !== message.payload.requestId
  ) {
    context.addIssue({
      code: "custom",
      path: ["payload", "requestId"],
      message: "Envelope and answer requestId must match",
    });
  }
  if (
    message.type === "intent.announce" &&
    message.repoId !== message.payload.repoId
  ) {
    context.addIssue({
      code: "custom",
      path: ["payload", "repoId"],
      message: "Envelope and intent repoId must match",
    });
  }
});

export const ConnectionConfigSchema = z.object({
  relayUrl: z.string().url().refine((url) => url.startsWith("ws"), {
    message: "relayUrl must use ws:// or wss://",
  }),
  repoId: IdentifierSchema,
  roomToken: z.string().min(1),
  actor: ActorSchema,
});

export const AskInputSchema = z.object({
  recipient: IdentifierSchema,
  text: z.string().trim().min(1),
  evidence: z.array(EvidenceRefSchema).default([]),
});

export const ReplyInputSchema = z.object({
  requestId: IdentifierSchema,
  text: z.string().trim().min(1),
  quotedPrompt: z.string().min(1).optional(),
  evidence: z.array(EvidenceRefSchema).default([]),
});

export const ApprovalActionSchema = z.enum(["agent", "manual", "reject"]);

export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;
export type Ack = z.infer<typeof AckSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type WireError = z.infer<typeof WireErrorSchema>;
export type WireEnvelope = z.infer<typeof WireEnvelopeSchema>;
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;
export type AskInput = z.input<typeof AskInputSchema>;
export type ReplyInput = z.input<typeof ReplyInputSchema>;
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;
export type MessageHandler = (message: WireEnvelope) => void | Promise<void>;

export interface LineageTransport {
  connect(config: ConnectionConfig): Promise<void>;
  publish(message: WireEnvelope): Promise<Ack>;
  ask(input: AskInput): Promise<AgentAnswer>;
  subscribe(handler: MessageHandler): () => void;
  close(): Promise<void>;
}
