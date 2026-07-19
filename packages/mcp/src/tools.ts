import {
  LINEAGE_PROVIDER_ENV,
  LINEAGE_SESSION_ID_ENV,
  LINEAGE_USER_ID_ENV,
  MCP_TOOL_NAMES,
  ProviderSchema,
  ReplyInputSchema,
  RespondInputSchema,
  type Actor,
  type LineageCore,
} from "@lineage/contracts";
import { DaemonClient } from "@lineage/daemon";
import { openGitLineageRuntime } from "@lineage/git-store";
import { loadPromptIndex, matchPromptsForLine, readExactPrompt, traceCodeLine } from "@lineage/prompt-index";
import { z } from "zod";

export interface McpCoreRuntime {
  core: LineageCore;
  repoId: string;
  close(): void;
}

export interface ToolsOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  openRuntime?: () => Promise<McpCoreRuntime>;
  openDaemon?: () => Promise<DaemonClient>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

const AssumptionInputSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
});

const AnnounceArgsSchema = z.object({
  summary: z.string().min(1),
  files: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  assumptions: z.array(AssumptionInputSchema).default([]),
});

const EvidenceInputSchema = z.object({
  kind: z.enum(["commit", "decision", "intent", "file", "symbol", "request", "agent_answer"]),
  value: z.string().min(1),
  label: z.string().optional(),
});

const RecordDecisionArgsSchema = z.object({
  commitSha: z.string().min(1),
  summary: z.string().min(1),
  rationale: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
  assumptions: z.array(AssumptionInputSchema).default([]),
  files: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  evidence: z.array(EvidenceInputSchema).default([]),
  sourceRequestId: z.string().min(1).optional(),
});

const AskArgsSchema = z.object({
  recipient: z.string().min(1),
  text: z.string().min(1).optional(),
  line: z.string().regex(/^.+:\d+$/).optional(),
  evidence: z.array(EvidenceInputSchema).default([]),
}).refine((input) => Boolean(input.text || input.line), {
  message: "Provide text or an exact code line",
});

const WhyArgsSchema = z
  .object({
    path: z.string().optional(),
    line: z.string().regex(/^.+:\d+$/).optional(),
    exact: z.boolean().default(false),
    symbol: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((query) => Boolean(query.line || query.path || query.symbol || query.text), {
    message: "Provide at least one of line, path, symbol, or text",
  });

const TimelineArgsSchema = z.object({
  path: z.string().optional(),
  symbol: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const evidenceJsonSchema = {
  type: "array",
  description: "Supporting references (commits, files, decisions, intents).",
  items: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["commit", "decision", "intent", "file", "symbol", "request", "agent_answer"],
      },
      value: { type: "string" },
      label: { type: "string" },
    },
    required: ["kind", "value"],
  },
} as const;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: MCP_TOOL_NAMES.announce,
    description:
      "Announce what you are about to change in this repo (summary, files, and the assumptions you are relying on). Other developers' agents are warned when their assumptions conflict with yours. Call this before starting significant work.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line summary of the planned change." },
        files: { type: "array", items: { type: "string" }, description: "Files or globs you plan to touch." },
        symbols: { type: "array", items: { type: "string" }, description: "Functions/classes involved." },
        assumptions: {
          type: "array",
          description: "Assumptions as key/value pairs, e.g. {key: \"auth.token_storage\", value: \"httpOnly-cookie\"}.",
          items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
          },
        },
      },
      required: ["summary"],
    },
  },
  {
    name: MCP_TOOL_NAMES.recordDecision,
    description:
      "Record an approved implementation decision against a Git commit. Store a concise summary and rationale, never a raw prompt.",
    inputSchema: {
      type: "object",
      properties: {
        commitSha: { type: "string", description: "Git commit SHA or ref, such as HEAD." },
        summary: { type: "string", description: "One-line description of the decision." },
        rationale: { type: "string", description: "Why this approach was chosen." },
        alternatives: { type: "array", items: { type: "string" } },
        assumptions: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
          },
        },
        files: { type: "array", items: { type: "string" } },
        symbols: { type: "array", items: { type: "string" } },
        evidence: evidenceJsonSchema,
        sourceRequestId: { type: "string" },
      },
      required: ["commitSha", "summary", "rationale"],
    },
  },
  {
    name: MCP_TOOL_NAMES.ask,
    description:
      "Ask another developer's agent a question about this repo (e.g. why something was built a certain way, or what they are working on). The recipient approves before any answer is produced; this can take a minute.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "The teammate's user id, e.g. \"joe\"." },
        text: { type: "string", description: "The question." },
        line: { type: "string", description: "Optional path:line. Lineage adds Git blame evidence so the recipient can match their exact originating prompt." },
        evidence: evidenceJsonSchema,
      },
      required: ["recipient"],
    },
  },
  {
    name: MCP_TOOL_NAMES.respond,
    description:
      "Choose how to handle a pending teammate question. Dispatch gives this active agent the approved historical context; manual sends the supplied text; reject declines it.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "The pending Lineage request id." },
        action: { type: "string", enum: ["dispatch", "manual", "reject"] },
        text: { type: "string", description: "Required for manual; optional rejection reason." },
      },
      required: ["requestId", "action"],
    },
  },
  {
    name: MCP_TOOL_NAMES.reply,
    description:
      "Answer an inbound question from another developer, identified by its requestId (see lineage_inbox or the <lineage_request> block in your prompt). Use this — not plain prose — so the answer reaches the asker.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "The id from the <lineage_request> block." },
        text: { type: "string", description: "Your answer." },
        quotedPrompt: {
          type: "string",
          description: "Exact originating prompt supplied in the approved lineage request. Copy it unchanged when present.",
        },
        evidence: evidenceJsonSchema,
      },
      required: ["requestId", "text"],
    },
  },
  {
    name: MCP_TOOL_NAMES.why,
    description:
      "Explain why code is the way it is: searches recorded decisions (linked to Git commits) by file path, symbol, or free text.",
    inputSchema: {
      type: "object",
      properties: {
        line: { type: "string", description: "Exact code location as path:line. Uses git blame and the private local prompt index." },
        exact: { type: "boolean", description: "Return the exact local prompt for the best match. Never reads another developer's prompt; use lineage_ask for that." },
        path: { type: "string", description: "File path to look up." },
        symbol: { type: "string", description: "Function/class name to look up." },
        text: { type: "string", description: "Free-text search." },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.timeline,
    description:
      "List recent intents and decisions for this repo (optionally filtered by path or symbol), newest first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        symbol: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.inbox,
    description:
      "List inbound questions from other developers waiting for this session, including their requestIds for lineage_reply.",
    inputSchema: { type: "object", properties: {} },
  },
];

function textResult(value: unknown, extraLines: string[] = []): ToolResult {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const text = extraLines.length ? `${body}\n\n${extraLines.join("\n")}` : body;
  return { content: [{ type: "text", text }] };
}

function resolveCommit(cwd: string, reference: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--verify", `${reference}^{commit}`], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Cannot resolve Git commit: ${reference}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

export function createTools(options: ToolsOptions) {
  const openRuntime =
    options.openRuntime ?? (() => openGitLineageRuntime(options.cwd));
  const openDaemon = options.openDaemon ?? (() => DaemonClient.open(options.cwd));

  function actor(): Actor {
    const provider = ProviderSchema.safeParse(options.env[LINEAGE_PROVIDER_ENV]);
    const sessionId = options.env[LINEAGE_SESSION_ID_ENV];
    return {
      userId: options.env[LINEAGE_USER_ID_ENV] ?? "unknown",
      ...(provider.success ? { provider: provider.data } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }

  /** Queued approved questions ride along on every tool result. */
  async function pendingQuestionFooter(): Promise<string[]> {
    try {
      const daemon = await openDaemon();
      const entries = await daemon.inbox();
      return entries
        .filter((entry) => entry.status === "approved_agent" && entry.rendered)
        .map(
          (entry) =>
            `A teammate's question is waiting for you — answer it with ${MCP_TOOL_NAMES.reply}:\n${entry.rendered}`,
        );
    } catch {
      return [];
    }
  }

  async function dispatch(name: string, args: unknown): Promise<ToolResult> {
    switch (name) {
      case MCP_TOOL_NAMES.announce: {
        const input = AnnounceArgsSchema.parse(args);
        const runtime = await openRuntime();
        try {
          const result = await runtime.core.announce({
            repoId: runtime.repoId,
            author: actor(),
            summary: input.summary,
            files: input.files,
            symbols: input.symbols,
            assumptions: input.assumptions,
          });
          let published = false;
          try {
            const daemon = await openDaemon();
            await daemon.publishIntent(result.intent);
            published = true;
          } catch {
            // Offline announce still records locally.
          }
          const warnings = result.conflicts.map(
            (conflict) =>
              `CONFLICT on "${conflict.key}": ${conflict.left.author.userId} assumes "${conflict.left.value}" but ${conflict.right.author.userId} assumes "${conflict.right.value}". Reconcile before committing.`,
          );
          if (!published) {
            warnings.push(
              "Note: the lineage daemon is not running, so teammates were not notified live.",
            );
          }
          return textResult(result, warnings);
        } finally {
          runtime.close();
        }
      }
      case MCP_TOOL_NAMES.ask: {
        const input = AskArgsSchema.parse(args);
        const evidence = [...input.evidence];
        if (input.line) {
          const trace = await traceCodeLine(options.cwd, input.line);
          evidence.push(
            { kind: "file", value: input.line },
            { kind: "commit", value: trace.commitSha, label: trace.summary },
          );
        }
        const daemon = await openDaemon();
        const answer = await daemon.ask({
          recipient: input.recipient,
          text: input.text ?? `Why was ${input.line} implemented this way? Return the originating exact prompt if your local history can match it.`,
          evidence,
        });
        return textResult(answer);
      }
      case MCP_TOOL_NAMES.recordDecision: {
        const input = RecordDecisionArgsSchema.parse(args);
        const runtime = await openRuntime();
        try {
          return textResult(await runtime.core.recordDecision({
            repoId: runtime.repoId,
            author: actor(),
            commitSha: resolveCommit(options.cwd, input.commitSha),
            summary: input.summary,
            rationale: input.rationale,
            alternatives: input.alternatives,
            assumptions: input.assumptions,
            files: input.files,
            symbols: input.symbols,
            evidence: input.evidence,
            ...(input.sourceRequestId ? { sourceRequestId: input.sourceRequestId } : {}),
          }));
        } finally {
          runtime.close();
        }
      }
      case MCP_TOOL_NAMES.reply: {
        const input = ReplyInputSchema.parse(args);
        const daemon = await openDaemon();
        await daemon.reply({ ...input, mode: "agent" });
        return textResult(`Answer delivered for request ${input.requestId}.`);
      }
      case MCP_TOOL_NAMES.respond: {
        const input = RespondInputSchema.parse(args);
        const daemon = await openDaemon();
        return textResult(await daemon.respond(input));
      }
      case MCP_TOOL_NAMES.why: {
        const input = WhyArgsSchema.parse(args);
        const runtime = await openRuntime();
        try {
          if (input.line) {
            const index = await loadPromptIndex();
            const result = await matchPromptsForLine(options.cwd, input.line, runtime.repoId, index.entries);
            const exactPrompt = input.exact && result.candidates[0]
              ? await readExactPrompt(result.candidates[0].entry)
              : undefined;
            return textResult({
              trace: result.trace,
              candidates: result.candidates.map(({ entry, ...candidate }) => ({
                ...candidate,
                provider: entry.provider,
                sessionId: entry.sessionId,
                timestamp: entry.timestamp,
              })),
              ...(exactPrompt ? { exactPrompt } : {}),
            });
          }
          return textResult(await runtime.core.why(input));
        } finally {
          runtime.close();
        }
      }
      case MCP_TOOL_NAMES.timeline: {
        const input = TimelineArgsSchema.parse(args);
        const runtime = await openRuntime();
        try {
          return textResult(await runtime.core.timeline(input));
        } finally {
          runtime.close();
        }
      }
      case MCP_TOOL_NAMES.inbox: {
        const daemon = await openDaemon();
        return textResult(await daemon.inbox());
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  }

  return {
    definitions: TOOL_DEFINITIONS,
    async call(name: string, args: unknown): Promise<ToolResult> {
      try {
        const result = await dispatch(name, args);
        if (
          name !== MCP_TOOL_NAMES.inbox &&
          name !== MCP_TOOL_NAMES.reply &&
          name !== MCP_TOOL_NAMES.respond
        ) {
          const footer = await pendingQuestionFooter();
          if (footer.length && result.content[0]) {
            result.content[0].text += `\n\n${footer.join("\n\n")}`;
          }
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    },
  };
}
