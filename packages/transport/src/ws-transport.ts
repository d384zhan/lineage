import {
  AskInputSchema,
  ConnectionConfigSchema,
  PROTOCOL_VERSION,
  WireEnvelopeSchema,
  type Ack,
  type AgentAnswer,
  type AskInput,
  type ConnectionConfig,
  type LineageTransport,
  type MessageHandler,
  type WireEnvelope,
} from "@lineage/contracts";
import { TransportError } from "./errors";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  const state = { settled: false } as Deferred<T>;
  state.promise = new Promise<T>((resolve, reject) => {
    state.resolve = (value) => {
      state.settled = true;
      resolve(value);
    };
    state.reject = (error) => {
      state.settled = true;
      reject(error);
    };
  });
  return state;
}

export interface TransportOptions {
  ackTimeoutMs?: number;
  askTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  log?: (line: string) => void;
}

export class WebSocketLineageTransport implements LineageTransport {
  private ws: WebSocket | undefined;
  private config: ConnectionConfig | undefined;
  private closedByUser = false;
  private everConnected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingAcks = new Map<string, Deferred<Ack>>();
  private readonly pendingAsks = new Map<string, Deferred<AgentAnswer>>();
  private readonly handlers = new Set<MessageHandler>();
  private readonly ackTimeoutMs: number;
  private readonly askTimeoutMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly log: (line: string) => void;

  constructor(options: TransportOptions = {}) {
    // Initial host approval may involve a human. Normal acks still arrive immediately.
    this.ackTimeoutMs = options.ackTimeoutMs ?? 120_000;
    this.askTimeoutMs = options.askTimeoutMs ?? 120_000;
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 8_000;
    this.log = options.log ?? (() => {});
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.config = ConnectionConfigSchema.parse(config);
    this.closedByUser = false;
    await this.open();
  }

  async publish(message: WireEnvelope): Promise<Ack> {
    const envelope = WireEnvelopeSchema.parse(message);
    return await this.sendWithAck(envelope);
  }

  async ask(input: AskInput, suppliedRequestId?: string): Promise<AgentAnswer> {
    const parsed = AskInputSchema.parse(input);
    const requestId = suppliedRequestId ?? crypto.randomUUID();
    const answer = deferred<AgentAnswer>();
    const timer = setTimeout(() => {
      this.pendingAsks.delete(requestId);
      answer.reject(
        new TransportError("request_timeout", `No answer within ${this.askTimeoutMs}ms`),
      );
    }, this.askTimeoutMs);
    answer.promise.finally(() => clearTimeout(timer)).catch(() => {});
    this.pendingAsks.set(requestId, answer);

    const envelope = this.buildEnvelope({
      type: "question.ask",
      recipient: parsed.recipient,
      requestId,
      payload: {
        kind: parsed.kind,
        sourceSessionId: parsed.sourceSessionId,
        text: parsed.text,
        evidence: parsed.evidence ?? [],
      },
    });
    const routed = this.sendWithAck(envelope);
    routed.catch(() => {});
    // Wait until the relay acks the routing or the ask settles early
    // (e.g. a recipient_offline error correlated by requestId).
    await Promise.race([routed, answer.promise.catch(() => undefined)]);
    if (!answer.settled) {
      try {
        await routed;
      } catch (error) {
        this.pendingAsks.delete(requestId);
        clearTimeout(timer);
        throw error;
      }
    }
    return await answer.promise;
  }

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.failPending(new TransportError("request_timeout", "Transport closed"));
    this.ws?.close();
    this.ws = undefined;
  }

  private buildEnvelope(
    partial:
      | { type: "hello"; payload: { roomToken: string; accessToken?: string } }
      | {
          type: "question.ask";
          recipient: string;
          requestId: string;
          payload: unknown;
        },
  ): WireEnvelope {
    const config = this.requireConfig();
    return WireEnvelopeSchema.parse({
      version: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      repoId: config.repoId,
      sender: config.actor,
      createdAt: new Date().toISOString(),
      ...partial,
    });
  }

  private requireConfig(): ConnectionConfig {
    if (!this.config) throw new Error("Transport is not connected");
    return this.config;
  }

  private async open(): Promise<void> {
    const config = this.requireConfig();
    const ws = new WebSocket(config.relayUrl);
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      if (this.ws === ws) this.handleFrame(String(event.data));
    });
    ws.addEventListener("close", () => this.handleClose(ws));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () =>
        reject(new Error(`Could not reach relay at ${config.relayUrl}`)),
      );
    });
    const hello = this.buildEnvelope({
      type: "hello",
      payload: {
        roomToken: config.roomToken,
        ...(config.accessToken ? { accessToken: config.accessToken } : {}),
      },
    });
    await this.sendWithAck(hello);
    this.everConnected = true;
    this.reconnectAttempt = 0;
    this.log(`connected to ${config.relayUrl} as ${config.actor.userId}`);
  }

  private sendWithAck(envelope: WireEnvelope): Promise<Ack> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Transport connection is not open"));
    }
    const ack = deferred<Ack>();
    const timer = setTimeout(() => {
      this.pendingAcks.delete(envelope.id);
      ack.reject(
        new TransportError("request_timeout", `Relay did not ack within ${this.ackTimeoutMs}ms`),
      );
    }, this.ackTimeoutMs);
    ack.promise.finally(() => clearTimeout(timer)).catch(() => {});
    this.pendingAcks.set(envelope.id, ack);
    ws.send(JSON.stringify(envelope));
    return ack.promise;
  }

  private handleFrame(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log("dropped non-JSON frame");
      return;
    }
    const result = WireEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      this.log("dropped invalid envelope");
      return;
    }
    const message = result.data;

    if (message.type === "ack") {
      const pending = this.pendingAcks.get(message.payload.messageId);
      if (pending) {
        this.pendingAcks.delete(message.payload.messageId);
        pending.resolve(message.payload);
      }
      return;
    }

    if (message.type === "question.answer") {
      const pending = this.pendingAsks.get(message.requestId);
      if (pending) {
        this.pendingAsks.delete(message.requestId);
        pending.resolve(message.payload);
      }
    } else if (message.type === "question.reject") {
      const pending = this.pendingAsks.get(message.requestId);
      if (pending) {
        this.pendingAsks.delete(message.requestId);
        pending.reject(
          new TransportError(
            "request_rejected",
            message.payload.reason ?? "Question was rejected",
          ),
        );
      }
    } else if (message.type === "error") {
      const requestId = message.payload.requestId;
      const pending = requestId ? this.pendingAsks.get(requestId) : undefined;
      if (pending && requestId) {
        this.pendingAsks.delete(requestId);
        pending.reject(new TransportError(message.payload.code, message.payload.message));
      } else if (!requestId) {
        // Uncorrelated errors are fatal to in-flight publishes.
        this.failPendingAcks(
          new TransportError(message.payload.code, message.payload.message),
        );
      }
    }

    for (const handler of this.handlers) {
      Promise.resolve(handler(message)).catch((error) =>
        this.log(`subscriber failed: ${error instanceof Error ? error.message : error}`),
      );
    }
  }

  private handleClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.failPendingAcks(new Error("Connection to relay lost"));
    if (this.closedByUser || !this.config || !this.everConnected) return;
    if (this.reconnectTimer) return;
    const backoff = Math.min(
      this.initialBackoffMs * 2 ** this.reconnectAttempt,
      this.maxBackoffMs,
    );
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.reconnectAttempt += 1;
    this.log(`connection lost; reconnecting in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open().catch(() => {
        // open() failed before the socket was established; try again.
        this.handleClose(this.ws ?? ws);
      });
    }, delay);
  }

  private failPendingAcks(error: Error): void {
    for (const [id, pending] of this.pendingAcks) {
      this.pendingAcks.delete(id);
      pending.reject(error);
    }
  }

  private failPending(error: Error): void {
    this.failPendingAcks(error);
    for (const [id, pending] of this.pendingAsks) {
      this.pendingAsks.delete(id);
      pending.reject(error);
    }
  }
}
