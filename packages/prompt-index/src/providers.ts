import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Provider } from "@lineage/contracts";
import { canonicalRepoPath } from "./paths";
import { sha256, termHashes } from "./privacy";
import type { PromptIndexEntry } from "./types";

interface ParsedPrompt {
  content: string;
  sessionId: string;
  promptId?: string;
  timestamp: string;
  cwd?: string;
  branch?: string;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const part = item as Record<string, unknown>;
      if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function validTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function claudePrompt(record: Record<string, unknown>, fallback: string): ParsedPrompt | undefined {
  if (record.type !== "user" || record.isMeta === true) return undefined;
  const message = record.message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (Array.isArray(content) && content.some((part) =>
    typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "tool_result"
  )) return undefined;
  const text = textContent(content).trim();
  if (!text) return undefined;
  return {
    content: text,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "unknown",
    ...(typeof record.promptId === "string" ? { promptId: record.promptId } : {}),
    timestamp: validTimestamp(record.timestamp, fallback),
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(typeof record.gitBranch === "string" ? { branch: record.gitBranch } : {}),
  };
}

interface CodexState {
  sessionId: string;
  cwd?: string;
  branch?: string;
}

function updateCodexState(record: Record<string, unknown>, state: CodexState): void {
  if (record.type !== "session_meta" && record.type !== "turn_context") return;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return;
  const data = payload as Record<string, unknown>;
  if (typeof data.id === "string") state.sessionId = data.id;
  if (typeof data.cwd === "string") state.cwd = data.cwd;
  if (typeof data.gitBranch === "string") state.branch = data.gitBranch;
  if (typeof data.branch === "string") state.branch = data.branch;
}

function codexPrompt(record: Record<string, unknown>, state: CodexState, fallback: string): ParsedPrompt | undefined {
  if (record.type !== "event_msg") return undefined;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const data = payload as Record<string, unknown>;
  if (data.type !== "user_message") return undefined;
  const text = (typeof data.message === "string" ? data.message : textContent(data.content)).trim();
  if (!text) return undefined;
  return {
    content: text,
    sessionId: state.sessionId,
    timestamp: validTimestamp(record.timestamp, fallback),
    ...(state.cwd ? { cwd: state.cwd } : {}),
    ...(state.branch ? { branch: state.branch } : {}),
  };
}

function referencedFiles(text: string, cwd?: string): string[] {
  const matches = text.match(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+/g) ?? [];
  return normalizePaths(matches, cwd);
}

function normalizePaths(paths: readonly string[], cwd?: string): string[] {
  return [...new Set(paths.map((path) => canonicalRepoPath(path, cwd)).filter(Boolean))].slice(0, 32);
}

function pathsFromValue(value: unknown, cwd?: string): string[] {
  const paths: string[] = [];
  function visit(item: unknown, key = ""): void {
    if (typeof item === "string") {
      if (key === "file_path" || key === "path") paths.push(item);
      for (const match of item.matchAll(/(?:\*\*\* (?:Update|Add|Delete) File: |\b)((?:\.?\.?[\\/]|[\\/])?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+)/g)) {
        if (match[1]) paths.push(match[1]);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, key);
      return;
    }
    if (typeof item === "object" && item !== null) {
      for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
    }
  }
  visit(value);
  return normalizePaths(paths, cwd);
}

function toolReferencedFiles(record: Record<string, unknown>, cwd?: string): string[] {
  if (record.type === "assistant") {
    const message = record.message;
    if (typeof message !== "object" || message === null) return [];
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return pathsFromValue(
      content.filter((part) =>
        typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "tool_use"
      ),
      cwd,
    );
  }
  if (record.type === "response_item") {
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null) return [];
    const data = payload as Record<string, unknown>;
    if (data.type !== "function_call") return [];
    let args: unknown = data.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { /* scan the string */ }
    }
    return pathsFromValue(args, cwd);
  }
  return [];
}

export async function parseTranscript(
  provider: Provider,
  sourcePath: string,
  repoIdForCwd: (cwd: string) => Promise<string | undefined>,
): Promise<PromptIndexEntry[]> {
  const raw = await readFile(sourcePath, "utf8");
  const lines = raw.split("\n");
  const fallback = new Date(0).toISOString();
  const state: CodexState = { sessionId: sourcePath };
  const entries: PromptIndexEntry[] = [];
  let activeEntry: PromptIndexEntry | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    updateCodexState(record, state);
    const touched = toolReferencedFiles(record, provider === "claude" ? activeEntry?.cwd : state.cwd);
    if (activeEntry && touched.length) {
      activeEntry.files = [...new Set([...activeEntry.files, ...touched])];
    }
    const prompt = provider === "claude"
      ? claudePrompt(record, fallback)
      : codexPrompt(record, state, fallback);
    if (!prompt) continue;
    const repoId = prompt.cwd ? await repoIdForCwd(resolve(prompt.cwd)) : undefined;
    entries.push({
      id: sha256(`${provider}:${sourcePath}:${index + 1}:${sha256(prompt.content)}`),
      provider,
      sourcePath,
      sourceLine: index + 1,
      promptHash: sha256(prompt.content),
      sessionId: prompt.sessionId,
      ...(prompt.promptId ? { promptId: prompt.promptId } : {}),
      timestamp: prompt.timestamp,
      ...(prompt.cwd ? { cwd: resolve(prompt.cwd) } : {}),
      ...(repoId ? { repoId } : {}),
      ...(prompt.branch ? { branch: prompt.branch } : {}),
      termHashes: termHashes(prompt.content),
      files: referencedFiles(prompt.content, prompt.cwd),
    });
    activeEntry = entries.at(-1);
  }
  return entries;
}

export async function readExactPrompt(pointer: PromptIndexEntry): Promise<string> {
  const raw = await readFile(pointer.sourcePath, "utf8");
  const line = raw.split("\n")[pointer.sourceLine - 1];
  if (!line) throw new Error("The indexed transcript line no longer exists");
  const record = JSON.parse(line) as Record<string, unknown>;
  const state: CodexState = { sessionId: pointer.sessionId, ...(pointer.cwd ? { cwd: pointer.cwd } : {}) };
  const parsed = pointer.provider === "claude"
    ? claudePrompt(record, pointer.timestamp)
    : codexPrompt(record, state, pointer.timestamp);
  if (!parsed || sha256(parsed.content) !== pointer.promptHash) {
    throw new Error("The source prompt changed since it was indexed");
  }
  return parsed.content;
}
