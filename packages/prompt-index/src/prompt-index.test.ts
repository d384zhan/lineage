import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchPromptsForLine } from "./matcher";
import { readExactPrompt } from "./providers";
import { refreshPromptIndex } from "./store";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
  temporary.length = 0;
});

function temp(name: string): string {
  const path = mkdtempSync(join(tmpdir(), name));
  temporary.push(path);
  return path;
}

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

describe("private global prompt index", () => {
  test("indexes Claude and Codex pointers without copying prompt text", async () => {
    const repo = temp("lineage-index-repo-");
    git(repo, ["init", "-q"]);
    mkdirSync(join(repo, ".lineage"), { recursive: true });
    await Bun.write(join(repo, ".lineage", "repo.json"), JSON.stringify({ protocolVersion: 1, repoId: "repo-1" }));

    const claudeRoot = temp("lineage-index-claude-");
    const codexRoot = temp("lineage-index-codex-");
    const timestamp = new Date().toISOString();
    const claudePrompt = "Implement secure cookie authentication for server rendering";
    await Bun.write(join(claudeRoot, "claude.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "claude-1", promptId: "prompt-1", cwd: repo, gitBranch: "main", timestamp, message: { content: claudePrompt } }),
      JSON.stringify({ type: "assistant", cwd: repo, message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: join(repo, "src", "auth.ts") } }] } }),
    ].join("\n") + "\n");

    const codexPrompt = "Add refresh token replay protection";
    await Bun.write(join(codexRoot, "codex.jsonl"), [
      JSON.stringify({ type: "session_meta", timestamp, payload: { id: "codex-1", cwd: repo } }),
      JSON.stringify({ type: "event_msg", timestamp, payload: { type: "user_message", message: codexPrompt } }),
      JSON.stringify({ type: "response_item", timestamp, payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ patch: "*** Update File: src/token.ts" }) } }),
    ].join("\n") + "\n");

    const indexPath = join(repo, ".git", "lineage", "prompt-index.json");
    const index = await refreshPromptIndex({ indexPath, claudeRoot, codexRoot });
    expect(index.entries).toHaveLength(2);
    expect(index.entries.map((entry) => entry.provider).sort()).toEqual(["claude", "codex"]);
    expect(index.entries.find((entry) => entry.provider === "claude")?.files).toContain("src/auth.ts");
    expect(index.entries.find((entry) => entry.provider === "codex")?.files).toContain("src/token.ts");
    const stored = await Bun.file(indexPath).text();
    expect(stored).not.toContain(claudePrompt);
    expect(stored).not.toContain(codexPrompt);
    expect(await readExactPrompt(index.entries.find((entry) => entry.provider === "claude")!)).toBe(claudePrompt);
    expect(await readExactPrompt(index.entries.find((entry) => entry.provider === "codex")!)).toBe(codexPrompt);
  });

  test("matches a blamed line to the prompt whose tools edited that file", async () => {
    const repo = temp("lineage-match-repo-");
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    mkdirSync(join(repo, ".lineage"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    await Bun.write(join(repo, ".lineage", "repo.json"), JSON.stringify({ protocolVersion: 1, repoId: "repo-1" }));
    const promptTime = new Date().toISOString();
    const claudeRoot = temp("lineage-match-claude-");
    const codexRoot = temp("lineage-match-codex-");
    await Bun.write(join(claudeRoot, "session.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "session-auth", cwd: repo, timestamp: promptTime, message: { content: "Use an httpOnly cookie so auth works during server rendering" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: join(repo, "src", "auth.ts") } }] } }),
    ].join("\n") + "\n");
    await Bun.write(join(repo, "src", "auth.ts"), "export const cookieName = 'session';\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "Add cookie authentication"]);

    const index = await refreshPromptIndex({
      indexPath: join(repo, ".git", "lineage", "index.json"),
      claudeRoot,
      codexRoot,
    });
    const result = await matchPromptsForLine(repo, "src/auth.ts:1", "repo-1", index.entries);
    expect(result.trace.summary).toBe("Add cookie authentication");
    expect(result.candidates[0]?.confidence).toBe("high");
    expect(result.candidates[0]?.entry.sessionId).toBe("session-auth");
    expect(await readExactPrompt(result.candidates[0]!.entry)).toContain("httpOnly cookie");
  });
});
