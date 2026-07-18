import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Provider, SessionEvent } from "@lineage/contracts";

/**
 * Claude Code writes session transcripts to
 * `~/.claude/projects/<slugified cwd>/<session>.jsonl`. The slug replaces
 * path separators, colons, and dots with dashes.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[\\/:.]/g, "-");
}

export function claudeTranscriptDir(cwd: string, home = process.env.USERPROFILE ?? process.env.HOME ?? ""): string {
  return join(home, ".claude", "projects", claudeProjectSlug(cwd));
}

interface ParsedLine {
  kind: "user_prompt" | "assistant_output";
  content: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item !== "object" || item === null) return "";
        const record = item as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Maps one transcript JSONL line to a session event, or undefined to skip. */
export function parseClaudeTranscriptLine(line: string): ParsedLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.isMeta === true) return undefined;
  const message = record.message as Record<string, unknown> | undefined;
  if (!message) return undefined;
  if (record.type === "user") {
    // Tool results also arrive as user entries; skip anything without prose.
    const content = message.content;
    if (
      Array.isArray(content) &&
      content.some(
        (item) => (item as Record<string, unknown>)?.type === "tool_result",
      )
    ) {
      return undefined;
    }
    const text = textFromContent(content);
    if (!text.trim()) return undefined;
    return { kind: "user_prompt", content: text };
  }
  if (record.type === "assistant") {
    const text = textFromContent(message.content);
    if (!text.trim()) return undefined;
    return { kind: "assistant_output", content: text };
  }
  return undefined;
}

export interface TranscriptTailerOptions {
  transcriptDir: string;
  /** Only transcript files modified after this instant are considered. */
  since: number;
  sessionId: string;
  provider: Provider;
  emit: (event: SessionEvent) => Promise<void>;
  pollMs?: number;
  log?: (line: string) => void;
}

export interface TranscriptTailer {
  stop(): Promise<void>;
}

/**
 * Best-effort capture of user prompts and assistant output from the agent's
 * own transcript file. Never throws out of the poll loop: capture must not
 * break the agent session.
 */
export function startTranscriptTailer(options: TranscriptTailerOptions): TranscriptTailer {
  const pollMs = options.pollMs ?? 1_000;
  const log = options.log ?? (() => {});
  let stopped = false;
  let file: string | undefined;
  let processedLines = 0;
  let ticking = Promise.resolve();

  function pickFile(): string | undefined {
    try {
      const candidates = readdirSync(options.transcriptDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => {
          const path = join(options.transcriptDir, name);
          return { path, mtime: statSync(path).mtimeMs };
        })
        .filter((entry) => entry.mtime >= options.since)
        .sort((a, b) => b.mtime - a.mtime);
      return candidates[0]?.path;
    } catch {
      return undefined;
    }
  }

  async function tick(): Promise<void> {
    try {
      file ??= pickFile();
      if (!file) return;
      const text = await Bun.file(file).text();
      const complete = text.endsWith("\n");
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      const upto = complete ? lines.length : lines.length - 1;
      for (; processedLines < upto; processedLines += 1) {
        const parsed = parseClaudeTranscriptLine(lines[processedLines]!);
        if (!parsed) continue;
        await options.emit({
          id: crypto.randomUUID(),
          sessionId: options.sessionId,
          provider: options.provider,
          kind: parsed.kind,
          content: parsed.content,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      log(
        `transcript capture skipped: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const timer = setInterval(() => {
    ticking = ticking.then(tick);
  }, pollMs);

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await ticking;
      await tick(); // final drain
    },
  };
}
