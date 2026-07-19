import {
  LINEAGE_PROVIDER_ENV,
  LINEAGE_CHANNEL_ENV,
  LINEAGE_GIT_IDENTITIES_ENV,
  LINEAGE_SESSION_ID_ENV,
  LINEAGE_USER_ID_ENV,
  type Provider,
} from "@lineage/contracts";
import { refreshPromptIndex } from "@lineage/prompt-index";
import {
  DaemonClient,
  detectGitIdentities,
  readRepoId,
  readNetworkSettings,
  resolveExecutable,
  resolveStateDir,
  findRepoRoot,
  startDaemon,
  type DaemonHandle,
} from "@lineage/daemon";

export interface RunAgentOptions {
  cwd: string;
  provider: Provider;
  extraArgs?: string[];
  userId?: string;
  channel?: boolean;
  print?: (line: string) => void;
  /** Test seam: full command to spawn instead of the real agent CLI. */
  agentCommand?: string[];
  /** Test seam: index source/path overrides. */
  indexOptions?: Parameters<typeof refreshPromptIndex>[0];
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
  await readRepoId(options.cwd);

  const stateDir = resolveStateDir(options.cwd);
  const network = await readNetworkSettings(stateDir);
  const userId = options.userId ?? network?.userId ?? process.env.USER ?? "unknown";
  const gitIdentities = detectGitIdentities(options.cwd, network?.gitIdentities ?? []);

  const sessionId = crypto.randomUUID();
  const extraArgs = options.extraArgs ?? [];
  const channelArgs =
    options.provider === "claude" &&
    options.channel === true &&
    !extraArgs.includes("--dangerously-load-development-channels")
      ? ["--dangerously-load-development-channels", "server:lineage"]
      : [];
  const requested = options.agentCommand ?? [
    options.provider,
    ...channelArgs,
    ...extraArgs,
  ];
  const command = options.agentCommand ?? resolveExecutable(requested);
  if (!command) {
    throw new Error(
      `Cannot find the ${options.provider} CLI on PATH. Install it, then re-run \`lineage run ${options.provider}\`.`,
    );
  }

  let ownedDaemon: DaemonHandle | undefined;
  try {
    await DaemonClient.open(options.cwd);
  } catch {
    if (network) {
      ownedDaemon = await startDaemon({
        cwd: options.cwd,
        approvalMode: "external",
        io: {
          // The agent TUI owns stdout after launch. Background daemon output
          // would be interpreted as text typed into its active composer.
          print: () => {},
          prompt: async () => {
            throw new Error("Interactive approval belongs in the active coding-agent session");
          },
        },
      });
      print("Lineage messaging is online in this session.");
    } else {
      print("Lineage messaging is offline. Run `lineage join` to connect this repo.");
    }
  }

  print(`Starting ${options.provider} (lineage session ${sessionId})...`);
  const spawn = options.spawn ?? defaultSpawn;
  let exitCode: number;
  try {
    exitCode = await spawn(
      command,
      {
        [LINEAGE_SESSION_ID_ENV]: sessionId,
        [LINEAGE_USER_ID_ENV]: userId,
        [LINEAGE_PROVIDER_ENV]: options.provider,
        ...(gitIdentities.length
          ? { [LINEAGE_GIT_IDENTITIES_ENV]: JSON.stringify(gitIdentities) }
          : {}),
        ...(options.channel ? { [LINEAGE_CHANNEL_ENV]: "1" } : {}),
      },
      options.cwd,
    );
  } finally {
    await ownedDaemon?.stop();
  }
  let captured = false;
  try {
    await refreshPromptIndex(options.indexOptions);
    captured = true;
  } catch (error) {
    print(`prompt index refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  print("");
  print(
    `Session ${sessionId} ended. Link your next commit to it with:\n  lineage link-commit --commit <sha> --session ${sessionId} --user ${userId}`,
  );
  return { sessionId, exitCode, captured };
}
