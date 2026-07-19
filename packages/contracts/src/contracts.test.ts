import { describe, expect, test } from "bun:test";
import domainFixture from "../fixtures/domain.json";
import wireFixtures from "../fixtures/wire.json";
import {
  ActorSchema,
  DecisionRecordSchema,
  IntentRecordSchema,
  PROTOCOL_VERSION,
  WireEnvelopeSchema,
  renderInboundAgentRequest,
} from "./index";
import { MockLineageCore, MockLineageTransport } from "./testing";

describe("shared contract fixtures", () => {
  test("domain fixtures parse", () => {
    expect(ActorSchema.parse(domainFixture.actor).userId).toBe("alice");
    expect(IntentRecordSchema.parse(domainFixture.intent).status).toBe("active");
    expect(DecisionRecordSchema.parse(domainFixture.decision).evidence).toHaveLength(1);
  });

  test("every wire message type has a valid fixture", () => {
    const parsed = wireFixtures.map((fixture) => WireEnvelopeSchema.parse(fixture));
    expect(new Set(parsed.map((message) => message.type))).toEqual(
      new Set([
        "hello",
        "presence",
        "intent.announce",
        "question.ask",
        "question.answer",
        "question.reject",
        "ack",
        "error",
      ]),
    );
    expect(parsed.every((message) => message.version === PROTOCOL_VERSION)).toBeTrue();
  });

  test("rejects mismatched correlation and repository identifiers", () => {
    const answer = structuredClone(wireFixtures[4]!);
    answer.payload.requestId = "different-request";
    expect(() => WireEnvelopeSchema.parse(answer)).toThrow();

    const intent = structuredClone(wireFixtures[2]!);
    intent.payload.repoId = "different-repo";
    expect(() => WireEnvelopeSchema.parse(intent)).toThrow();
  });

  test("renders the provider-neutral agent injection contract", () => {
    const prompt = renderInboundAgentRequest({
      requestId: "request-1",
      sender: { userId: "bob", provider: "codex" },
      recipient: { userId: "alice", provider: "claude" },
      question: {
        text: "Why rotate refresh tokens?",
        evidence: [{ kind: "file", value: "src/auth.ts" }],
      },
      localContext: ["The service must support server rendering."],
    });
    expect(prompt).toContain('<lineage_request id="request-1" from="bob" to="alice">');
    expect(prompt).toContain('You are answering as Lineage user "alice"');
    expect(prompt).toContain("Do not claim repository work as alice's");
    expect(prompt).toContain("lineage_reply");
    expect(prompt).toContain("file: src/auth.ts");
    expect(prompt).toContain("<local_context>The service must support server rendering.</local_context>");
  });

  test("allows exact prompts only in transient answers", () => {
    const answer = WireEnvelopeSchema.parse(wireFixtures[4]);
    expect(answer.type).toBe("question.answer");
    if (answer.type !== "question.answer") throw new Error("Expected answer fixture");
    expect(answer.payload.quotedPrompt).toContain("rotating refresh tokens");

    const decisionWithPrompt = {
      ...domainFixture.decision,
      quotedPrompt: "this must not become durable",
    };
    const persisted = DecisionRecordSchema.parse(decisionWithPrompt);
    expect("quotedPrompt" in persisted).toBeFalse();
  });
});

describe("consumer mocks", () => {
  test("MockLineageCore records calls", async () => {
    const core = new MockLineageCore();
    await core.why({ text: "rotation" });
    expect(core.calls).toEqual([
      { method: "why", input: { text: "rotation" } },
    ]);
  });

  test("MockLineageTransport publishes and emits", async () => {
    const transport = new MockLineageTransport();
    const message = WireEnvelopeSchema.parse(wireFixtures[1]);
    let received = false;
    transport.subscribe(() => {
      received = true;
    });
    const ack = await transport.publish(message);
    await transport.emit(message);
    expect(ack.delivered).toBeTrue();
    expect(received).toBeTrue();
  });
});
