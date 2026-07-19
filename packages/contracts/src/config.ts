import { z } from "zod";
import { IdentifierSchema, PROTOCOL_VERSION } from "./domain";

export const LINEAGE_DIRECTORY = ".lineage";
/** Filename inside `<git-dir>/lineage`; never written to the worktree. */
export const LINEAGE_REPOSITORY_CONFIG = "repo.json";
/** Read-only migration path used by Lineage versions before 0.2. */
export const LINEAGE_LEGACY_REPOSITORY_CONFIG = ".lineage/repo.json";
export const LINEAGE_GIT_DIRECTORY = "lineage";
export const DECISIONS_NOTES_REF = "refs/notes/lineage/decisions";
export const INTENTS_NOTES_REF = "refs/notes/lineage/intents";
export const INTENTS_REFS_PREFIX = "refs/lineage/intents";

export const RepositoryConfigSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  repoId: IdentifierSchema,
});

export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;
