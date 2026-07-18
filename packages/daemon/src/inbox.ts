import type { Actor, AgentAnswer, AgentQuestion } from "@lineage/contracts";

export type InboxStatus = "pending" | "approved_agent" | "answered" | "rejected";

export interface InboxEntry {
  requestId: string;
  sender: Actor;
  question: AgentQuestion;
  receivedAt: string;
  status: InboxStatus;
  answer?: AgentAnswer;
  /** Held only in daemon memory after the developer approves agent access. */
  quotedPrompt?: string;
}

export class Inbox {
  private readonly entries = new Map<string, InboxEntry>();

  add(requestId: string, sender: Actor, question: AgentQuestion): InboxEntry {
    const entry: InboxEntry = {
      requestId,
      sender,
      question,
      receivedAt: new Date().toISOString(),
      status: "pending",
    };
    this.entries.set(requestId, entry);
    return entry;
  }

  get(requestId: string): InboxEntry | undefined {
    return this.entries.get(requestId);
  }

  list(): InboxEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt),
    );
  }

  open(): InboxEntry[] {
    return this.list().filter(
      (entry) => entry.status === "pending" || entry.status === "approved_agent",
    );
  }

  approveForAgent(requestId: string): InboxEntry {
    const entry = this.require(requestId);
    if (entry.status !== "pending") {
      throw new Error(`Request ${requestId} is ${entry.status}, not pending`);
    }
    entry.status = "approved_agent";
    return entry;
  }

  attachQuotedPrompt(requestId: string, quotedPrompt: string): InboxEntry {
    const entry = this.require(requestId);
    entry.quotedPrompt = quotedPrompt;
    return entry;
  }

  markAnswered(requestId: string, answer: AgentAnswer): InboxEntry {
    const entry = this.require(requestId);
    if (entry.status === "answered" || entry.status === "rejected") {
      throw new Error(`Request ${requestId} was already ${entry.status}`);
    }
    entry.status = "answered";
    entry.answer = answer;
    return entry;
  }

  markRejected(requestId: string): InboxEntry {
    const entry = this.require(requestId);
    if (entry.status === "answered" || entry.status === "rejected") {
      throw new Error(`Request ${requestId} was already ${entry.status}`);
    }
    entry.status = "rejected";
    return entry;
  }

  private require(requestId: string): InboxEntry {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error(`Unknown requestId: ${requestId}`);
    return entry;
  }
}
