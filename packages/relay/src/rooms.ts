import type { Actor } from "@lineage/contracts";
import type { ServerWebSocket } from "bun";

export interface ClientState {
  authed: boolean;
  repoId?: string;
  actor?: Actor;
}

export type Client = ServerWebSocket<ClientState>;

export interface RoomMember {
  userId: string;
  actor: Actor;
  client: Client;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Map<string, RoomMember>>();

  /** Registers a member; returns the socket it replaced, if any. */
  join(repoId: string, actor: Actor, client: Client): Client | undefined {
    let room = this.rooms.get(repoId);
    if (!room) {
      room = new Map();
      this.rooms.set(repoId, room);
    }
    const replaced = room.get(actor.userId)?.client;
    room.set(actor.userId, { userId: actor.userId, actor, client });
    return replaced;
  }

  /** Removes a member only if this exact socket still represents them. */
  leave(repoId: string, userId: string, client: Client): boolean {
    const room = this.rooms.get(repoId);
    if (!room || room.get(userId)?.client !== client) return false;
    room.delete(userId);
    if (room.size === 0) this.rooms.delete(repoId);
    return true;
  }

  get(repoId: string, userId: string): RoomMember | undefined {
    return this.rooms.get(repoId)?.get(userId);
  }

  members(repoId: string): RoomMember[] {
    return [...(this.rooms.get(repoId)?.values() ?? [])];
  }
}
