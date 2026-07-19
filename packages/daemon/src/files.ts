import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  IdentifierSchema,
  GitIdentitySchema,
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
  gitIdentities: z.array(GitIdentitySchema).max(20).optional(),
});

export type NetworkSettings = z.infer<typeof NetworkSettingsSchema>;

export const HostSettingsSchema = z.object({
  roomToken: z.string().min(1),
  port: z.number().int().min(0).max(65535),
});

export type HostSettings = z.infer<typeof HostSettingsSchema>;

export const ApprovedMemberSchema = z.object({
  identity: z.string().min(1),
  approvedAt: UtcTimestampSchema,
});

export const MembershipSettingsSchema = z.object({
  members: z.array(ApprovedMemberSchema),
});

export type MembershipSettings = z.infer<typeof MembershipSettingsSchema>;

/**
 * Auth0 login state written by `lineage login`. Lives under the user's global
 * Lineage directory because login identity belongs to a person, not a repo.
 */
export const AuthSettingsSchema = z.object({
  /** Tenant domain, e.g. "dev-abc.us.auth0.com" (scheme optional). */
  domain: z.string().min(1),
  clientId: z.string().min(1),
  audience: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: UtcTimestampSchema,
  /** Verified identity (email claim, else sub) — the effective userId. */
  identity: z.string().min(1),
});

export type AuthSettings = z.infer<typeof AuthSettingsSchema>;

export const DaemonInfoSchema = z.object({
  port: z.number().int().positive(),
  pid: z.number().int().positive(),
  secret: z.string().min(1),
  startedAt: UtcTimestampSchema,
});

export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;

const NETWORK_FILE = "network.json";
const HOST_FILE = "host.json";
const MEMBERS_FILE = "members.json";
const DAEMON_FILE = "daemon.json";
export const INBOX_FILE = "inbox.json";
export const OUTBOX_FILE = "outbox.json";
const AUTH_FILE = "auth.json";

/** Machine-wide Lineage state. Override in tests with LINEAGE_HOME. */
export function resolveUserStateDir(override = process.env["LINEAGE_HOME"]): string {
  return override ?? join(homedir(), ".lineage");
}

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
  const path = join(stateDir, NETWORK_FILE);
  await Bun.write(
    path,
    JSON.stringify(NetworkSettingsSchema.parse(settings), null, 2),
  );
  chmodSync(path, 0o600);
}

export async function readHostSettings(
  stateDir: string,
): Promise<HostSettings | undefined> {
  const raw = await readJsonFile(join(stateDir, HOST_FILE));
  return raw === undefined ? undefined : HostSettingsSchema.parse(raw);
}

export async function writeHostSettings(
  stateDir: string,
  settings: HostSettings,
): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, HOST_FILE);
  await Bun.write(
    path,
    JSON.stringify(HostSettingsSchema.parse(settings), null, 2),
  );
  chmodSync(path, 0o600);
}

export async function readMembershipSettings(
  stateDir: string,
): Promise<MembershipSettings> {
  const raw = await readJsonFile(join(stateDir, MEMBERS_FILE));
  return raw === undefined ? { members: [] } : MembershipSettingsSchema.parse(raw);
}

export async function writeMembershipSettings(
  stateDir: string,
  settings: MembershipSettings,
): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, MEMBERS_FILE);
  await Bun.write(
    path,
    JSON.stringify(MembershipSettingsSchema.parse(settings), null, 2),
  );
  chmodSync(path, 0o600);
}

export async function readAuthSettings(
  stateDir: string,
): Promise<AuthSettings | undefined> {
  const raw = await readJsonFile(join(stateDir, AUTH_FILE));
  return raw === undefined ? undefined : AuthSettingsSchema.parse(raw);
}

export async function writeAuthSettings(
  userStateDir: string,
  settings: AuthSettings,
): Promise<void> {
  mkdirSync(userStateDir, { recursive: true });
  const path = join(userStateDir, AUTH_FILE);
  await Bun.write(
    path,
    JSON.stringify(AuthSettingsSchema.parse(settings), null, 2),
  );
  chmodSync(path, 0o600);
}

export function deleteAuthSettings(stateDir: string): void {
  rmSync(join(stateDir, AUTH_FILE), { force: true });
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
