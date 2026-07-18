import { describe, expect, test, afterEach } from "bun:test";
import {
  PROTOCOL_VERSION,
  WireEnvelopeSchema,
  type Actor,
  type WireEnvelope,
} from "@lineage/contracts";
import { startRelay, type RelayHandle } from "./server";

const TOKEN = "room-secret";

function envelope(partial: Record<string, unknown>): WireEnvelope {
  return WireEnvelopeSchema.parse({
    version: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    repoId: "repo-1",
    sender: { userId: "alice", provider: "claude" },
    createdAt: new Date().toISOString(),
    ...partial,
  });
}

function hello(actor: Actor, repoId = "repo-1", roomToken = TOKEN): WireEnvelope {
  return envelope({ type: "hello", repoId, sender: actor, payload: { roomToken } });
}

class TestClient {
  readonly received: WireEnvelope[] = [];
  readonly closed: Promise<{ code: number }>;
  private waiters: Array<{
    predicate: (message: WireEnvelope) => boolean;
    resolve: (message: WireEnvelope) => void;
  }> = [];

  private constructor(readonly ws: WebSocket) {
    let resolveClosed: (value: { code: number }) => void;
    this.closed = new Promise((resolve) => (resolveClosed = resolve));
    ws.addEventListener("close", (event) => resolveClosed({ code: event.code }));
    ws.addEventListener("message", (event) => {
      const message = WireEnvelopeSchema.parse(JSON.parse(String(event.data)));
      this.received.push(message);
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter!.resolve(message);
      }
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });
    return new TestClient(ws);
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  next(
    predicate: (message: WireEnvelope) => boolean,
    timeoutMs = 2000,
  ): Promise<WireEnvelope> {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

let relay: RelayHandle | undefined;
const clients: TestClient[] = [];

afterEach(() => {
  for (const client of clients) client.close();
  clients.length = 0;
  relay?.stop();
  relay = undefined;
});

async function connect(url: string): Promise<TestClient> {
  const client = await TestClient.connect(url);
  clients.push(client);
  return client;
}

async function join(url: string, actor: Actor, repoId = "repo-1"): Promise<TestClient> {
  const client = await connect(url);
  const frame = hello(actor, repoId);
  client.send(frame);
  await client.next((m) => m.type === "ack" && m.payload.messageId === frame.id);
  return client;
}

describe("relay", () => {
  test("acks a valid hello and rejects a bad token", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const good = await connect(relay.url);
    const frame = hello({ userId: "alice" });
    good.send(frame);
    const ack = await good.next((m) => m.type === "ack");
    expect(ack.type === "ack" && ack.payload.messageId).toBe(frame.id);

    const bad = await connect(relay.url);
    bad.send(hello({ userId: "mallory" }, "repo-1", "wrong"));
    const error = await bad.next((m) => m.type === "error");
    expect(error.type === "error" && error.payload.code).toBe("invalid_token");
    const { code } = await bad.closed;
    expect(code).toBe(4001);
  });

  test("rejects unsupported protocol versions", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const client = await connect(relay.url);
    client.send({ ...hello({ userId: "alice" }), version: 2 });
    const error = await client.next((m) => m.type === "error");
    expect(error.type === "error" && error.payload.code).toBe("unsupported_version");
  });

  test("rejects non-JSON and malformed envelopes", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const garbage = await connect(relay.url);
    garbage.ws.send("not json{{{");
    const error1 = await garbage.next((m) => m.type === "error");
    expect(error1.type === "error" && error1.payload.code).toBe("unsupported_message_type");

    const malformed = await connect(relay.url);
    malformed.send({ version: 1, type: "mystery", payload: {} });
    const error2 = await malformed.next((m) => m.type === "error");
    expect(error2.type === "error" && error2.payload.code).toBe("unsupported_message_type");
  });

  test("requires hello before any routed message", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const client = await connect(relay.url);
    client.send(envelope({ type: "presence", payload: { status: "online" } }));
    const error = await client.next((m) => m.type === "error");
    expect(error.type === "error" && error.payload.code).toBe("invalid_token");
    await client.closed;
  });

  test("routes questions to the recipient in the same room only", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await join(relay.url, { userId: "alice", provider: "claude" });
    const bob = await join(relay.url, { userId: "bob", provider: "codex" });
    const stranger = await join(relay.url, { userId: "alice" }, "repo-2");

    const requestId = crypto.randomUUID();
    const ask = envelope({
      type: "question.ask",
      sender: { userId: "bob", provider: "codex" },
      recipient: "alice",
      requestId,
      payload: { text: "Why rotate refresh tokens?", evidence: [] },
    });
    bob.send(ask);

    const delivered = await alice.next((m) => m.type === "question.ask");
    expect(delivered.requestId).toBe(requestId);
    await bob.next((m) => m.type === "ack" && m.payload.messageId === ask.id);
    expect(stranger.received.filter((m) => m.type === "question.ask")).toHaveLength(0);
  });

  test("returns recipient_offline with the requestId when the target is absent", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const bob = await join(relay.url, { userId: "bob", provider: "codex" });
    const requestId = crypto.randomUUID();
    bob.send(
      envelope({
        type: "question.ask",
        sender: { userId: "bob", provider: "codex" },
        recipient: "ghost",
        requestId,
        payload: { text: "Anyone there?", evidence: [] },
      }),
    );
    const error = await bob.next((m) => m.type === "error");
    expect(error.type === "error" && error.payload.code).toBe("recipient_offline");
    expect(error.type === "error" && error.payload.requestId).toBe(requestId);
  });

  test("broadcasts intent.announce to the room but not the sender", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await join(relay.url, { userId: "alice", provider: "claude" });
    const bob = await join(relay.url, { userId: "bob", provider: "codex" });

    const intent = envelope({
      type: "intent.announce",
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
    alice.send(intent);
    const received = await bob.next((m) => m.type === "intent.announce");
    expect(received.id).toBe(intent.id);
    await alice.next((m) => m.type === "ack" && m.payload.messageId === intent.id);
    expect(alice.received.filter((m) => m.type === "intent.announce")).toHaveLength(0);
  });

  test("sends roster and presence transitions", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const alice = await join(relay.url, { userId: "alice", provider: "claude" });
    const bob = await join(relay.url, { userId: "bob", provider: "codex" });

    // Bob received no roster besides alice; alice is told bob is online.
    const joined = await alice.next(
      (m) => m.type === "presence" && m.sender.userId === "bob",
    );
    expect(joined.type === "presence" && joined.payload.status).toBe("online");
    const roster = await bob.next(
      (m) => m.type === "presence" && m.sender.userId === "alice",
    );
    expect(roster.type === "presence" && roster.payload.status).toBe("online");

    bob.close();
    const left = await alice.next(
      (m) =>
        m.type === "presence" &&
        m.sender.userId === "bob" &&
        m.payload.status === "offline",
    );
    expect(left.sender.userId).toBe("bob");
  });

  test("a reconnect replaces the previous socket for the same user", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const stale = await join(relay.url, { userId: "alice", provider: "claude" });
    const bob = await join(relay.url, { userId: "bob", provider: "codex" });
    const fresh = await join(relay.url, { userId: "alice", provider: "claude" });

    const { code } = await stale.closed;
    expect(code).toBe(4002);

    const requestId = crypto.randomUUID();
    bob.send(
      envelope({
        type: "question.ask",
        sender: { userId: "bob", provider: "codex" },
        recipient: "alice",
        requestId,
        payload: { text: "Still there?", evidence: [] },
      }),
    );
    const delivered = await fresh.next((m) => m.type === "question.ask");
    expect(delivered.requestId).toBe(requestId);
    expect(stale.received.filter((m) => m.type === "question.ask")).toHaveLength(0);
  });

  test("routes every fixture envelope type without dropping the connection", async () => {
    relay = startRelay({ port: 0, token: TOKEN });
    const fixtures = (await Bun.file(
      new URL("../../contracts/fixtures/wire.json", import.meta.url),
    ).json()) as WireEnvelope[];
    const alice = await join(relay.url, { userId: "alice", provider: "claude" });
    const bob = await join(relay.url, { userId: "bob", provider: "codex" });

    for (const fixture of fixtures) {
      if (fixture.type === "hello") continue; // already joined
      const sender = fixture.sender.userId === "bob" ? bob : alice;
      sender.send(fixture);
    }
    // question.ask fixture targets alice; answer/reject fixtures target bob.
    await alice.next((m) => m.type === "question.ask");
    await bob.next((m) => m.type === "question.answer");
    await bob.next((m) => m.type === "question.reject");
    await bob.next((m) => m.type === "intent.announce");
    expect(alice.ws.readyState).toBe(WebSocket.OPEN);
    expect(bob.ws.readyState).toBe(WebSocket.OPEN);
  });
});
