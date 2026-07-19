import {
  renderInboundAgentRequest,
  type Actor,
  type AgentQuestion,
  type AskInput,
  type LineageTransport,
  type RespondInput,
  type WireEnvelope,
} from "@lineage/contracts";
import { join } from "node:path";
import { openGitLineageRuntime } from "@lineage/git-store";
import {
  lineSpecFromEvidence,
  matchPromptsForLine,
  readExactPrompt,
  refreshPromptIndex,
  type RefreshIndexOptions,
} from "@lineage/prompt-index";
import { WebSocketLineageTransport } from "@lineage/transport";
import { createSubAgentAnswerer, type AgentAnswerer } from "./agent-answerer";
import { ApprovalQueue, type ApprovalIo, type ApprovalOutcome, toInboundRequest } from "./approval";
import {
  deleteDaemonInfo,
  INBOX_FILE,
  OUTBOX_FILE,
  readNetworkSettings,
  readRepoId,
  resolveStateDir,
  writeDaemonInfo,
  type NetworkSettings,
} from "./files";
import {
  buildEnvelope,
  publishAnswer,
  startHttpApi,
  type RuntimeOpener,
} from "./http";
import { Inbox, type InboxEntry } from "./inbox";
import { Outbox } from "./outbox";

export interface DaemonOptions {
  cwd: string;
  io: ApprovalIo;
  transport?: LineageTransport;
  openRuntime?: RuntimeOpener;
  answerer?: AgentAnswerer;
  stateDir?: string;
  repoId?: string;
  network?: NetworkSettings;
  httpPort?: number;
  resolvePrompt?: PromptResolver;
  promptIndexOptions?: RefreshIndexOptions;
  /** Terminal keeps the legacy a/m/r prompt; external lets the active agent handle it. */
  approvalMode?: "terminal" | "external";
}

export type PromptResolver = (question: AgentQuestion) => Promise<string | undefined>;

export interface DaemonHandle {
  port: number;
  secret: string;
  actor: Actor;
  repoId: string;
  inbox: Inbox;
  outbox: Outbox;
  approvals: ApprovalQueue;
  stop(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const io = options.io;
  const stateDir = resolveStateDir(options.cwd, options.stateDir);
  const repoId = options.repoId ?? (await readRepoId(options.cwd));
  const network = options.network ?? (await readNetworkSettings(stateDir));
  if (!network) {
    throw new Error("No relay connection configured. Run `lineage join` first.");
  }
  const actor: Actor = {
    userId: network.userId,
    ...(network.provider ? { provider: network.provider } : {}),
  };
  const transport =
    options.transport ?? new WebSocketLineageTransport({ log: (line) => io.print(line) });
  const openRuntime: RuntimeOpener =
    options.openRuntime ?? (() => openGitLineageRuntime(options.cwd));
  const inbox = new Inbox(join(stateDir, INBOX_FILE));
  const outbox = new Outbox(join(stateDir, OUTBOX_FILE));
  const answerer =
    options.answerer ??
    createSubAgentAnswerer({
      cwd: options.cwd,
      userId: network.userId,
      provider: network.provider,
      print: io.print,
    });
  const resolvePrompt: PromptResolver = options.resolvePrompt ?? (async (question) => {
    const spec = lineSpecFromEvidence(question.evidence);
    if (!spec) return undefined;
    const index = await refreshPromptIndex(options.promptIndexOptions);
    const result = await matchPromptsForLine(options.cwd, spec, repoId, index.entries);
    const candidate = result.candidates[0];
    const runnerUp = result.candidates[1];
    if (!candidate || candidate.confidence !== "high") return undefined;
    if (runnerUp && candidate.score - runnerUp.score < 10) return undefined;
    return candidate ? readExactPrompt(candidate.entry) : undefined;
  });

  async function approveForAgent(entry: InboxEntry) {
    try {
      const quotedPrompt = await resolvePrompt(entry.question);
      if (quotedPrompt) {
        inbox.attachQuotedPrompt(entry.requestId, quotedPrompt);
        io.print("Matched an exact local prompt. It will be shared only in this approved answer.");
      } else if (lineSpecFromEvidence(entry.question.evidence)) {
        io.print("No high-confidence local prompt matched this line; the agent will answer from repo history.");
      }
    } catch (error) {
      io.print(`prompt lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    inbox.approveForAgent(entry.requestId);
    return toInboundRequest(entry);
  }

  async function handleApproval(entry: InboxEntry, outcome: ApprovalOutcome): Promise<void> {
    if (outcome.action === "agent") {
      const request = await approveForAgent(entry);
      // The sub-agent may take a minute; answer flows back via /reply.
      // Do not block the approval queue on it.
      answerer({ request }).catch((error) => {
        io.print(
          `agent answer failed for ${entry.requestId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return;
    }
    if (outcome.action === "manual") {
      const answer = {
        requestId: entry.requestId,
        mode: "manual" as const,
        text: outcome.text!,
        evidence: [],
      };
      await publishAnswer(transport, repoId, actor, entry.sender.userId, answer);
      inbox.markAnswered(entry.requestId, answer);
      io.print(`Answered ${entry.sender.userId} manually.`);
      return;
    }
    await transport.publish(
      buildEnvelope(repoId, actor, {
        type: "question.reject",
        recipient: entry.sender.userId,
        requestId: entry.requestId,
        payload: outcome.text ? { reason: outcome.text } : {},
      }),
    );
    inbox.markRejected(entry.requestId);
    io.print(`Rejected question from ${entry.sender.userId}.`);
  }

  async function respond(input: RespondInput): Promise<unknown> {
    const entry = inbox.get(input.requestId);
    if (!entry) throw new Error(`Unknown requestId: ${input.requestId}`);
    if (entry.status !== "pending") {
      throw new Error(`Request ${input.requestId} is ${entry.status}, not pending`);
    }
    if (input.action === "dispatch") {
      const request = await approveForAgent(entry);
      return {
        action: "dispatch",
        request,
        rendered: renderInboundAgentRequest(request),
      };
    }
    await handleApproval(entry, {
      action: input.action,
      ...(input.text ? { text: input.text } : {}),
    });
    return { action: input.action, requestId: input.requestId };
  }

  function askAsync(input: AskInput) {
    const requestId = crypto.randomUUID();
    const question: AgentQuestion = { text: input.text, evidence: input.evidence ?? [] };
    outbox.add(requestId, input.recipient, question);
    void transport.ask(input, requestId).then(
      (answer) => {
        outbox.markAnswered(requestId, answer);
        io.print(`answer ready from ${input.recipient}: ${requestId}`);
      },
      (error) => {
        outbox.markFailed(requestId, error);
        io.print(`question to ${input.recipient} failed: ${requestId}`);
      },
    );
    return { requestId, status: "pending" as const };
  }

  const approvals = new ApprovalQueue(io, handleApproval);

  async function handleMessage(message: WireEnvelope): Promise<void> {
    if (message.sender.userId === actor.userId) return;
    switch (message.type) {
      case "intent.announce": {
        io.print(
          `${message.payload.author.userId} announced: ${message.payload.summary}`,
        );
        const runtime = await openRuntime();
        try {
          const conflicts = await runtime.core.ingestRemoteIntent(message.payload);
          for (const conflict of conflicts) {
            io.print("");
            io.print(`!! ASSUMPTION CONFLICT on "${conflict.key}"`);
            io.print(
              `   ${conflict.left.author.userId} assumes "${conflict.left.value}" (intent ${conflict.left.intentId})`,
            );
            io.print(
              `   ${conflict.right.author.userId} assumes "${conflict.right.value}" (intent ${conflict.right.intentId})`,
            );
            io.print("   Talk before you both commit: lineage ask <user> \"...\"");
          }
        } finally {
          runtime.close();
        }
        return;
      }
      case "question.ask": {
        const entry = inbox.add(message.requestId, message.sender, message.payload);
        if ((options.approvalMode ?? "terminal") === "terminal") {
          approvals.enqueue(entry);
        } else {
          io.print(`question queued from ${entry.sender.userId}: ${entry.requestId}`);
        }
        return;
      }
      case "presence":
        io.print(`${message.sender.userId} is ${message.payload.status}`);
        return;
      case "error":
        if (!message.payload.requestId) {
          io.print(`relay error: ${message.payload.code} — ${message.payload.message}`);
        }
        return;
      default:
        return;
    }
  }

  await transport.connect({
    relayUrl: network.relayUrl,
    repoId,
    roomToken: network.roomToken,
    actor,
  });
  const unsubscribe = transport.subscribe(handleMessage);

  const secret = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let server: ReturnType<typeof startHttpApi>;
  try {
    server = startHttpApi({
      port: options.httpPort ?? 0,
      secret,
      actor,
      repoId,
      inbox,
      outbox,
      transport,
      openRuntime,
      startedAt,
      respond,
      askAsync,
    });
  } catch (error) {
    unsubscribe();
    await transport.close();
    throw error;
  }
  const port = server.port!;
  await writeDaemonInfo(stateDir, { port, pid: process.pid, secret, startedAt });
  io.print(`lineage daemon ready — user ${actor.userId}, room ${repoId}, port ${port}`);

  return {
    port,
    secret,
    actor,
    repoId,
    inbox,
    outbox,
    approvals,
    stop: async () => {
      unsubscribe();
      server.stop(true);
      await transport.close();
      deleteDaemonInfo(stateDir);
    },
  };
}
