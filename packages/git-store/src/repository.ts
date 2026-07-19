import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DECISIONS_NOTES_REF,
  DecisionRecordSchema,
  INTENTS_NOTES_REF,
  INTENTS_REFS_PREFIX,
  IntentRecordSchema,
  LINEAGE_PROVIDER_ENV,
  LINEAGE_GIT_DIRECTORY,
  LINEAGE_LEGACY_REPOSITORY_CONFIG,
  LINEAGE_REPOSITORY_CONFIG,
  LINEAGE_USER_ID_ENV,
  PROTOCOL_VERSION,
  RepositoryConfigSchema,
  type DecisionRecord,
  type HistoryQuery,
  type IntentRecord,
  type RepositoryConfig,
  type TimelineFilter,
} from "@lineage/contracts";
import type {
  CommitInspector,
  CommitMetadata,
  LineageStore,
  SaveIntentOptions,
} from "@lineage/core";
import { findRepositoryRoot, runGit } from "./git";

export class GitLineageRepository implements LineageStore, CommitInspector {
  readonly root: string;
  readonly gitDirectory: string;
  private readonly config: RepositoryConfig;

  private constructor(
    root: string,
    gitDirectory: string,
    config: RepositoryConfig,
  ) {
    this.root = root;
    this.gitDirectory = gitDirectory;
    this.config = config;
  }

  static async initialize(
    cwd: string,
    options: { repoId?: string } = {},
  ): Promise<GitLineageRepository> {
    const root = await findRepositoryRoot(cwd);
    const gitDirectory = await resolveGitDirectory(root);
    const configPath = join(gitDirectory, LINEAGE_GIT_DIRECTORY, LINEAGE_REPOSITORY_CONFIG);
    const existing = Bun.file(configPath);
    let config: RepositoryConfig;
    if (await existing.exists()) {
      config = RepositoryConfigSchema.parse(await existing.json());
    } else {
      const legacy = Bun.file(join(root, LINEAGE_LEGACY_REPOSITORY_CONFIG));
      const repoId = options.repoId ?? (
        (await legacy.exists())
          ? RepositoryConfigSchema.parse(await legacy.json()).repoId
          : await deriveRepositoryId(root)
      );
      config = { protocolVersion: PROTOCOL_VERSION, repoId };
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await chmod(configPath, 0o600);
    }
    await configureLineageRefs(root);
    await installPostCommitHook(root);
    return GitLineageRepository.open(root);
  }

  static async open(cwd: string): Promise<GitLineageRepository> {
    const root = await findRepositoryRoot(cwd);
    const gitDirectory = await resolveGitDirectory(root);
    const configPath = join(gitDirectory, LINEAGE_GIT_DIRECTORY, LINEAGE_REPOSITORY_CONFIG);
    const local = Bun.file(configPath);
    const legacy = Bun.file(join(root, LINEAGE_LEGACY_REPOSITORY_CONFIG));
    if (!(await local.exists()) && !(await legacy.exists())) {
      throw new Error("Lineage is not initialized. Run `lineage init` first.");
    }
    const config = RepositoryConfigSchema.parse(
      await (await local.exists() ? local : legacy).json(),
    );
    return new GitLineageRepository(root, gitDirectory, config);
  }

  close(): void {
    // Git owns all durable state; there is no local database handle to close.
  }

  async sync(mode: "pull" | "push" | "both" = "both"): Promise<{
    pushed: string[];
    pulled: boolean;
  }> {
    const origin = await runGit(this.root, ["remote", "get-url", "origin"], {
      allowFailure: true,
    });
    if (origin.exitCode !== 0) throw new Error("Lineage sync requires an origin remote");

    const pushed: string[] = [];
    if (mode === "push" || mode === "both") {
      const refs = await this.listLineageRefs();
      if (refs.length > 0) {
        await runGit(this.root, [
          "push",
          "origin",
          ...refs.map((reference) => `${reference}:${reference}`),
        ]);
        pushed.push(...refs);
      }
    }
    if (mode === "pull" || mode === "both") {
      await runGit(this.root, [
        "fetch",
        "origin",
        "+refs/lineage/intents/*:refs/lineage/intents/*",
        "+refs/notes/lineage/*:refs/notes/lineage/*",
      ]);
    }
    return { pushed, pulled: mode === "pull" || mode === "both" };
  }

  async getRepoId(): Promise<string> {
    return this.config.repoId;
  }

  async saveIntent(intent: IntentRecord, options: SaveIntentOptions = {}): Promise<void> {
    const parsed = IntentRecordSchema.parse(intent);
    await this.writeIntentRef(parsed);
    if (options.commitSha && parsed.status !== "active") {
      await this.appendNote(INTENTS_NOTES_REF, options.commitSha, parsed, IntentRecordSchema);
    }
  }

  async getIntent(intentId: string): Promise<IntentRecord | undefined> {
    return (await this.listCurrentIntents()).find((intent) => intent.id === intentId);
  }

  async listIntents(filter: TimelineFilter = {}): Promise<IntentRecord[]> {
    return (await this.listCurrentIntents())
      .filter((intent) => matchesTimeline(intent.files, intent.symbols, filter))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, filter.limit ?? 50);
  }

  async saveDecision(decision: DecisionRecord): Promise<void> {
    const parsed = DecisionRecordSchema.parse(decision);
    await this.appendNote(DECISIONS_NOTES_REF, parsed.commitSha, parsed, DecisionRecordSchema);
  }

  async findDecisions(query: HistoryQuery): Promise<DecisionRecord[]> {
    const decisions = await this.readAllNotes(DECISIONS_NOTES_REF, DecisionRecordSchema);
    return decisions.filter((decision) => {
      const pathMatch = query.path
        ? decision.files.some((file) => file.includes(query.path!) || query.path!.includes(file))
        : false;
      const symbolMatch = query.symbol
        ? decision.symbols.some((symbol) => symbol.toLowerCase().includes(query.symbol!.toLowerCase()))
        : false;
      const textMatch = query.text
        ? `${decision.summary} ${decision.rationale} ${decision.alternatives.join(" ")}`
            .toLowerCase()
            .includes(query.text.toLowerCase())
        : false;
      return pathMatch || symbolMatch || textMatch;
    });
  }

  async listDecisions(filter: TimelineFilter = {}): Promise<DecisionRecord[]> {
    const decisions = await this.readAllNotes(DECISIONS_NOTES_REF, DecisionRecordSchema);
    return decisions
      .filter((decision) => matchesTimeline(decision.files, decision.symbols, filter))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, filter.limit ?? 50);
  }

  async inspectCommit(commitSha: string): Promise<CommitMetadata> {
    const metadata = await runGit(this.root, [
      "show",
      "-s",
      "--format=%H%x00%s%x00%b",
      commitSha,
    ]);
    const [resolvedSha = "", summary = "", body = ""] = metadata.stdout.split("\0");
    const files = await runGit(this.root, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      commitSha,
    ]);
    return {
      commitSha: resolvedSha.trim(),
      summary: summary.trim(),
      body: body.trim(),
      files: files.stdout.split("\n").map((file) => file.trim()).filter(Boolean),
    };
  }

  private async writeIntentRef(intent: IntentRecord): Promise<void> {
    const reference = intentReference(intent.author.userId);
    const parentResult = await runGit(
      this.root,
      ["rev-parse", "--verify", reference],
      { allowFailure: true },
    );
    const parent = parentResult.exitCode === 0 ? parentResult.stdout.trim() : undefined;
    const emptyTree = (await runGit(this.root, ["mktree"], { input: "" })).stdout.trim();
    const timestamp = Math.floor(Date.parse(intent.createdAt) / 1000);
    const commit = [
      `tree ${emptyTree}`,
      ...(parent ? [`parent ${parent}`] : []),
      `author Lineage <lineage@local> ${timestamp} +0000`,
      `committer Lineage <lineage@local> ${timestamp} +0000`,
      "",
      JSON.stringify(intent),
      "",
    ].join("\n");
    const objectId = (
      await runGit(this.root, ["hash-object", "-t", "commit", "-w", "--stdin"], {
        input: commit,
      })
    ).stdout.trim();
    await runGit(
      this.root,
      ["update-ref", reference, objectId, ...(parent ? [parent] : [])],
    );
  }

  private async listCurrentIntents(): Promise<IntentRecord[]> {
    const refs = await runGit(
      this.root,
      ["for-each-ref", "--format=%(refname)", `${INTENTS_REFS_PREFIX}/`],
      { allowFailure: true },
    );
    const names = refs.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
    return Promise.all(names.map((reference) => this.readIntentRef(reference)));
  }

  private async listLineageRefs(): Promise<string[]> {
    const refs = await runGit(this.root, [
      "for-each-ref",
      "--format=%(refname)",
      `${INTENTS_REFS_PREFIX}/`,
      "refs/notes/lineage/",
    ]);
    return refs.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  }

  private async readIntentRef(reference: string): Promise<IntentRecord> {
    const result = await runGit(this.root, ["show", "-s", "--format=%B", reference]);
    return IntentRecordSchema.parse(JSON.parse(result.stdout));
  }

  private async appendNote<T extends { id: string }>(
    reference: string,
    commitSha: string,
    record: T,
    schema: { parse(value: unknown): T },
  ): Promise<void> {
    const existing = await this.readNote(reference, commitSha, schema);
    const updated = [...existing.filter((item) => item.id !== record.id), record];
    await runGit(this.root, [
      "notes",
      `--ref=${reference}`,
      "add",
      "-f",
      "-m",
      JSON.stringify(updated),
      commitSha,
    ]);
  }

  private async readNote<T>(
    reference: string,
    commitSha: string,
    schema: { parse(value: unknown): T },
  ): Promise<T[]> {
    const result = await runGit(
      this.root,
      ["notes", `--ref=${reference}`, "show", commitSha],
      { allowFailure: true },
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return [];
    const value: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(value)) throw new Error(`Invalid Lineage note on ${commitSha}`);
    return value.map((item) => schema.parse(item));
  }

  private async readAllNotes<T>(
    reference: string,
    schema: { parse(value: unknown): T },
  ): Promise<T[]> {
    const result = await runGit(
      this.root,
      ["notes", `--ref=${reference}`, "list"],
      { allowFailure: true },
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return [];
    const commits = result.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((sha): sha is string => Boolean(sha));
    const notes = await Promise.all(
      commits.map((commitSha) => this.readNote(reference, commitSha, schema)),
    );
    return notes.flat();
  }
}

export function normalizeRemoteUrl(remote: string): string {
  let value = remote.trim();
  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !value.includes("://")) {
    value = `${scp[1]}/${scp[2]}`;
  } else {
    try {
      const url = new URL(value);
      value = `${url.hostname}${url.pathname}`;
    } catch {
      value = value.replace(/^ssh:\/\//, "").replace(/^[^@/]+@/, "");
    }
  }
  return value
    .replace(/[?#].*$/, "")
    .replace(/\.git\/?$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

export async function deriveRepositoryId(root: string): Promise<string> {
  const origin = await runGit(root, ["remote", "get-url", "origin"], {
    allowFailure: true,
  });
  let identity: string;
  if (origin.exitCode === 0 && origin.stdout.trim()) {
    identity = `remote:${normalizeRemoteUrl(origin.stdout)}`;
  } else {
    const firstCommit = await runGit(root, ["rev-list", "--max-parents=0", "HEAD"], {
      allowFailure: true,
    });
    identity = firstCommit.exitCode === 0 && firstCommit.stdout.trim()
      ? `root:${firstCommit.stdout.trim().split("\n").sort()[0]}`
      : `local:${crypto.randomUUID()}`;
  }
  return `repo-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

async function resolveGitDirectory(root: string): Promise<string> {
  const raw = (await runGit(root, ["rev-parse", "--git-dir"])).stdout.trim();
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

function intentReference(userId: string): string {
  const slug = userId.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-|-$/g, "") || "user";
  const suffix = createHash("sha256").update(userId).digest("hex").slice(0, 8);
  return `${INTENTS_REFS_PREFIX}/${slug}-${suffix}`;
}

async function configureLineageRefs(root: string): Promise<void> {
  const displayRefs = await runGit(root, ["config", "--get-all", "notes.displayRef"], {
    allowFailure: true,
  });
  const configured = new Set(displayRefs.stdout.split("\n").filter(Boolean));
  for (const reference of [DECISIONS_NOTES_REF, INTENTS_NOTES_REF]) {
    if (!configured.has(reference)) {
      await runGit(root, ["config", "--add", "notes.displayRef", reference]);
    }
  }

  const origin = await runGit(root, ["remote", "get-url", "origin"], {
    allowFailure: true,
  });
  if (origin.exitCode !== 0) return;
  const desiredRules = [
    "+refs/notes/lineage/*:refs/notes/lineage/*",
    "+refs/lineage/intents/*:refs/lineage/intents/*",
  ];
  const rules = await runGit(root, ["config", "--get-all", "remote.origin.fetch"], {
    allowFailure: true,
  });
  const existing = new Set(rules.stdout.split("\n").filter(Boolean));
  for (const rule of desiredRules) {
    if (!existing.has(rule)) await runGit(root, ["config", "--add", "remote.origin.fetch", rule]);
  }
}

async function installPostCommitHook(root: string): Promise<void> {
  const rawGitDirectory = (await runGit(root, ["rev-parse", "--git-dir"])).stdout.trim();
  const gitDirectory = isAbsolute(rawGitDirectory)
    ? rawGitDirectory
    : resolve(root, rawGitDirectory);
  const hookPath = join(gitDirectory, "hooks", "post-commit");
  const hookFile = Bun.file(hookPath);
  const current = (await hookFile.exists()) ? await hookFile.text() : "#!/bin/sh\n";
  if (current.includes("# lineage:start")) return;
  const block = [
    "# lineage:start",
    `if [ -n "\${${LINEAGE_USER_ID_ENV}:-}" ] && command -v lineage >/dev/null 2>&1; then`,
    `  lineage link-commit --commit HEAD --user "\$${LINEAGE_USER_ID_ENV}" --provider "\${${LINEAGE_PROVIDER_ENV}:-claude}" >/dev/null 2>&1 || true`,
    "fi",
    "# lineage:end",
    "",
  ].join("\n");
  await Bun.write(hookPath, `${current.trimEnd()}\n\n${block}`);
  await chmod(hookPath, 0o755);
}

function matchesTimeline(
  files: readonly string[],
  symbols: readonly string[],
  filter: TimelineFilter,
): boolean {
  if (filter.path && !files.some((file) => file.includes(filter.path!) || filter.path!.includes(file))) {
    return false;
  }
  if (
    filter.symbol &&
    !symbols.some((symbol) => symbol.toLowerCase().includes(filter.symbol!.toLowerCase()))
  ) {
    return false;
  }
  return true;
}
