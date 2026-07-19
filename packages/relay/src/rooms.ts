import type { Actor } from "@lineage/contracts";
import type { ServerWebSocket } from "bun";

export interface ClientState {
  authed: boolean;
  authPending?: boolean;
  repoId?: string;
  actor?: Actor;
}

export type Client = ServerWebSocket<ClientState>;

export interface RoomMember {
  userId: string;
  actor: Actor;
  client: Client;
}

export type MemberResolution =
  | { status: "found"; member: RoomMember }
  | { status: "ambiguous"; candidates: RoomMember[] }
  | { status: "missing"; candidates: RoomMember[] };

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function memberAliases(member: RoomMember): Set<string> {
  const aliases = new Set<string>();
  const add = (value: string) => {
    const normalized = normalize(value);
    if (!normalized) return;
    aliases.add(normalized);
    const at = normalized.indexOf("@");
    const aliasText = at >= 0 ? normalized.slice(0, at) : normalized;
    if (at >= 0 && aliasText) aliases.add(aliasText);
    for (const segment of aliasText.split(/[^a-z0-9]+/).filter(Boolean)) {
      aliases.add(segment);
    }
  };
  add(member.userId);
  for (const identity of member.actor.gitIdentities ?? []) {
    add(identity.name);
    add(identity.email);
  }
  return aliases;
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

  resolve(repoId: string, query: string): MemberResolution {
    const candidates = this.members(repoId);
    const exact = candidates.find((member) => normalize(member.userId) === normalize(query));
    if (exact) return { status: "found", member: exact };
    const matches = candidates.filter((member) => memberAliases(member).has(normalize(query)));
    if (matches.length === 1) return { status: "found", member: matches[0]! };
    if (matches.length > 1) return { status: "ambiguous", candidates: matches };
    return { status: "missing", candidates };
  }

  members(repoId: string): RoomMember[] {
    return [...(this.rooms.get(repoId)?.values() ?? [])];
  }
}
