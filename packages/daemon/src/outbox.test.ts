import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox } from "./outbox";
import { TransportError } from "@lineage/transport";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
  temporary.length = 0;
});

describe("Outbox", () => {
  test("tracks an asynchronous answer without persisting its exact prompt", () => {
    const directory = mkdtempSync(join(tmpdir(), "lineage-outbox-"));
    temporary.push(directory);
    const path = join(directory, "outbox.json");
    const outbox = new Outbox(path);
    outbox.add("request-1", "bob", { text: "Why cookies?", evidence: [] });
    outbox.markAnswered("request-1", {
      requestId: "request-1",
      mode: "agent",
      text: "Cookies work during SSR.",
      quotedPrompt: "Implement cookie auth for SSR",
      evidence: [],
    });

    expect(outbox.get("request-1")?.answer?.quotedPrompt).toBe("Implement cookie auth for SSR");
    const restored = new Outbox(path).get("request-1");
    expect(restored?.status).toBe("answered");
    expect(restored?.answer?.quotedPrompt).toBeUndefined();
  });

  test("records rejected and failed requests", () => {
    const outbox = new Outbox();
    outbox.add("rejected", "bob", { text: "Question", evidence: [] });
    outbox.markFailed("rejected", new TransportError("request_rejected", "Busy"));
    outbox.add("failed", "offline", { text: "Question", evidence: [] });
    outbox.markFailed("failed", new Error("offline is offline"));
    expect(outbox.get("rejected")?.status).toBe("rejected");
    expect(outbox.get("failed")?.status).toBe("failed");
  });

  test("marks accepted one-way context as delivered without an answer", () => {
    const outbox = new Outbox();
    outbox.add("context-1", "bob", {
      kind: "context",
      text: "I am changing the cart schema.",
      evidence: [],
    });
    outbox.markDelivered("context-1");
    expect(outbox.get("context-1")?.status).toBe("delivered");
    expect(outbox.get("context-1")?.answer).toBeUndefined();
  });

  test("marks an interrupted pending request failed after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "lineage-outbox-restart-"));
    temporary.push(directory);
    const path = join(directory, "outbox.json");
    new Outbox(path).add("request-1", "bob", { text: "Question", evidence: [] });
    const restored = new Outbox(path).get("request-1");
    expect(restored?.status).toBe("failed");
    expect(restored?.error).toContain("restarted");
  });
});
