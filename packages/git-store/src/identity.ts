import {
  GitIdentitySchema,
  LINEAGE_GIT_IDENTITIES_ENV,
  type GitIdentity,
} from "@lineage/contracts";

function git(cwd: string, args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return undefined;
  const value = new TextDecoder().decode(result.stdout).trim();
  return value || undefined;
}

function normalize(identity: GitIdentity): string {
  return `${identity.name.trim().toLowerCase()}\0${identity.email.trim().toLowerCase()}`;
}

export function parseGitIdentity(value: string): GitIdentity {
  const match = value.trim().match(/^(.+?)\s*<([^<>]+)>$/);
  if (!match?.[1] || !match[2]) {
    throw new Error('Git identities must use "Name <email@example.com>"');
  }
  return GitIdentitySchema.parse({ name: match[1].trim(), email: match[2].trim() });
}

export function parseGitIdentities(value: string | undefined): GitIdentity[] {
  if (!value) return [];
  try {
    const parsed = GitIdentitySchema.array().safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Detect the effective repo-scoped Git identity and merge explicit aliases. */
export function detectGitIdentities(cwd: string, aliases: GitIdentity[] = []): GitIdentity[] {
  const name = git(cwd, ["config", "--get", "user.name"]);
  const email = git(cwd, ["config", "--get", "user.email"]);
  const identities = [...(name && email ? [{ name, email }] : []), ...aliases];
  const seen = new Set<string>();
  return identities.filter((identity) => {
    const key = normalize(identity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveGitIdentities(
  cwd: string,
  serialized = process.env[LINEAGE_GIT_IDENTITIES_ENV],
): GitIdentity[] {
  return detectGitIdentities(cwd, parseGitIdentities(serialized));
}
