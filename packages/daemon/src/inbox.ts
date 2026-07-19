import type { Actor, AgentAnswer, AgentQuestion, RepositoryAuthorship } from "@lineage/contracts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  /** Held only in daemon memory after local context hooks run. */
  localContext?: string[];
  /** Computed from local Git metadata after dispatch approval; never persisted. */
  repositoryAuthorship?: RepositoryAuthorship;
}

function withoutPrivateContext(entry: InboxEntry): InboxEntry {
  const {
    quotedPrompt: _quotedPrompt,
    localContext: _localContext,
    repositoryAuthorship: _repositoryAuthorship,
    answer,
    ...safe
  } = entry;
  if (!answer) return safe;
  const { quotedPrompt: _answerPrompt, ...safeAnswer } = answer;
  return { ...safe, answer: safeAnswer };
}

export class Inbox {
  private readonly entries = new Map<string, InboxEntry>();

  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    try {
      const stored = JSON.parse(readFileSync(path, "utf8")) as InboxEntry[];
      for (const entry of stored) {
        const safe = withoutPrivateContext(entry);
        this.entries.set(
          safe.requestId,
          safe.status === "approved_agent" ? { ...safe, status: "pending" } : safe,
        );
      }
    } catch {
      // A damaged optional inbox must not prevent Lineage from starting.
    }
  }

  add(requestId: string, sender: Actor, question: AgentQuestion): InboxEntry {
    const entry: InboxEntry = {
      requestId,
      sender,
      question,
      receivedAt: new Date().toISOString(),
      status: "pending",
    };
    this.entries.set(requestId, entry);
    this.persist();
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
    this.persist();
    return entry;
  }

  attachQuotedPrompt(requestId: string, quotedPrompt: string): InboxEntry {
    const entry = this.require(requestId);
    entry.quotedPrompt = quotedPrompt;
    return entry;
  }

  attachLocalContext(requestId: string, localContext: string[]): InboxEntry {
    const entry = this.require(requestId);
    entry.localContext = localContext;
    return entry;
  }

  attachRepositoryAuthorship(
    requestId: string,
    repositoryAuthorship: RepositoryAuthorship,
  ): InboxEntry {
    const entry = this.require(requestId);
    entry.repositoryAuthorship = repositoryAuthorship;
    return entry;
  }

  markAnswered(requestId: string, answer: AgentAnswer): InboxEntry {
    const entry = this.require(requestId);
    if (entry.status === "answered" || entry.status === "rejected") {
      throw new Error(`Request ${requestId} was already ${entry.status}`);
    }
    entry.status = "answered";
    entry.answer = answer;
    this.persist();
    return entry;
  }

  markRejected(requestId: string): InboxEntry {
    const entry = this.require(requestId);
    if (entry.status === "answered" || entry.status === "rejected") {
      throw new Error(`Request ${requestId} was already ${entry.status}`);
    }
    entry.status = "rejected";
    this.persist();
    return entry;
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const safe = this.list().map(withoutPrivateContext);
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private require(requestId: string): InboxEntry {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error(`Unknown requestId: ${requestId}`);
    return entry;
  }
}
