#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "@lineage/daemon";
import { LINEAGE_PROVIDER_ENV } from "@lineage/contracts";
import { createTools } from "./tools";

const tools = createTools({ cwd: process.cwd(), env: process.env });
const channelEnabled = process.env[LINEAGE_PROVIDER_ENV] === "claude";
const channelInstructions = [
  "Lineage questions arrive as channel events from trusted teammates.",
  "Show the question to the user and ask whether to dispatch this agent, answer manually, or reject.",
  "Call lineage_respond with their choice. After dispatch, answer using lineage_reply.",
].join(" ");

const server = new Server(
  { name: "lineage", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      ...(channelEnabled ? { experimental: { "claude/channel": {} } } : {}),
    },
    ...(channelEnabled ? { instructions: channelInstructions } : {}),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.definitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  tools.call(request.params.name, request.params.arguments ?? {}),
);

await server.connect(new StdioServerTransport());

const notified = new Set<string>();
let daemon: DaemonClient | undefined;
const poll = async () => {
  try {
    daemon ??= await DaemonClient.open(process.cwd());
    const entries = await daemon.inbox();
    const pending = new Set(
      entries.filter((entry) => entry.status === "pending").map((entry) => entry.requestId),
    );
    for (const requestId of notified) {
      if (!pending.has(requestId)) notified.delete(requestId);
    }
    for (const entry of entries) {
      if (entry.status !== "pending" || notified.has(entry.requestId)) continue;
      notified.add(entry.requestId);
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: [
            `Incoming Lineage question from ${entry.sender.userId}:`,
            entry.question.text,
            `Request ID: ${entry.requestId}`,
            "Ask the user whether to dispatch you, answer manually, or reject. Then call lineage_respond.",
          ].join("\n"),
          meta: {
            source: "lineage",
            request_id: entry.requestId,
            sender: entry.sender.userId,
          },
        },
      } as Parameters<typeof server.notification>[0]);
    }
  } catch {
    // The daemon may not be ready yet; the next poll retries.
    daemon = undefined;
  }
};

if (channelEnabled) {
  setInterval(() => void poll(), 500);
  void poll();
}
