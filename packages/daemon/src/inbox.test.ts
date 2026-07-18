import { describe, expect, test } from "bun:test";
import { Inbox } from "./inbox";

const SENDER = { userId: "bob", provider: "codex" as const };
const QUESTION = { text: "Why rotate refresh tokens?", evidence: [] };

describe("Inbox", () => {
  test("tracks pending → approved_agent → answered transitions", () => {
    const inbox = new Inbox();
    const entry = inbox.add("request-1", SENDER, QUESTION);
    expect(entry.status).toBe("pending");
    expect(inbox.open()).toHaveLength(1);

    inbox.approveForAgent("request-1");
    expect(inbox.get("request-1")!.status).toBe("approved_agent");
    expect(inbox.open()).toHaveLength(1);

    const answer = {
      requestId: "request-1",
      mode: "agent" as const,
      text: "Rotation limits replay.",
      evidence: [],
    };
    inbox.markAnswered("request-1", answer);
    expect(inbox.get("request-1")!.status).toBe("answered");
    expect(inbox.get("request-1")!.answer).toEqual(answer);
    expect(inbox.open()).toHaveLength(0);
  });

  test("rejects settle the entry and cannot be answered afterwards", () => {
    const inbox = new Inbox();
    inbox.add("request-1", SENDER, QUESTION);
    inbox.markRejected("request-1");
    expect(inbox.get("request-1")!.status).toBe("rejected");
    expect(() =>
      inbox.markAnswered("request-1", {
        requestId: "request-1",
        mode: "manual",
        text: "too late",
        evidence: [],
      }),
    ).toThrow("already rejected");
  });

  test("cannot approve a non-pending entry or touch unknown ids", () => {
    const inbox = new Inbox();
    inbox.add("request-1", SENDER, QUESTION);
    inbox.approveForAgent("request-1");
    expect(() => inbox.approveForAgent("request-1")).toThrow("not pending");
    expect(() => inbox.markRejected("nope")).toThrow("Unknown requestId");
  });
});
