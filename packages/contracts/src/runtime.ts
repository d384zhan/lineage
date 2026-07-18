import { z } from "zod";
import { ActorSchema, IdentifierSchema } from "./domain";
import { AgentQuestionSchema } from "./transport";

export const LINEAGE_SESSION_ID_ENV = "LINEAGE_SESSION_ID";
export const LINEAGE_USER_ID_ENV = "LINEAGE_USER_ID";
export const LINEAGE_PROVIDER_ENV = "LINEAGE_PROVIDER";

export const MCP_TOOL_NAMES = {
  announce: "lineage_announce",
  ask: "lineage_ask",
  reply: "lineage_reply",
  why: "lineage_why",
  timeline: "lineage_timeline",
  inbox: "lineage_inbox",
} as const;

export const InboundAgentRequestSchema = z.object({
  requestId: IdentifierSchema,
  sender: ActorSchema,
  question: AgentQuestionSchema,
});

export type InboundAgentRequest = z.infer<typeof InboundAgentRequestSchema>;

export function renderInboundAgentRequest(input: InboundAgentRequest): string {
  const parsed = InboundAgentRequestSchema.parse(input);
  const evidence = parsed.question.evidence.length
    ? `\nEvidence:\n${parsed.question.evidence
        .map((item) => `- ${item.kind}: ${item.value}`)
        .join("\n")}\n`
    : "\n";
  return [
    `<lineage_request id="${parsed.requestId}" from="${parsed.sender.userId}">`,
    parsed.question.text,
    evidence.trimEnd(),
    `Respond with the ${MCP_TOOL_NAMES.reply} MCP tool using requestId "${parsed.requestId}".`,
    "</lineage_request>",
  ]
    .filter(Boolean)
    .join("\n");
}
