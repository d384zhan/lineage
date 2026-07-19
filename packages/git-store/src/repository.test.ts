import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultLineageCore } from "@lineage/core";
import { DECISIONS_NOTES_REF } from "@lineage/contracts";
import { GitLineageRepository, normalizeRemoteUrl } from "./repository";
import { runGit } from "./git";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lineage-test-"));
  temporaryDirectories.push(directory);
  await runGit(directory, ["init", "-b", "main"]);
  await runGit(directory, ["config", "user.name", "Lineage Test"]);
  await runGit(directory, ["config", "user.email", "lineage@example.com"]);
  await Bun.write(join(directory, "auth.ts"), "export const storage = 'cookie';\n");
  await runGit(directory, ["add", "auth.ts"]);
  await runGit(directory, ["commit", "-m", "Implement token storage", "-m", "Keep tokens out of JavaScript"]);
  return directory;
}

describe("GitLineageRepository", () => {
  test("derives the same private repo identity from SSH and HTTPS remotes", async () => {
    const first = await createRepository();
    const second = await createRepository();
    await runGit(first, ["remote", "add", "origin", "git@github.com:Example/Project.git"]);
    await runGit(second, ["remote", "add", "origin", "https://github.com/example/project.git"]);
    const firstRepo = await GitLineageRepository.initialize(first);
    const secondRepo = await GitLineageRepository.initialize(second);
    expect(await firstRepo.getRepoId()).toBe(await secondRepo.getRepoId());
    expect(normalizeRemoteUrl("git@github.com:Example/Project.git")).toBe(
      "github.com/example/project",
    );
    expect(await Bun.file(join(first, ".git", "lineage", "repo.json")).exists()).toBeTrue();
    expect(await Bun.file(join(first, ".lineage", "repo.json")).exists()).toBeFalse();
    firstRepo.close();
    secondRepo.close();
  });

  test("migrates the legacy committed room id into private Git state", async () => {
    const root = await createRepository();
    await mkdir(join(root, ".lineage"));
    await Bun.write(
      join(root, ".lineage", "repo.json"),
      JSON.stringify({ protocolVersion: 1, repoId: "legacy-shared-room" }),
    );
    const repository = await GitLineageRepository.initialize(root);
    expect(await repository.getRepoId()).toBe("legacy-shared-room");
    const local = await Bun.file(join(root, ".git", "lineage", "repo.json")).json();
    expect(local.repoId).toBe("legacy-shared-room");
    repository.close();
  });

  test("stores current intent in a Git ref and approved decisions in Git notes", async () => {
    const root = await createRepository();
    const repository = await GitLineageRepository.initialize(root);
    const core = new DefaultLineageCore({
      store: repository,
      commitInspector: repository,
      now: () => "2026-07-18T19:00:00.000Z",
      id: () => "decision-1",
    });

    await core.announce({
      repoId: await repository.getRepoId(),
      author: { userId: "alice", provider: "claude", sessionId: "session-1" },
      summary: "Use secure cookie storage",
      files: ["auth.ts"],
      symbols: ["storage"],
      assumptions: [{ key: "auth.storage", value: "cookie" }],
    });
    const decision = await core.linkCommit({
      commitSha: "HEAD",
      author: { userId: "alice", provider: "claude", sessionId: "session-1" },
    });

    expect(decision.summary).toBe("Implement token storage");
    expect(decision.rationale).toBe("Keep tokens out of JavaScript");
    expect(decision.files).toEqual(["auth.ts"]);
    expect(decision.assumptions).toEqual([{ key: "auth.storage", value: "cookie" }]);
    expect(decision.evidence.some((item) => item.kind === "intent")).toBeTrue();
    repository.close();

    const note = await runGit(root, ["notes", `--ref=${DECISIONS_NOTES_REF}`, "show", "HEAD"]);
    expect(note.stdout).toContain("Keep tokens out of JavaScript");
    expect(note.stdout).not.toContain("promptHashes");

    const intentRefs = await runGit(root, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/lineage/intents/",
    ]);
    expect(intentRefs.stdout).toContain("refs/lineage/intents/alice-");
    expect(await Bun.file(join(repository.gitDirectory, "lineage/lineage.sqlite")).exists()).toBeFalse();

    const reopened = await GitLineageRepository.open(root);
    const result = await reopened.findDecisions({ path: "auth.ts" });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("decision-1");
    reopened.close();
  });

  test("writes completed intents to their own notes ref", async () => {
    const root = await createRepository();
    const repository = await GitLineageRepository.initialize(root);
    const core = new DefaultLineageCore({
      store: repository,
      commitInspector: repository,
      now: () => "2026-07-18T19:00:00.000Z",
      id: () => "intent-1",
    });
    await core.announce({
      repoId: await repository.getRepoId(),
      author: { userId: "alice" },
      summary: "Change token storage",
      files: ["auth.ts"],
      symbols: ["storage"],
      assumptions: [],
    });
    await core.updateIntent({
      intentId: "intent-1",
      status: "completed",
      commitSha: "HEAD",
    });
    repository.close();

    const note = await runGit(root, [
      "notes",
      "--ref=refs/notes/lineage/intents",
      "show",
      "HEAD",
    ]);
    expect(note.stdout).toContain("Change token storage");
  });

  test("sync pushes only Lineage refs to origin", async () => {
    const root = await createRepository();
    const remote = await mkdtemp(join(tmpdir(), "lineage-remote-"));
    temporaryDirectories.push(remote);
    await runGit(remote, ["init", "--bare"]);
    await runGit(root, ["remote", "add", "origin", remote]);

    const repository = await GitLineageRepository.initialize(root);
    const core = new DefaultLineageCore({
      store: repository,
      commitInspector: repository,
      now: () => "2026-07-18T19:00:00.000Z",
      id: () => "intent-sync",
    });
    await core.announce({
      repoId: await repository.getRepoId(),
      author: { userId: "alice" },
      summary: "Synchronize intent",
      files: ["auth.ts"],
      symbols: [],
      assumptions: [],
    });
    const result = await repository.sync("push");
    repository.close();

    expect(result.pushed.some((reference) => reference.startsWith("refs/lineage/intents/"))).toBeTrue();
    const remoteRefs = await runGit(remote, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/lineage/intents/",
    ]);
    expect(remoteRefs.stdout).toContain("refs/lineage/intents/alice-");
  });
});
