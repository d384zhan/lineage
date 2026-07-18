import {
  PROTOCOL_VERSION,
  WireEnvelopeSchema,
  type Actor,
  type ErrorCode,
  type WireEnvelope,
} from "@lineage/contracts";
import type { Server } from "bun";
import { choosePort } from "./ports";
import { RoomRegistry, type Client, type ClientState } from "./rooms";

const RELAY_ACTOR: Actor = { userId: "relay" };

export type RoomTokenResolver = string | ((repoId: string) => string | undefined);

export interface RelayOptions {
  port: number;
  /** Shared token for every room, or a per-room resolver. */
  token: RoomTokenResolver;
  hostname?: string;
  log?: (line: string) => void;
}

export interface RelayHandle {
  server: Server<ClientState>;
  port: number;
  url: string;
  stop(): void;
}

function relayEnvelope(
  repoId: string,
  type: "presence" | "ack" | "error",
  payload: unknown,
  extra: { sender?: Actor; requestId?: string } = {},
): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    repoId,
    type,
    sender: extra.sender ?? RELAY_ACTOR,
    ...(extra.requestId ? { requestId: extra.requestId } : {}),
    createdAt: new Date().toISOString(),
    payload,
  });
}

function sendError(
  client: Client,
  repoId: string,
  code: ErrorCode,
  message: string,
  requestId?: string,
): void {
  client.send(
    relayEnvelope(
      repoId,
      "error",
      { code, message, ...(requestId ? { requestId } : {}) },
      requestId ? { requestId } : {},
    ),
  );
}

function sendAck(client: Client, repoId: string, messageId: string): void {
  client.send(
    relayEnvelope(repoId, "ack", {
      messageId,
      delivered: true,
      receivedAt: new Date().toISOString(),
    }),
  );
}

export function startRelay(options: RelayOptions): RelayHandle {
  const rooms = new RoomRegistry();
  const log = options.log ?? (() => {});
  const hostname = options.hostname ?? "localhost";
  const resolveToken =
    typeof options.token === "string"
      ? () => options.token as string
      : options.token;

  function broadcastPresence(
    repoId: string,
    actor: Actor,
    status: "online" | "busy" | "offline",
    except?: Client,
  ): void {
    const frame = relayEnvelope(repoId, "presence", { status }, { sender: actor });
    for (const member of rooms.members(repoId)) {
      if (member.client !== except) member.client.send(frame);
    }
  }

  function handleHello(client: Client, envelope: WireEnvelope): void {
    if (envelope.type !== "hello") {
      sendError(client, envelope.repoId, "invalid_token", "First message must be hello");
      client.close(4001, "not authenticated");
      return;
    }
    const expected = resolveToken(envelope.repoId);
    if (!expected || envelope.payload.roomToken !== expected) {
      sendError(client, envelope.repoId, "invalid_token", "Room token rejected");
      client.close(4001, "invalid token");
      return;
    }
    const replaced = rooms.join(envelope.repoId, envelope.sender, client);
    if (replaced) replaced.close(4002, "replaced by newer connection");
    client.data.authed = true;
    client.data.repoId = envelope.repoId;
    client.data.actor = envelope.sender;
    sendAck(client, envelope.repoId, envelope.id);
    // Roster snapshot for the joiner, then announce the joiner to the room.
    for (const member of rooms.members(envelope.repoId)) {
      if (member.client === client) continue;
      client.send(
        relayEnvelope(envelope.repoId, "presence", { status: "online" }, { sender: member.actor }),
      );
    }
    broadcastPresence(envelope.repoId, envelope.sender, "online", client);
    log(`join ${envelope.sender.userId} → room ${envelope.repoId}`);
  }

  function handleAuthed(client: Client, envelope: WireEnvelope): void {
    const repoId = client.data.repoId!;
    if (envelope.repoId !== repoId) {
      sendError(client, repoId, "invalid_token", "Envelope repoId does not match joined room");
      return;
    }
    switch (envelope.type) {
      case "hello":
        sendAck(client, repoId, envelope.id);
        return;
      case "presence":
      case "intent.announce": {
        const frame = JSON.stringify(envelope);
        for (const member of rooms.members(repoId)) {
          if (member.client !== client) member.client.send(frame);
        }
        sendAck(client, repoId, envelope.id);
        return;
      }
      case "question.ask":
      case "question.answer":
      case "question.reject": {
        const target = rooms.get(repoId, envelope.recipient);
        if (!target) {
          sendError(
            client,
            repoId,
            "recipient_offline",
            `${envelope.recipient} is offline`,
            envelope.requestId,
          );
          return;
        }
        target.client.send(JSON.stringify(envelope));
        sendAck(client, repoId, envelope.id);
        return;
      }
      case "ack":
      case "error":
        // Clients do not relay acks/errors through the room; drop silently.
        return;
    }
  }

  function handleMessage(ws: Client, raw: string | Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      sendError(ws, "unknown", "unsupported_message_type", "Frame is not valid JSON");
      if (!ws.data.authed) ws.close(4001, "invalid frame");
      return;
    }
    const record = parsed as Record<string, unknown>;
    const repoIdHint =
      typeof record?.repoId === "string" && record.repoId ? record.repoId : "unknown";
    if (typeof record?.version === "number" && record.version !== PROTOCOL_VERSION) {
      sendError(ws, repoIdHint, "unsupported_version", `Protocol version ${record.version} is not supported`);
      if (!ws.data.authed) ws.close(4001, "unsupported version");
      return;
    }
    const result = WireEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      sendError(ws, repoIdHint, "unsupported_message_type", "Frame failed envelope validation");
      if (!ws.data.authed) ws.close(4001, "invalid envelope");
      return;
    }
    if (!ws.data.authed) {
      handleHello(ws, result.data);
    } else {
      handleAuthed(ws, result.data);
    }
  }

  let server: Server<ClientState>;
  let port = choosePort(options.port);
  for (let attempt = 0; ; attempt++) {
    try {
      server = Bun.serve<ClientState, never>({
        port,
        ...(options.hostname ? { hostname: options.hostname } : {}),
        fetch(request, server) {
          if (server.upgrade(request, { data: { authed: false } })) return;
          return new Response("lineage relay", { status: 200 });
        },
        websocket: {
          message(ws, raw) {
            try {
              handleMessage(ws, raw);
            } catch (error) {
              log(`handler crashed: ${error instanceof Error ? error.stack : String(error)}`);
            }
          },
          close(ws) {
            if (!ws.data.authed || !ws.data.repoId || !ws.data.actor) return;
            const left = rooms.leave(ws.data.repoId, ws.data.actor.userId, ws);
            if (left) {
              broadcastPresence(ws.data.repoId, ws.data.actor, "offline", ws);
              log(`leave ${ws.data.actor.userId} ← room ${ws.data.repoId}`);
            }
          },
        },
      });
      break;
    } catch (error) {
      if (options.port !== 0 || attempt >= 9) throw error;
      port = choosePort(0);
    }
  }

  return {
    server: server!,
    port: server.port ?? port,
    url: `ws://${hostname}:${server.port ?? port}`,
    stop: () => server.stop(true),
  };
}
