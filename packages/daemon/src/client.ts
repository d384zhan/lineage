import {
  AgentAnswerSchema,
  ErrorCodeSchema,
  type AgentAnswer,
  type AskInput,
  type IntentRecord,
  type ReplyInput,
  type RespondInput,
} from "@lineage/contracts";
import { TransportError } from "@lineage/transport";
import { z } from "zod";
import { readDaemonInfo, resolveStateDir, type DaemonInfo } from "./files";
import { DAEMON_SECRET_HEADER } from "./http";
import type { InboxEntry } from "./inbox";
import type { OutboxEntry } from "./outbox";

const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string(),
  }),
});

export interface InboxSnapshotEntry extends InboxEntry {
  rendered?: string;
}

export interface DaemonStatus {
  actor: { userId: string; provider?: string };
  repoId: string;
  relayUrl?: string;
  connected?: boolean;
  startedAt: string;
  openQuestions: number;
}

export class DaemonClient {
  constructor(private readonly info: DaemonInfo) {}

  /** Connects to the daemon recorded in `.git/lineage/daemon.json`. */
  static async open(cwd: string, stateDirOverride?: string): Promise<DaemonClient> {
    const stateDir = resolveStateDir(cwd, stateDirOverride);
    const info = await readDaemonInfo(stateDir);
    if (!info) {
      throw new Error(
        "The lineage daemon is not running. Start `lineage daemon` in another terminal.",
      );
    }
    const client = new DaemonClient(info);
    try {
      await client.status();
    } catch {
      throw new Error(
        "The lineage daemon is not responding. Start `lineage daemon` in another terminal.",
      );
    }
    return client;
  }

  static forPort(port: number, secret: string): DaemonClient {
    return new DaemonClient({
      port,
      secret,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  }

  async status(): Promise<DaemonStatus> {
    return (await this.request("GET", "/status")) as DaemonStatus;
  }

  async ask(input: AskInput): Promise<AgentAnswer> {
    return AgentAnswerSchema.parse(await this.request("POST", "/ask", input));
  }

  async askAsync(input: AskInput): Promise<{ requestId: string; status: "pending" }> {
    return (await this.request("POST", "/ask-async", input)) as {
      requestId: string;
      status: "pending";
    };
  }

  async requests(): Promise<OutboxEntry[]> {
    const body = (await this.request("GET", "/requests")) as { entries: OutboxEntry[] };
    return body.entries;
  }

  async reply(input: ReplyInput & { mode?: "agent" | "manual" | "history" }): Promise<void> {
    await this.request("POST", "/reply", input);
  }

  async respond(input: RespondInput): Promise<unknown> {
    return await this.request("POST", "/respond", input);
  }

  async inbox(): Promise<InboxSnapshotEntry[]> {
    const body = (await this.request("GET", "/inbox")) as { entries: InboxSnapshotEntry[] };
    return body.entries;
  }

  async publishIntent(intent: IntentRecord): Promise<void> {
    await this.request("POST", "/publish-intent", intent);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.info.port}${path}`, {
      method,
      headers: {
        [DAEMON_SECRET_HEADER]: this.info.secret,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = ErrorBodySchema.safeParse(payload);
      if (parsed.success) {
        const { code, message } = parsed.data.error;
        const codeResult = code ? ErrorCodeSchema.safeParse(code) : undefined;
        if (codeResult?.success) throw new TransportError(codeResult.data, message);
        throw new Error(message);
      }
      throw new Error(`Daemon request failed: ${response.status} ${path}`);
    }
    return payload;
  }
}
