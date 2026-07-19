#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "@lineage/daemon";
import {
  LINEAGE_CHANNEL_ENV,
  LINEAGE_PROVIDER_ENV,
  LINEAGE_SESSION_ID_ENV,
  LINEAGE_USER_ID_ENV,
} from "@lineage/contracts";
import { createTools } from "./tools";

const tools = createTools({ cwd: process.cwd(), env: process.env });
const channelEnabled =
  process.env[LINEAGE_PROVIDER_ENV] === "claude" &&
  process.env[LINEAGE_CHANNEL_ENV] === "1";
const groundingInstructions = [
  "Lineage questions about why code exists, implementation choices, regressions, or design decisions must be code-grounded.",
  "Before calling lineage_ask for one of these questions, inspect the repository and pass the narrowest relevant path:line in the line argument.",
  "The line enables Git blame and private originating-prompt matching. Omit it only for genuinely broad status or coordination questions.",
  "Recipients may be addressed by full identity, email prefix, or a unique Git-name token. If Lineage reports an ambiguous match, show the candidates and retry only after the user clarifies.",
].join(" ");
const channelInstructions = [
  "Lineage requests and completed answers arrive as channel events from trusted teammates.",
  "For a question or action request, show it and ask whether to dispatch this agent, answer manually, or reject.",
  "For context, show it and ask whether to accept it into this session or reject it; accepted context requires no reply.",
  "Call lineage_respond with their choice. After dispatch, answer using lineage_reply.",
  "For a completed outgoing request, call lineage_requests with its request ID and show the answer.",
].join(" ");

const server = new Server(
  { name: "lineage", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      ...(channelEnabled ? { experimental: { "claude/channel": {} } } : {}),
    },
    instructions: channelEnabled
      ? `${groundingInstructions} ${channelInstructions}`
      : groundingInstructions,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.definitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  tools.call(request.params.name, request.params.arguments ?? {}),
);

await server.connect(new StdioServerTransport());

const notifiedInbound = new Set<string>();
const notifiedOutgoing = new Set<string>();
const outgoingStatuses = new Map<string, string>();
const channelStartedAt = Date.now();
const currentSessionId = process.env[LINEAGE_SESSION_ID_ENV];
const currentUserId = process.env[LINEAGE_USER_ID_ENV];
let daemon: DaemonClient | undefined;
let polling = false;
const poll = async () => {
  if (polling) return;
  polling = true;
  try {
    daemon ??= await DaemonClient.open(process.cwd());
    const [entries, outgoing] = await Promise.all([daemon.inbox(), daemon.requests()]);
    const pending = new Set(
      entries.filter((entry) => entry.status === "pending").map((entry) => entry.requestId),
    );
    for (const requestId of notifiedInbound) {
      if (!pending.has(requestId)) notifiedInbound.delete(requestId);
    }
    for (const entry of entries) {
      if (
        entry.status !== "pending" ||
        notifiedInbound.has(entry.requestId) ||
        (currentSessionId && entry.question.sourceSessionId === currentSessionId)
      ) continue;
      const kind = entry.question.kind ?? "question";
      const isOwnContext = kind === "context" && entry.sender.userId === currentUserId;
      if (isOwnContext) {
        const accepted = await daemon.respond({
          requestId: entry.requestId,
          action: "dispatch",
        }) as { rendered?: string };
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: [
              "Lineage context from your other session was added automatically.",
              accepted.rendered ?? entry.question.text,
            ].join("\n"),
            meta: {
              source: "lineage",
              request_id: entry.requestId,
              sender: entry.sender.userId,
              auto_accepted: true,
            },
          },
        } as Parameters<typeof server.notification>[0]);
        notifiedInbound.add(entry.requestId);
        continue;
      }
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: [
            `Lineage ${kind} from ${entry.sender.userId}: ${entry.question.text}`,
            kind === "context"
              ? `Ask: accept into this session or reject? (${entry.requestId})`
              : `Ask: dispatch, manual, or reject? (${entry.requestId})`,
          ].join("\n"),
          meta: {
            source: "lineage",
            request_id: entry.requestId,
            sender: entry.sender.userId,
          },
        },
      } as Parameters<typeof server.notification>[0]);
      notifiedInbound.add(entry.requestId);
    }
    for (const entry of outgoing) {
      if (
        entry.question.sourceSessionId &&
        entry.question.sourceSessionId !== currentSessionId
      ) continue;
      const previous = outgoingStatuses.get(entry.requestId);
      outgoingStatuses.set(entry.requestId, entry.status);
      if (
        entry.status === "pending" ||
        notifiedOutgoing.has(entry.requestId) ||
        (previous !== "pending" && Date.parse(entry.createdAt) < channelStartedAt)
      ) continue;
      if (entry.status === "delivered") {
        notifiedOutgoing.add(entry.requestId);
        continue;
      }
      const content = entry.status === "answered"
        ? [
            `Lineage answer from ${entry.recipient} is ready: ${entry.question.text}`,
            `Call lineage_requests with requestId ${entry.requestId} and show the answer to the user.`,
          ].join("\n")
        : [
            `Lineage request to ${entry.recipient} ${entry.status}: ${entry.question.text}`,
            `Call lineage_requests with requestId ${entry.requestId} and explain what happened.`,
          ].join("\n");
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content,
          meta: {
            source: "lineage",
            request_id: entry.requestId,
            recipient: entry.recipient,
            status: entry.status,
          },
        },
      } as Parameters<typeof server.notification>[0]);
      notifiedOutgoing.add(entry.requestId);
    }
  } catch {
    // The daemon may not be ready yet; the next poll retries.
    daemon = undefined;
  } finally {
    polling = false;
  }
};

if (channelEnabled) {
  setInterval(() => void poll(), 500);
  void poll();
}
