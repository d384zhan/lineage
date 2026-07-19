import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  IdentifierSchema,
  LINEAGE_GIT_DIRECTORY,
  LINEAGE_LEGACY_REPOSITORY_CONFIG,
  LINEAGE_REPOSITORY_CONFIG,
  ProviderSchema,
  RepositoryConfigSchema,
  UtcTimestampSchema,
} from "@lineage/contracts";

/**
 * Local (never committed) connection settings written by `lineage join`.
 * This is a local file format, not a shared wire contract.
 */
export const NetworkSettingsSchema = z.object({
  relayUrl: z.string().min(1),
  roomToken: z.string().min(1),
  userId: IdentifierSchema,
  provider: ProviderSchema.optional(),
});

export type NetworkSettings = z.infer<typeof NetworkSettingsSchema>;

export const DaemonInfoSchema = z.object({
  port: z.number().int().positive(),
  pid: z.number().int().positive(),
  secret: z.string().min(1),
  startedAt: UtcTimestampSchema,
});

export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;

const NETWORK_FILE = "network.json";
const DAEMON_FILE = "daemon.json";

export function findGitDir(cwd: string): string | undefined {
  let current = cwd;
  for (;;) {
    const candidate = join(current, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Directory for local lineage state: `<git dir>/lineage` unless overridden. */
export function resolveStateDir(cwd: string, override?: string): string {
  if (override) return override;
  const gitDir = findGitDir(cwd);
  if (!gitDir) {
    throw new Error(`Not inside a Git repository: ${cwd}`);
  }
  return join(gitDir, LINEAGE_GIT_DIRECTORY);
}

export function findRepoRoot(cwd: string): string | undefined {
  const gitDir = findGitDir(cwd);
  return gitDir ? dirname(gitDir) : undefined;
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return await file.json();
}

export async function readRepoId(cwd: string): Promise<string> {
  const root = findRepoRoot(cwd);
  if (!root) throw new Error(`Not inside a Git repository: ${cwd}`);
  const stateDir = resolveStateDir(cwd);
  const raw =
    (await readJsonFile(join(stateDir, LINEAGE_REPOSITORY_CONFIG))) ??
    (await readJsonFile(join(root, LINEAGE_LEGACY_REPOSITORY_CONFIG)));
  if (!raw) {
    throw new Error("Lineage is not initialized here. Run `lineage init` first.");
  }
  return RepositoryConfigSchema.parse(raw).repoId;
}

export async function readNetworkSettings(
  stateDir: string,
): Promise<NetworkSettings | undefined> {
  const raw = await readJsonFile(join(stateDir, NETWORK_FILE));
  return raw === undefined ? undefined : NetworkSettingsSchema.parse(raw);
}

export async function writeNetworkSettings(
  stateDir: string,
  settings: NetworkSettings,
): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  await Bun.write(
    join(stateDir, NETWORK_FILE),
    JSON.stringify(NetworkSettingsSchema.parse(settings), null, 2),
  );
}

export async function readDaemonInfo(stateDir: string): Promise<DaemonInfo | undefined> {
  const raw = await readJsonFile(join(stateDir, DAEMON_FILE));
  if (raw === undefined) return undefined;
  const result = DaemonInfoSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

export async function writeDaemonInfo(stateDir: string, info: DaemonInfo): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  await Bun.write(join(stateDir, DAEMON_FILE), JSON.stringify(info, null, 2));
}

export function deleteDaemonInfo(stateDir: string): void {
  rmSync(join(stateDir, DAEMON_FILE), { force: true });
}
