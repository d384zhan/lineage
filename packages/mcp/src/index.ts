#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createTools } from "./tools";

const tools = createTools({ cwd: process.cwd(), env: process.env });

const server = new Server(
  { name: "lineage", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.definitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  tools.call(request.params.name, request.params.arguments ?? {}),
);

await server.connect(new StdioServerTransport());
