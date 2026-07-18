import {
  LINEAGE_PROVIDER_ENV,
  LINEAGE_USER_ID_ENV,
  renderInboundAgentRequest,
  type InboundAgentRequest,
  type Provider,
} from "@lineage/contracts";

export interface AgentAnswererContext {
  request: InboundAgentRequest;
}

/**
 * Answers an approved question by driving the recipient's own agent. The
 * default implementation spawns a one-shot headless agent CLI in the repo;
 * the rendered prompt instructs it to reply via the lineage_reply MCP tool.
 */
export type AgentAnswerer = (context: AgentAnswererContext) => Promise<void>;

export interface SubAgentOptions {
  cwd: string;
  userId: string;
  provider: Provider | undefined;
  print: (line: string) => void;
  spawn?: (
    command: string[],
    env: Record<string, string | undefined>,
    cwd: string,
  ) => Promise<number>;
}

function headlessCommand(provider: Provider, prompt: string): string[] {
  if (provider === "claude") {
    return ["claude", "-p", prompt, "--allowedTools", "mcp__lineage__*"];
  }
  return ["codex", "exec", prompt];
}

/** Windows npm shims resolve to .cmd files that must run through cmd.exe. */
export function resolveExecutable(command: string[]): string[] | undefined {
  const [name, ...rest] = command;
  const resolved = Bun.which(name!);
  if (!resolved) return undefined;
  if (/\.(cmd|bat)$/i.test(resolved)) return ["cmd", "/c", resolved, ...rest];
  return [resolved, ...rest];
}

async function defaultSpawn(
  command: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<number> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return await child.exited;
}

export function createSubAgentAnswerer(options: SubAgentOptions): AgentAnswerer {
  return async ({ request }) => {
    const provider = options.provider ?? "claude";
    const rendered = renderInboundAgentRequest(request);
    const command = resolveExecutable(headlessCommand(provider, rendered));
    if (!command) {
      throw new Error(
        `Cannot find the ${provider} CLI on PATH to answer request ${request.requestId}`,
      );
    }
    options.print(
      `Launching headless ${provider} agent to answer ${request.requestId}...`,
    );
    const spawn = options.spawn ?? defaultSpawn;
    const exitCode = await spawn(
      command,
      {
        [LINEAGE_USER_ID_ENV]: options.userId,
        [LINEAGE_PROVIDER_ENV]: provider,
      },
      options.cwd,
    );
    if (exitCode !== 0) {
      throw new Error(`Headless ${provider} agent exited with code ${exitCode}`);
    }
    options.print(`Headless ${provider} agent finished for ${request.requestId}.`);
  };
}
