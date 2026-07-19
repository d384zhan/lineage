import type { AgentAnswer, AgentQuestion } from "@lineage/contracts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type OutboxStatus = "pending" | "answered" | "rejected" | "failed";

export interface OutboxEntry {
  requestId: string;
  recipient: string;
  question: AgentQuestion;
  createdAt: string;
  status: OutboxStatus;
  answer?: AgentAnswer;
  error?: string;
}

function safeEntry(entry: OutboxEntry): OutboxEntry {
  if (!entry.answer?.quotedPrompt) return entry;
  const { quotedPrompt: _quotedPrompt, ...answer } = entry.answer;
  return { ...entry, answer };
}

export class Outbox {
  private readonly entries = new Map<string, OutboxEntry>();

  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    try {
      const stored = JSON.parse(readFileSync(path, "utf8")) as OutboxEntry[];
      for (const entry of stored) {
        this.entries.set(
          entry.requestId,
          entry.status === "pending"
            ? { ...entry, status: "failed", error: "Lineage restarted before an answer arrived" }
            : entry,
        );
      }
    } catch {
      // A damaged optional outbox must not prevent Lineage from starting.
    }
  }

  add(requestId: string, recipient: string, question: AgentQuestion): OutboxEntry {
    const entry: OutboxEntry = {
      requestId,
      recipient,
      question,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    this.entries.set(requestId, entry);
    this.persist();
    return entry;
  }

  get(requestId: string): OutboxEntry | undefined {
    return this.entries.get(requestId);
  }

  list(): OutboxEntry[] {
    return [...this.entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  markAnswered(requestId: string, answer: AgentAnswer): OutboxEntry {
    const entry = this.require(requestId);
    entry.status = "answered";
    entry.answer = answer;
    delete entry.error;
    this.persist();
    return entry;
  }

  markFailed(requestId: string, error: unknown): OutboxEntry {
    const entry = this.require(requestId);
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    entry.status = code === "request_rejected" ? "rejected" : "failed";
    entry.error = message;
    this.persist();
    return entry;
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.list().map(safeEntry), null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private require(requestId: string): OutboxEntry {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error(`Unknown outgoing requestId: ${requestId}`);
    return entry;
  }
}
