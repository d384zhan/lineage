import {
  AskInputSchema,
  IntentRecordSchema,
  PROTOCOL_VERSION,
  ReplyInputSchema,
  renderInboundAgentRequest,
  type Actor,
  type AgentAnswer,
  type LineageTransport,
  type WireEnvelope,
} from "@lineage/contracts";
import { TransportError } from "@lineage/transport";
import { choosePort } from "@lineage/relay";
import type { Server } from "bun";
import { z } from "zod";
import { toInboundRequest } from "./approval";
import type { Inbox } from "./inbox";

export const DAEMON_SECRET_HEADER = "x-lineage-secret";

export interface CoreRuntime {
  core: import("@lineage/contracts").LineageCore;
  close(): void;
}

export type RuntimeOpener = () => Promise<CoreRuntime>;

export interface HttpApiOptions {
  port: number;
  secret: string;
  actor: Actor;
  repoId: string;
  inbox: Inbox;
  transport: LineageTransport;
  openRuntime: RuntimeOpener;
  startedAt: string;
}

const ReplyBodySchema = ReplyInputSchema.extend({
  mode: z.enum(["agent", "manual", "history"]).default("agent"),
});

export function buildEnvelope(
  repoId: string,
  sender: Actor,
  partial:
    | { type: "intent.announce"; payload: unknown }
    | { type: "presence"; payload: unknown }
    | { type: "question.answer"; recipient: string; requestId: string; payload: unknown }
    | { type: "question.reject"; recipient: string; requestId: string; payload: unknown },
): WireEnvelope {
  return {
    version: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    repoId,
    sender,
    createdAt: new Date().toISOString(),
    ...partial,
  } as WireEnvelope;
}

export async function publishAnswer(
  transport: LineageTransport,
  repoId: string,
  sender: Actor,
  recipient: string,
  answer: AgentAnswer,
): Promise<void> {
  await transport.publish(
    buildEnvelope(repoId, sender, {
      type: "question.answer",
      recipient,
      requestId: answer.requestId,
      payload: answer,
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof TransportError) {
    return json({ error: { code: error.code, message: error.message } }, 502);
  }
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: { message } }, error instanceof z.ZodError ? 400 : 500);
}

export function startHttpApi(options: HttpApiOptions): Server<undefined> {
  const { secret, actor, repoId, inbox, transport } = options;
  let port = choosePort(options.port);

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get(DAEMON_SECRET_HEADER) !== secret) {
      return json({ error: { message: "Invalid or missing daemon secret" } }, 401);
    }
    try {
      if (request.method === "GET" && url.pathname === "/status") {
        return json({
          actor,
          repoId,
          startedAt: options.startedAt,
          openQuestions: inbox.open().length,
        });
      }
      if (request.method === "POST" && url.pathname === "/ask") {
        const input = AskInputSchema.parse(await request.json());
        const answer = await transport.ask(input);
        return json(answer);
      }
      if (request.method === "POST" && url.pathname === "/reply") {
        const input = ReplyBodySchema.parse(await request.json());
        const entry = inbox.get(input.requestId);
        if (!entry) {
          return json({ error: { message: `Unknown requestId: ${input.requestId}` } }, 404);
        }
        if (entry.status === "answered" || entry.status === "rejected") {
          return json(
            { error: { message: `Request ${input.requestId} was already ${entry.status}` } },
            409,
          );
        }
        const answer: AgentAnswer = {
          requestId: input.requestId,
          mode: input.mode,
          text: input.text,
          ...(input.quotedPrompt || entry.quotedPrompt
            ? { quotedPrompt: input.quotedPrompt ?? entry.quotedPrompt }
            : {}),
          evidence: input.evidence,
        };
        await publishAnswer(transport, repoId, actor, entry.sender.userId, answer);
        inbox.markAnswered(input.requestId, answer);
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/inbox") {
        return json({
          entries: inbox.list().map((entry) => ({
            ...entry,
            rendered:
              entry.status === "pending" || entry.status === "approved_agent"
                ? renderInboundAgentRequest(toInboundRequest(entry))
                : undefined,
          })),
        });
      }
      if (request.method === "POST" && url.pathname === "/publish-intent") {
        const intent = IntentRecordSchema.parse(await request.json());
        await transport.publish(
          buildEnvelope(repoId, actor, { type: "intent.announce", payload: intent }),
        );
        return json({ ok: true });
      }
      return json({ error: { message: `No route: ${request.method} ${url.pathname}` } }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: handle,
      });
    } catch (error) {
      if (options.port !== 0 || attempt >= 9) throw error;
      port = choosePort(0);
    }
  }
}
