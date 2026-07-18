import type { Provider } from "@lineage/contracts";

export interface PromptPointer {
  provider: Provider;
  sourcePath: string;
  sourceLine: number;
  promptHash: string;
}

export interface PromptIndexEntry extends PromptPointer {
  id: string;
  sessionId: string;
  promptId?: string;
  timestamp: string;
  cwd?: string;
  repoId?: string;
  branch?: string;
  termHashes: string[];
  files: string[];
}

export interface PromptIndexFile {
  version: 1;
  updatedAt: string;
  entries: PromptIndexEntry[];
}

export interface PromptCandidate {
  entry: PromptIndexEntry;
  score: number;
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

export interface CodeLineTrace {
  path: string;
  line: number;
  commitSha: string;
  author: string;
  authoredAt: string;
  summary: string;
}

export interface PromptMatchResult {
  trace: CodeLineTrace;
  candidates: PromptCandidate[];
}
