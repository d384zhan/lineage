import type { Actor, LineageTransport, WireEnvelope } from "@lineage/contracts";
import { openGitLineageRuntime } from "@lineage/git-store";
import { WebSocketLineageTransport } from "@lineage/transport";
import { createSubAgentAnswerer, type AgentAnswerer } from "./agent-answerer";
import { ApprovalQueue, type ApprovalIo, type ApprovalOutcome, toInboundRequest } from "./approval";
import {
  deleteDaemonInfo,
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
}

export interface DaemonHandle {
  port: number;
  secret: string;
  actor: Actor;
  repoId: string;
  inbox: Inbox;
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
  const inbox = new Inbox();
  const answerer =
    options.answerer ??
    createSubAgentAnswerer({
      cwd: options.cwd,
      userId: network.userId,
      provider: network.provider,
      print: io.print,
    });

  async function handleApproval(entry: InboxEntry, outcome: ApprovalOutcome): Promise<void> {
    if (outcome.action === "agent") {
      inbox.approveForAgent(entry.requestId);
      // The sub-agent may take a minute; answer flows back via /reply.
      // Do not block the approval queue on it.
      answerer({ request: toInboundRequest(entry) }).catch((error) => {
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
        approvals.enqueue(entry);
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
      transport,
      openRuntime,
      startedAt,
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
    approvals,
    stop: async () => {
      unsubscribe();
      server.stop(true);
      await transport.close();
      deleteDaemonInfo(stateDir);
    },
  };
}
