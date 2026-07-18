import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  DECISIONS_NOTES_REF,
  DecisionRecordSchema,
  INTENTS_NOTES_REF,
  IntentRecordSchema,
  LINEAGE_GIT_DIRECTORY,
  LINEAGE_PROVIDER_ENV,
  LINEAGE_REPOSITORY_CONFIG,
  LINEAGE_SESSION_ID_ENV,
  LINEAGE_USER_ID_ENV,
  PROTOCOL_VERSION,
  RepositoryConfigSchema,
  SessionEventSchema,
  type DecisionRecord,
  type HistoryQuery,
  type IntentRecord,
  type RepositoryConfig,
  type SessionEvent,
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
  private readonly database: Database;
  private readonly config: RepositoryConfig;

  private constructor(
    root: string,
    gitDirectory: string,
    database: Database,
    config: RepositoryConfig,
  ) {
    this.root = root;
    this.gitDirectory = gitDirectory;
    this.database = database;
    this.config = config;
    this.initializeSchema();
  }

  static async initialize(cwd: string): Promise<GitLineageRepository> {
    const root = await findRepositoryRoot(cwd);
    const configPath = join(root, LINEAGE_REPOSITORY_CONFIG);
    const existing = Bun.file(configPath);
    let config: RepositoryConfig;
    if (await existing.exists()) {
      config = RepositoryConfigSchema.parse(await existing.json());
    } else {
      config = { protocolVersion: PROTOCOL_VERSION, repoId: crypto.randomUUID() };
      await mkdir(dirname(configPath), { recursive: true });
      await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    await configureNotes(root);
    await installPostCommitHook(root);
    return GitLineageRepository.open(root);
  }

  static async open(cwd: string): Promise<GitLineageRepository> {
    const root = await findRepositoryRoot(cwd);
    const configPath = join(root, LINEAGE_REPOSITORY_CONFIG);
    if (!(await Bun.file(configPath).exists())) {
      throw new Error("Lineage is not initialized. Run `lineage init` first.");
    }
    const config = RepositoryConfigSchema.parse(await Bun.file(configPath).json());
    const rawGitDirectory = (await runGit(root, ["rev-parse", "--git-dir"])).stdout.trim();
    const gitDirectory = isAbsolute(rawGitDirectory)
      ? rawGitDirectory
      : resolve(root, rawGitDirectory);
    const lineageDirectory = join(gitDirectory, LINEAGE_GIT_DIRECTORY);
    await mkdir(lineageDirectory, { recursive: true });
    const database = new Database(join(lineageDirectory, "lineage.sqlite"), {
      create: true,
    });
    return new GitLineageRepository(root, gitDirectory, database, config);
  }

  close(): void {
    this.database.close();
  }

  async getRepoId(): Promise<string> {
    return this.config.repoId;
  }

  async appendSessionEvent(event: SessionEvent): Promise<void> {
    const parsed = SessionEventSchema.parse(event);
    this.database
      .query(`
        INSERT INTO session_events (id, session_id, provider, kind, content, created_at)
        VALUES ($id, $sessionId, $provider, $kind, $content, $createdAt)
        ON CONFLICT(id) DO NOTHING
      `)
      .run({
        $id: parsed.id,
        $sessionId: parsed.sessionId,
        $provider: parsed.provider,
        $kind: parsed.kind,
        $content: parsed.content,
        $createdAt: parsed.createdAt,
      });
  }

  async getSessionEvents(sessionId: string): Promise<SessionEvent[]> {
    const rows = this.database
      .query("SELECT record_json FROM session_events_view WHERE session_id = ? ORDER BY created_at")
      .all(sessionId) as Array<{ record_json: string }>;
    return rows.map((row) => SessionEventSchema.parse(JSON.parse(row.record_json)));
  }

  async saveIntent(intent: IntentRecord, options: SaveIntentOptions = {}): Promise<void> {
    const parsed = IntentRecordSchema.parse(intent);
    this.database
      .query(`
        INSERT INTO intents (id, repo_id, status, created_at, record_json)
        VALUES ($id, $repoId, $status, $createdAt, $record)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          record_json = excluded.record_json
      `)
      .run({
        $id: parsed.id,
        $repoId: parsed.repoId,
        $status: parsed.status,
        $createdAt: parsed.createdAt,
        $record: JSON.stringify(parsed),
      });
    if (options.commitSha && parsed.status !== "active") {
      await this.appendNote(INTENTS_NOTES_REF, options.commitSha, parsed, IntentRecordSchema);
    }
  }

  async getIntent(intentId: string): Promise<IntentRecord | undefined> {
    const row = this.database
      .query("SELECT record_json FROM intents WHERE id = ?")
      .get(intentId) as { record_json: string } | null;
    return row ? IntentRecordSchema.parse(JSON.parse(row.record_json)) : undefined;
  }

  async listIntents(filter: TimelineFilter = {}): Promise<IntentRecord[]> {
    const rows = this.database
      .query("SELECT record_json FROM intents ORDER BY created_at DESC")
      .all() as Array<{ record_json: string }>;
    return rows
      .map((row) => IntentRecordSchema.parse(JSON.parse(row.record_json)))
      .filter((intent) => matchesTimeline(intent.files, intent.symbols, filter))
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

  private initializeSchema(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_events_session
        ON session_events(session_id, created_at);
      CREATE VIEW IF NOT EXISTS session_events_view AS
        SELECT
          session_id,
          created_at,
          json_object(
            'id', id,
            'sessionId', session_id,
            'provider', provider,
            'kind', kind,
            'content', content,
            'createdAt', created_at
          ) AS record_json
        FROM session_events;
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS intents_status ON intents(status, created_at);
    `);
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

async function configureNotes(root: string): Promise<void> {
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
  if (origin.exitCode === 0) {
    const fetchRule = "+refs/notes/lineage/*:refs/notes/lineage/*";
    const rules = await runGit(root, ["config", "--get-all", "remote.origin.fetch"], {
      allowFailure: true,
    });
    if (!rules.stdout.split("\n").includes(fetchRule)) {
      await runGit(root, ["config", "--add", "remote.origin.fetch", fetchRule]);
    }
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
    `if [ -n "\${${LINEAGE_SESSION_ID_ENV}:-}" ] && command -v lineage >/dev/null 2>&1; then`,
    `  lineage link-commit --commit HEAD --session "\$${LINEAGE_SESSION_ID_ENV}" --user "\${${LINEAGE_USER_ID_ENV}:-unknown}" --provider "\${${LINEAGE_PROVIDER_ENV}:-claude}" >/dev/null 2>&1 || true`,
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
