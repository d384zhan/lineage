import type {
  Actor,
  LineageCommand,
  TimelineFilter,
} from "@lineage/contracts";
import { ProviderSchema } from "@lineage/contracts";
import { DefaultLineageCore } from "@lineage/core";
import { GitLineageRepository } from "@lineage/git-store";
import { CommandArguments, parseAssumptions } from "./args";

async function withCore<T>(cwd: string, action: (
  core: DefaultLineageCore,
  repository: GitLineageRepository,
) => Promise<T>): Promise<T> {
  const repository = await GitLineageRepository.open(cwd);
  try {
    return await action(
      new DefaultLineageCore({ store: repository, commitInspector: repository }),
      repository,
    );
  } finally {
    repository.close();
  }
}

function actorFrom(args: CommandArguments): Actor {
  const providerValue = args.get("provider");
  const provider = providerValue
    ? ProviderSchema.parse(providerValue)
    : undefined;
  return {
    userId: args.get("user") ?? process.env.USER ?? "unknown",
    ...(provider ? { provider } : {}),
    ...(args.get("session") ? { sessionId: args.get("session") } : {}),
  };
}

export const initCommand: LineageCommand = {
  name: "init",
  description: "Initialize Lineage in the current Git repository",
  async run(_args, context) {
    const repository = await GitLineageRepository.initialize(context.cwd);
    try {
      return {
        repoId: await repository.getRepoId(),
        root: repository.root,
        notes: ["refs/notes/lineage/decisions", "refs/notes/lineage/intents"],
      };
    } finally {
      repository.close();
    }
  },
};

export const announceCommand: LineageCommand = {
  name: "announce",
  description: "Publish a structured implementation intent",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    return withCore(context.cwd, async (core, repository) =>
      core.announce({
        repoId: await repository.getRepoId(),
        author: actorFrom(args),
        summary: args.require("summary"),
        files: args.all("file"),
        symbols: args.all("symbol"),
        assumptions: parseAssumptions(args.all("assume")),
      }),
    );
  },
};

export const completeCommand: LineageCommand = {
  name: "complete",
  description: "Complete or cancel an active intent",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    const rawStatus = args.get("status") ?? "completed";
    if (rawStatus !== "completed" && rawStatus !== "cancelled") {
      throw new Error("--status must be completed or cancelled");
    }
    return withCore(context.cwd, (core) =>
      core.updateIntent({
        intentId: args.require("intent"),
        status: rawStatus,
        ...(args.get("commit") ? { commitSha: args.get("commit") } : {}),
      }),
    );
  },
};

export const linkCommitCommand: LineageCommand = {
  name: "link-commit",
  description: "Attach the active session reasoning to a Git commit",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    return withCore(context.cwd, (core) =>
      core.linkCommit({
        commitSha: args.get("commit") ?? "HEAD",
        author: actorFrom(args),
        ...(args.get("rationale") ? { rationale: args.get("rationale") } : {}),
        alternatives: args.all("alternative"),
        assumptions: parseAssumptions(args.all("assume")),
        symbols: args.all("symbol"),
        evidence: args.all("evidence").map((value) => ({
          kind: "agent_answer" as const,
          value,
        })),
        ...(args.get("request")
          ? { sourceRequestId: args.get("request") }
          : {}),
      }),
    );
  },
};

export const whyCommand: LineageCommand = {
  name: "why",
  description: "Find decisions that explain a file, symbol, or text query",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    const explicit = args.get("path") || args.get("symbol") || args.get("text");
    const fallback = args.positional.join(" ");
    if (!explicit && !fallback) throw new Error("Provide a query or --path/--symbol/--text");
    return withCore(context.cwd, (core) =>
      core.why({
        ...(args.get("path") ? { path: args.get("path") } : {}),
        ...(args.get("symbol") ? { symbol: args.get("symbol") } : {}),
        ...(args.get("text") ? { text: args.get("text") } : {}),
        ...(!explicit && fallback
          ? { path: fallback, symbol: fallback, text: fallback }
          : {}),
      }),
    );
  },
};

export const timelineCommand: LineageCommand = {
  name: "timeline",
  description: "Show intent and decision chronology",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    const fallbackPath = args.positional[0];
    const filter: TimelineFilter = {
      ...(args.get("path") || fallbackPath ? { path: args.get("path") ?? fallbackPath } : {}),
      ...(args.get("symbol") ? { symbol: args.get("symbol") } : {}),
      ...(args.get("limit") ? { limit: Number(args.get("limit")) } : {}),
    };
    return withCore(context.cwd, (core) => core.timeline(filter));
  },
};

export const syncCommand: LineageCommand = {
  name: "sync",
  description: "Push or fetch Lineage Git refs through origin",
  async run(rawArgs, context) {
    const args = new CommandArguments(rawArgs);
    const requested = args.get("mode") ?? "both";
    if (requested !== "pull" && requested !== "push" && requested !== "both") {
      throw new Error("--mode must be pull, push, or both");
    }
    const repository = await GitLineageRepository.open(context.cwd);
    try {
      return await repository.sync(requested);
    } finally {
      repository.close();
    }
  },
};

export const historyCommands: readonly LineageCommand[] = [
  initCommand,
  announceCommand,
  completeCommand,
  linkCommitCommand,
  whyCommand,
  timelineCommand,
  syncCommand,
];
