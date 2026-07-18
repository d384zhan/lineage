import { afterEach, describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  type Actor,
  type ConnectionConfig,
  type WireEnvelope,
} from "@lineage/contracts";
import { startRelay, type RelayHandle } from "@lineage/relay";
import { TransportError } from "./errors";
import { WebSocketLineageTransport, type TransportOptions } from "./ws-transport";

const TOKEN = "room-secret";

let relay: RelayHandle | undefined;
const transports: WebSocketLineageTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.map((transport) => transport.close()));
  transports.length = 0;
  relay?.stop();
  relay = undefined;
});

function config(actor: Actor, overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    relayUrl: relay!.url,
    repoId: "repo-1",
    roomToken: TOKEN,
    actor,
    ...overrides,
  };
}

async function connected(
  actor: Actor,
  options: TransportOptions = {},
  overrides: Partial<ConnectionConfig> = {},
): Promise<WebSocketLineageTransport> {
  const transport = new WebSocketLineageTransport(options);
  transports.push(transport);
  await transport.connect(config(actor, overrides));
  return transport;
}

function presenceEnvelope(actor: Actor): WireEnvelope {
  return {
    version: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    repoId: "repo-1",
    type: "presence",
    sender: actor,
    createdAt: new Date().toISOString(),
    payload: { status: "busy" },
  };
}

describe("WebSocketLineageTransport", () => {
  test("connect succeeds with a valid token and fails with a bad one", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    await connected({ userId: "alice", provider: "claude" });

    // NOTE: socket-driven rejections are asserted via try/catch, not
    // expect().rejects — awaiting expect().rejects starves the client
    // WebSocket message events under bun test on Windows.
    const bad = new WebSocketLineageTransport({ ackTimeoutMs: 500 });
    transports.push(bad);
    const error = await bad
      .connect(config({ userId: "mallory" }, { roomToken: "wrong" }))
      .then(() => undefined)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
  });

  test("publish resolves with the relay ack", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await connected({ userId: "alice", provider: "claude" });
    const envelope = presenceEnvelope({ userId: "alice", provider: "claude" });
    const ack = await alice.publish(envelope);
    expect(ack.messageId).toBe(envelope.id);
    expect(ack.delivered).toBeTrue();
  });

  test("ask resolves when the recipient answers with the same requestId", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await connected({ userId: "alice", provider: "claude" });
    const bob = await connected({ userId: "bob", provider: "codex" });

    bob.subscribe(async (message) => {
      if (message.type !== "question.ask") return;
      await bob.publish({
        version: PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        repoId: "repo-1",
        type: "question.answer",
        sender: { userId: "bob", provider: "codex" },
        recipient: message.sender.userId,
        requestId: message.requestId,
        createdAt: new Date().toISOString(),
        payload: {
          requestId: message.requestId,
          mode: "manual",
          text: "Rotation limits replay.",
          evidence: [{ kind: "file", value: "src/auth.ts" }],
        },
      });
    });

    const answer = await alice.ask({ recipient: "bob", text: "Why rotate refresh tokens?" });
    expect(answer.mode).toBe("manual");
    expect(answer.text).toBe("Rotation limits replay.");
    expect(answer.evidence).toHaveLength(1);
  });

  test("ask rejects with request_rejected when the recipient declines", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await connected({ userId: "alice", provider: "claude" });
    const bob = await connected({ userId: "bob", provider: "codex" });

    bob.subscribe(async (message) => {
      if (message.type !== "question.ask") return;
      await bob.publish({
        version: PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        repoId: "repo-1",
        type: "question.reject",
        sender: { userId: "bob", provider: "codex" },
        recipient: message.sender.userId,
        requestId: message.requestId,
        createdAt: new Date().toISOString(),
        payload: { reason: "Busy right now" },
      });
    });

    const error = await alice
      .ask({ recipient: "bob", text: "Got a minute?" })
      .then(() => undefined)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("request_rejected");
    expect((error as TransportError).message).toBe("Busy right now");
  });

  test("ask rejects promptly with recipient_offline for absent users", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await connected({ userId: "alice", provider: "claude" });
    const startedAt = Date.now();
    const error = await alice
      .ask({ recipient: "ghost", text: "Anyone home?" })
      .then(() => undefined)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("recipient_offline");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("ask times out with request_timeout when nobody answers", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await connected({ userId: "alice", provider: "claude" }, { askTimeoutMs: 250 });
    await connected({ userId: "bob", provider: "codex" });
    const error = await alice
      .ask({ recipient: "bob", text: "Hello?" })
      .then(() => undefined)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("request_timeout");
  });

  test("subscribers receive broadcast intents", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await connected({ userId: "alice", provider: "claude" });
    const bob = await connected({ userId: "bob", provider: "codex" });

    const seen = new Promise<WireEnvelope>((resolve) => {
      bob.subscribe((message) => {
        if (message.type === "intent.announce") resolve(message);
      });
    });
    await alice.publish({
      version: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      repoId: "repo-1",
      type: "intent.announce",
      sender: { userId: "alice", provider: "claude" },
      createdAt: new Date().toISOString(),
      payload: {
        id: "intent-1",
        repoId: "repo-1",
        author: { userId: "alice", provider: "claude" },
        summary: "Implement token refresh",
        files: ["src/auth.ts"],
        symbols: [],
        assumptions: [{ key: "auth.token_storage", value: "httpOnly-cookie" }],
        status: "active",
        createdAt: new Date().toISOString(),
      },
    });
    const message = await seen;
    expect(message.type).toBe("intent.announce");
  });

  test("reconnects after a relay restart and keeps working", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const port = relay.port;
    const alice = await connected(
      { userId: "alice", provider: "claude" },
      { initialBackoffMs: 50, maxBackoffMs: 200 },
    );

    relay.stop();
    relay = undefined;
    await Bun.sleep(100);
    relay = startRelay({ port, token: TOKEN });

    // Wait for the transport to re-join, then publish successfully.
    let ackReceived = false;
    for (let attempt = 0; attempt < 30 && !ackReceived; attempt += 1) {
      await Bun.sleep(100);
      try {
        await alice.publish(presenceEnvelope({ userId: "alice", provider: "claude" }));
        ackReceived = true;
      } catch {
        // Not reconnected yet.
      }
    }
    expect(ackReceived).toBeTrue();
  });
});
