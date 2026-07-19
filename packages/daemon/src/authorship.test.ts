import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectGitIdentities,
  parseGitIdentity,
  resolveGitIdentities,
} from "@lineage/git-store";
import { resolveRepositoryAuthorship } from "./authorship";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "lineage-authorship-"));
  dirs.push(cwd);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd }).exitCode).toBe(0);
  return cwd;
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function commitAs(cwd: string, name: string, email: string, file: string, summary: string) {
  git(cwd, ["config", "user.name", name]);
  git(cwd, ["config", "user.email", email]);
  await Bun.write(join(cwd, file), `${summary}\n`);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-qm", summary]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("Git identity attribution", () => {
  test("detects the repo identity and parses explicit aliases", () => {
    const cwd = repo();
    git(cwd, ["config", "user.name", "Bob"]);
    git(cwd, ["config", "user.email", "bob@example.com"]);
    const alias = parseGitIdentity("Bob Dev <bob.dev@example.com>");
    expect(detectGitIdentities(cwd, [alias])).toEqual([
      { name: "Bob", email: "bob@example.com" },
      alias,
    ]);
    expect(() => parseGitIdentity("not an identity")).toThrow("Name <email@example.com>");
  });

  test("prefers the current repo identity over saved session identities", () => {
    const cwd = repo();
    git(cwd, ["config", "user.name", "Bob"]);
    git(cwd, ["config", "user.email", "bob@example.com"]);
    const saved = JSON.stringify([{ name: "Old Name", email: "old@example.com" }]);

    expect(resolveGitIdentities(cwd, saved)).toEqual([
      { name: "Bob", email: "bob@example.com" },
      { name: "Old Name", email: "old@example.com" },
    ]);
  });

  test("separates recipient commits from referenced teammate commits", async () => {
    const cwd = repo();
    const aliceSha = await commitAs(cwd, "Alice", "alice@example.com", "cart.ts", "Build cart");
    await commitAs(cwd, "Bob", "bob@example.com", "checkout.ts", "Build checkout");
    git(cwd, ["notes", "add", "-m", "Structured Lineage note", aliceSha]);
    const result = await resolveRepositoryAuthorship(
      cwd,
      {
        userId: "bob",
        provider: "claude",
        gitIdentities: [{ name: "Bob", email: "bob@example.com" }],
      },
      {
        text: "Have you implemented anything?",
        evidence: [{ kind: "commit", value: aliceSha }],
      },
    );
    expect(result?.recipientCommitCount).toBe(1);
    expect(result?.inspectedCommitCount).toBe(2);
    expect(result?.recentRecipientCommits[0]?.summary).toBe("Build checkout");
    expect(result?.referencedCommits[0]).toMatchObject({
      sha: aliceSha,
      summary: "Build cart",
      belongsToRecipient: false,
      author: { name: "Alice", email: "alice@example.com" },
    });
  });
});
