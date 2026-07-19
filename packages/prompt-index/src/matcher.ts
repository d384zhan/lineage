import { isAbsolute, relative } from "node:path";
import type { EvidenceRef } from "@lineage/contracts";
import { canonicalRepoPath } from "./paths";
import { overlapCount, termHashes } from "./privacy";
import type { CodeLineTrace, PromptCandidate, PromptIndexEntry, PromptMatchResult } from "./types";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim());
  return new TextDecoder().decode(result.stdout).trim();
}

export function parseLineSpec(spec: string): { path: string; line: number } {
  const match = spec.match(/^(.+):(\d+)$/);
  if (!match?.[1] || !match[2]) throw new Error("Code location must use path:line, e.g. src/auth.ts:42");
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) throw new Error("Line number must be positive");
  return { path: match[1], line };
}

export async function traceCodeLine(cwd: string, spec: string): Promise<CodeLineTrace> {
  const { path, line } = parseLineSpec(spec);
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const repoPath = canonicalRepoPath(isAbsolute(path) ? relative(root, path) : path);
  const output = await git(root, [
    "blame", "--porcelain", `-L${line},${line}`, "--", repoPath,
  ]);
  const rows = output.split("\n");
  const commitSha = rows[0]?.split(" ")[0] ?? "";
  const value = (key: string) => rows.find((row) => row.startsWith(`${key} `))?.slice(key.length + 1) ?? "";
  const epoch = Number(value("author-time"));
  return {
    path: repoPath,
    line,
    commitSha,
    author: value("author"),
    authoredAt: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : new Date(0).toISOString(),
    summary: value("summary"),
  };
}

function scoreEntry(entry: PromptIndexEntry, trace: CodeLineTrace, queryHashes: string[]): PromptCandidate | undefined {
  const promptTime = Date.parse(entry.timestamp);
  const commitTime = Date.parse(trace.authoredAt);
  const distanceHours = Math.abs(commitTime - promptTime) / 3_600_000;
  if (!Number.isFinite(distanceHours) || distanceHours > 24 * 14) return undefined;
  let score = 0;
  const reasons: string[] = [];
  const tracePath = canonicalRepoPath(trace.path);
  const fileMatch = entry.files.some((file) => {
    const indexedPath = canonicalRepoPath(file);
    return indexedPath === tracePath || indexedPath.endsWith(`/${tracePath}`);
  });
  if (fileMatch) {
    score += 55;
    reasons.push("prompt references the blamed file");
  }
  if (promptTime <= commitTime + 30 * 60_000) {
    score += Math.max(0, 30 - distanceHours * 2);
    reasons.push(`${distanceHours.toFixed(1)}h from the commit`);
  }
  const overlap = overlapCount(entry.termHashes, queryHashes);
  if (overlap) {
    score += Math.min(20, overlap * 4);
    reasons.push(`${overlap} matching code/diff terms`);
  }
  if (!fileMatch && score < 12) return undefined;
  return {
    entry,
    score: Math.round(score),
    confidence: score >= 65 ? "high" : score >= 35 ? "medium" : "low",
    reasons,
  };
}

export async function matchPromptsForLine(
  cwd: string,
  spec: string,
  repoId: string,
  entries: readonly PromptIndexEntry[],
): Promise<PromptMatchResult> {
  const trace = await traceCodeLine(cwd, spec);
  const diff = await git(cwd, ["show", "--format=%s%n%b", "--no-ext-diff", "--unified=2", trace.commitSha, "--", trace.path]);
  const hashes = termHashes(`${trace.summary}\n${diff}`);
  const candidates = entries
    .filter((entry) => entry.repoId === repoId)
    .map((entry) => scoreEntry(entry, trace, hashes))
    .filter((candidate): candidate is PromptCandidate => candidate !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return { trace, candidates };
}

export function lineSpecFromEvidence(evidence: readonly EvidenceRef[]): string | undefined {
  return evidence.find((item) => item.kind === "file" && /:\d+$/.test(item.value))?.value;
}
