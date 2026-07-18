import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGit } from "@lineage/git-store";
import {
  announceCommand,
  initCommand,
  linkCommitCommand,
  timelineCommand,
  whyCommand,
} from "./commands";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lineage-commands-"));
  temporaryDirectories.push(directory);
  await runGit(directory, ["init", "-b", "main"]);
  return directory;
}

describe("history commands", () => {
  test("initialize and announce through the public command contract", async () => {
    const cwd = await createRepository();
    const initialized = await initCommand.run([], { cwd, json: true }) as {
      repoId: string;
    };

    const first = await announceCommand.run(
      [
        "--user", "alice",
        "--summary", "Use secure cookies",
        "--file", "src/auth.ts",
        "--assume", "auth.storage=cookie",
      ],
      { cwd, json: true },
    ) as { conflicts: unknown[] };
    const second = await announceCommand.run(
      [
        "--user", "bob",
        "--summary", "Use browser storage",
        "--file", "src/auth.ts",
        "--assume", "auth.storage=localStorage",
      ],
      { cwd, json: true },
    ) as { conflicts: unknown[] };
    const timeline = await timelineCommand.run([], { cwd, json: true }) as {
      entries: unknown[];
    };

    expect(initialized.repoId).toBeTruthy();
    expect(first.conflicts).toHaveLength(0);
    expect(second.conflicts).toHaveLength(1);
    expect(timeline.entries).toHaveLength(2);
    expect(await Bun.file(join(cwd, ".lineage/repo.json")).exists()).toBeTrue();
  });

  test("links a commit and resolves positional why queries as paths", async () => {
    const cwd = await createRepository();
    await runGit(cwd, ["config", "user.name", "Lineage Test"]);
    await runGit(cwd, ["config", "user.email", "lineage@example.com"]);
    await Bun.write(join(cwd, "auth.ts"), "export const storage = 'cookie';\n");
    await runGit(cwd, ["add", "auth.ts"]);
    await runGit(cwd, ["commit", "-m", "Add secure token storage"]);
    await initCommand.run([], { cwd, json: true });
    await announceCommand.run(
      [
        "--user", "alice",
        "--session", "session-1",
        "--summary", "Use secure cookies",
        "--file", "auth.ts",
        "--symbol", "storage",
        "--assume", "auth.storage=cookie",
      ],
      { cwd, json: true },
    );
    const decision = await linkCommitCommand.run(
      ["--commit", "HEAD", "--session", "session-1", "--user", "alice"],
      { cwd, json: true },
    ) as { assumptions: unknown[]; symbols: string[] };
    const why = await whyCommand.run(["auth.ts"], { cwd, json: true }) as {
      matches: Array<{ matchedBy: string[] }>;
    };

    expect(decision.assumptions).toHaveLength(1);
    expect(decision.symbols).toEqual(["storage"]);
    expect(why.matches).toHaveLength(1);
    expect(why.matches[0]?.matchedBy).toContain("path");
  });
});
