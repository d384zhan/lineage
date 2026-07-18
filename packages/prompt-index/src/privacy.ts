import { createHash } from "node:crypto";

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "because", "been", "before",
  "being", "but", "can", "could", "did", "does", "doing", "for", "from", "have",
  "into", "just", "like", "make", "not", "now", "that", "the", "their", "then",
  "there", "these", "they", "this", "those", "through", "use", "want", "was",
  "were", "what", "when", "where", "which", "why", "will", "with", "would", "you",
  "your",
]);

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function termHashes(text: string): string[] {
  const terms = text
    .toLowerCase()
    .match(/[a-z0-9_./-]{3,}/g)
    ?.filter((term) => !STOP_WORDS.has(term)) ?? [];
  return [...new Set(terms)].slice(0, 96).map(sha256);
}

export function overlapCount(left: readonly string[], right: readonly string[]): number {
  const rightSet = new Set(right);
  return left.reduce((count, value) => count + Number(rightSet.has(value)), 0);
}
