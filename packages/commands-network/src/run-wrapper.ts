import {
  LINEAGE_PROVIDER_ENV,
  LINEAGE_SESSION_ID_ENV,
  LINEAGE_USER_ID_ENV,
  type Provider,
  type SessionEvent,
} from "@lineage/contracts";
import {
  DaemonClient,
  readNetworkSettings,
  resolveExecutable,
  resolveStateDir,
  findRepoRoot,
} from "@lineage/daemon";
import {
  claudeTranscriptDir,
  startTranscriptTailer,
  type TranscriptTailer,
} from "./transcript-tail";
import {
  codexConfigHasLineage,
  codexConfigSnippet,
  ensureClaudeMcpConfig,
} from "./mcp-register";

export interface RunAgentOptions {
  cwd: string;
  provider: Provider;
  extraArgs?: string[];
  userId?: string;
  print?: (line: string) => void;
  /** Test seam: full command to spawn instead of the real agent CLI. */
  agentCommand?: string[];
  /** Test seam: transcript directory override. */
  transcriptDir?: string;
  spawn?: (
    command: string[],
    env: Record<string, string | undefined>,
    cwd: string,
  ) => Promise<number>;
}

export interface RunAgentResult {
  sessionId: string;
  exitCode: number;
  captured: boolean;
}

async function defaultSpawn(
  command: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<number> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const print = options.print ?? ((line: string) => console.log(line));
  const repoRoot = findRepoRoot(options.cwd);
  if (!repoRoot) throw new Error(`Not inside a Git repository: ${options.cwd}`);

  const stateDir = resolveStateDir(options.cwd);
  const network = await readNetworkSettings(stateDir);
  const userId = options.userId ?? network?.userId ?? process.env.USER ?? "unknown";

  let daemon: DaemonClient | undefined;
  try {
    daemon = await DaemonClient.open(options.cwd);
  } catch {
    print(
      "Note: the lineage daemon is not running — teammates will not see live activity. Start `lineage daemon` in another terminal.",
    );
  }

  if (options.provider === "claude") {
    const outcome = await ensureClaudeMcpConfig(repoRoot);
    if (outcome !== "unchanged") print(`Registered lineage MCP server in .mcp.json (${outcome}).`);
  } else {
    if (!(await codexConfigHasLineage())) {
      print("Codex is missing the lineage MCP server. Add this to ~/.codex/config.toml:");
      print("");
      print(codexConfigSnippet());
      print("");
    }
  }

  const sessionId = crypto.randomUUID();
  const emit = async (event: SessionEvent): Promise<void> => {
    await daemon?.sessionEvent(event).catch(() => {});
  };
  await emit({
    id: crypto.randomUUID(),
    sessionId,
    provider: options.provider,
    kind: "user_prompt",
    content: `[session started via lineage run ${options.provider}]`,
    createdAt: new Date().toISOString(),
  });

  let tailer: TranscriptTailer | undefined;
  if (options.provider === "claude" || options.transcriptDir) {
    tailer = startTranscriptTailer({
      transcriptDir: options.transcriptDir ?? claudeTranscriptDir(options.cwd),
      since: Date.now(),
      sessionId,
      provider: options.provider,
      emit,
      log: print,
    });
  }

  const requested = options.agentCommand ?? [options.provider, ...(options.extraArgs ?? [])];
  const command = options.agentCommand ?? resolveExecutable(requested);
  if (!command) {
    await tailer?.stop();
    throw new Error(
      `Cannot find the ${options.provider} CLI on PATH. Install it, then re-run \`lineage run ${options.provider}\`.`,
    );
  }

  print(`Starting ${options.provider} (lineage session ${sessionId})...`);
  const spawn = options.spawn ?? defaultSpawn;
  const exitCode = await spawn(
    command,
    {
      [LINEAGE_SESSION_ID_ENV]: sessionId,
      [LINEAGE_USER_ID_ENV]: userId,
      [LINEAGE_PROVIDER_ENV]: options.provider,
    },
    options.cwd,
  );
  await tailer?.stop();
  print("");
  print(
    `Session ${sessionId} ended. Link your next commit to it with:\n  lineage link-commit --commit <sha> --session ${sessionId} --user ${userId}`,
  );
  return { sessionId, exitCode, captured: daemon !== undefined };
}
