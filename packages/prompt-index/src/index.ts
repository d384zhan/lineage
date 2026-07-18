export { matchPromptsForLine, parseLineSpec, traceCodeLine, lineSpecFromEvidence } from "./matcher";
export { readExactPrompt } from "./providers";
export { defaultIndexPath, defaultTranscriptRoots, loadPromptIndex, refreshPromptIndex } from "./store";
export type { RefreshIndexOptions } from "./store";
export type {
  CodeLineTrace,
  PromptCandidate,
  PromptIndexEntry,
  PromptIndexFile,
  PromptMatchResult,
  PromptPointer,
} from "./types";
