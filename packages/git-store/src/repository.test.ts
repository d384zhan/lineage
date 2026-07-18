import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultLineageCore } from "@lineage/core";
import { DECISIONS_NOTES_REF } from "@lineage/contracts";
import { GitLineageRepository } from "./repository";
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
  test("persists raw prompts locally and approved decisions in Git notes", async () => {
    const root = await createRepository();
    const repository = await GitLineageRepository.initialize(root);
    const core = new DefaultLineageCore({
      store: repository,
      commitInspector: repository,
      now: () => "2026-07-18T19:00:00.000Z",
      id: () => "decision-1",
    });

    await core.appendSessionEvent({
      id: "event-1",
      sessionId: "session-1",
      provider: "claude",
      kind: "user_prompt",
      content: "private exact prompt",
      createdAt: "2026-07-18T18:00:00.000Z",
    });
    const decision = await core.linkCommit({
      commitSha: "HEAD",
      sessionId: "session-1",
      author: { userId: "alice", provider: "claude" },
      assumptions: [{ key: "auth.storage", value: "cookie" }],
    });

    expect(decision.summary).toBe("Implement token storage");
    expect(decision.rationale).toBe("Keep tokens out of JavaScript");
    expect(decision.files).toEqual(["auth.ts"]);
    expect(decision.promptHashes).toHaveLength(1);
    repository.close();

    const note = await runGit(root, ["notes", `--ref=${DECISIONS_NOTES_REF}`, "show", "HEAD"]);
    expect(note.stdout).toContain("Keep tokens out of JavaScript");
    expect(note.stdout).not.toContain("private exact prompt");

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
});
