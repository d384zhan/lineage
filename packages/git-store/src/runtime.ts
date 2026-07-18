import type { LineageCore } from "@lineage/contracts";
import { DefaultLineageCore } from "@lineage/core";
import { GitLineageRepository } from "./repository";

export interface GitLineageRuntime {
  core: LineageCore;
  repoId: string;
  root: string;
  close(): void;
}

export async function openGitLineageRuntime(cwd: string): Promise<GitLineageRuntime> {
  const repository = await GitLineageRepository.open(cwd);
  const core = new DefaultLineageCore({
    store: repository,
    commitInspector: repository,
  });
  return {
    core,
    repoId: await repository.getRepoId(),
    root: repository.root,
    close: () => repository.close(),
  };
}
