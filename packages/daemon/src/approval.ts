import { renderInboundAgentRequest, type Actor, type InboundAgentRequest } from "@lineage/contracts";
import type { InboxEntry } from "./inbox";

/** Terminal I/O seam so tests can script the a/m/r flow. */
export interface ApprovalIo {
  print(line: string): void;
  prompt(question: string): Promise<string>;
}

export interface ApprovalOutcome {
  action: "agent" | "manual" | "reject";
  /** Manual answer text (action "manual") or optional reject reason. */
  text?: string;
}

export function toInboundRequest(entry: InboxEntry, recipient?: Actor): InboundAgentRequest {
  return {
    requestId: entry.requestId,
    sender: entry.sender,
    ...(recipient ? { recipient } : {}),
    question: entry.question,
    ...(entry.quotedPrompt ? { quotedPrompt: entry.quotedPrompt } : {}),
    ...(entry.localContext?.length ? { localContext: entry.localContext } : {}),
    ...(entry.repositoryAuthorship
      ? { repositoryAuthorship: entry.repositoryAuthorship }
      : {}),
  };
}

/**
 * Prompts the developer about one inbound question. Entries are processed
 * sequentially; `enqueue` chains onto the previous prompt.
 */
export class ApprovalQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly io: ApprovalIo,
    private readonly handle: (entry: InboxEntry, outcome: ApprovalOutcome) => Promise<void>,
  ) {}

  enqueue(entry: InboxEntry): void {
    this.chain = this.chain
      .then(() => this.promptFor(entry))
      .catch((error) => {
        this.io.print(
          `approval failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /** Resolves after every queued approval has been handled (for tests). */
  async idle(): Promise<void> {
    await this.chain;
  }

  private async promptFor(entry: InboxEntry): Promise<void> {
    const kind = entry.question.kind ?? "question";
    this.io.print("");
    this.io.print(`Incoming ${kind} from ${entry.sender.userId}:`);
    this.io.print(renderInboundAgentRequest(toInboundRequest(entry)));
    for (;;) {
      if (kind === "context") {
        const choice = (
          await this.io.prompt("[a]ccept into your agent session or [r]eject? ")
        ).trim().toLowerCase();
        if (choice === "a") {
          await this.handle(entry, { action: "agent" });
          return;
        }
        if (choice === "r") {
          const reason = (await this.io.prompt("Reason (optional): ")).trim();
          await this.handle(entry, { action: "reject", ...(reason ? { text: reason } : {}) });
          return;
        }
        this.io.print("Please answer a or r.");
        continue;
      }
      const choice = (
        await this.io.prompt("[a]sk your agent, answer [m]anually, or [r]eject? ")
      )
        .trim()
        .toLowerCase();
      if (choice === "a") {
        await this.handle(entry, { action: "agent" });
        return;
      }
      if (choice === "m") {
        const text = (await this.io.prompt("Your answer: ")).trim();
        if (!text) {
          this.io.print("Answer cannot be empty.");
          continue;
        }
        await this.handle(entry, { action: "manual", text });
        return;
      }
      if (choice === "r") {
        const reason = (await this.io.prompt("Reason (optional): ")).trim();
        await this.handle(entry, { action: "reject", ...(reason ? { text: reason } : {}) });
        return;
      }
      this.io.print("Please answer a, m, or r.");
    }
  }
}
