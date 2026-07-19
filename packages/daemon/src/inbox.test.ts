import { describe, expect, test } from "bun:test";
import { Inbox } from "./inbox";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("persists per-user delivery state without persisting exact prompts", () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-inbox-"));
    const path = join(dir, "inbox.json");
    try {
      const inbox = new Inbox(path);
      inbox.add("request-1", SENDER, QUESTION);
      inbox.attachQuotedPrompt("request-1", "private originating prompt");
      inbox.attachLocalContext("request-1", ["private second-brain context"]);
      inbox.attachRepositoryAuthorship("request-1", {
        inspectedCommitCount: 1,
        recipientCommitCount: 0,
        recentRecipientCommits: [],
        referencedCommits: [],
      });
      inbox.approveForAgent("request-1");

      let restored = new Inbox(path);
      // Dispatch approval depended on memory-only prompt context, so a restart
      // safely asks again instead of pretending that context survived.
      expect(restored.get("request-1")?.status).toBe("pending");
      expect(restored.get("request-1")?.quotedPrompt).toBeUndefined();
      expect(restored.get("request-1")?.localContext).toBeUndefined();
      expect(restored.get("request-1")?.repositoryAuthorship).toBeUndefined();

      inbox.markAnswered("request-1", {
        requestId: "request-1",
        mode: "agent",
        text: "Approved answer",
        quotedPrompt: "private originating prompt",
        evidence: [],
      });
      restored = new Inbox(path);
      expect(restored.get("request-1")?.answer?.quotedPrompt).toBeUndefined();
      expect(readFileSync(path, "utf8")).not.toContain("private originating prompt");
      expect(readFileSync(path, "utf8")).not.toContain("private second-brain context");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
