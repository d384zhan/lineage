import { chmod, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { parseTranscript } from "./providers";
import type { PromptIndexEntry, PromptIndexFile } from "./types";

export const LINEAGE_INDEX_PATH_ENV = "LINEAGE_INDEX_PATH";

export function defaultIndexPath(env: Record<string, string | undefined> = process.env): string {
  if (env[LINEAGE_INDEX_PATH_ENV]) return env[LINEAGE_INDEX_PATH_ENV];
  const base = env.XDG_DATA_HOME ?? join(env.HOME ?? env.USERPROFILE ?? ".", ".lineage");
  return env.XDG_DATA_HOME ? join(base, "lineage", "prompt-index.json") : join(base, "prompt-index.json");
}

export function defaultTranscriptRoots(env: Record<string, string | undefined> = process.env): {
  claude: string;
  codex: string;
} {
  const userHome = env.HOME ?? env.USERPROFILE ?? ".";
  return {
    claude: join(userHome, ".claude", "projects"),
    codex: join(userHome, ".codex", "sessions"),
  };
}

async function jsonlFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(path: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(child);
    }
  }
  await visit(root);
  return found;
}

async function repoIdForCwd(cwd: string): Promise<string | undefined> {
  let current = cwd;
  const root = parse(current).root;
  for (;;) {
    try {
      const config = await Bun.file(join(current, ".lineage", "repo.json")).json() as { repoId?: unknown };
      if (typeof config.repoId === "string") return config.repoId;
    } catch {
      // Continue toward the filesystem root.
    }
    if (current === root) return undefined;
    current = dirname(current);
  }
}

export async function loadPromptIndex(path = defaultIndexPath()): Promise<PromptIndexFile> {
  try {
    const parsed = await Bun.file(path).json() as PromptIndexFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("invalid index");
    return parsed;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
  }
}

export interface RefreshIndexOptions {
  indexPath?: string;
  claudeRoot?: string;
  codexRoot?: string;
}

export async function refreshPromptIndex(options: RefreshIndexOptions = {}): Promise<PromptIndexFile> {
  const roots = defaultTranscriptRoots();
  const sources = [
    ...((await jsonlFiles(options.claudeRoot ?? roots.claude)).map((path) => ({ provider: "claude" as const, path }))),
    ...((await jsonlFiles(options.codexRoot ?? roots.codex)).map((path) => ({ provider: "codex" as const, path }))),
  ];
  const byId = new Map<string, PromptIndexEntry>();
  const repoIds = new Map<string, Promise<string | undefined>>();
  const cachedRepoId = (cwd: string): Promise<string | undefined> => {
    const existing = repoIds.get(cwd);
    if (existing) return existing;
    const pending = repoIdForCwd(cwd);
    repoIds.set(cwd, pending);
    return pending;
  };
  for (const { provider, path } of sources) {
    const parsed = await parseTranscript(provider, path, cachedRepoId).catch(() => []);
    for (const entry of parsed) byId.set(entry.id, entry);
  }
  const index: PromptIndexFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  };
  const path = options.indexPath ?? defaultIndexPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(index)}\n`);
  await rename(temporary, path);
  await chmod(path, 0o600);
  return index;
}
