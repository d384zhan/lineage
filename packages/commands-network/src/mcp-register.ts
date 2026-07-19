import { join } from "node:path";

/** Absolute path to the Lineage stdio MCP server. */
export function mcpServerPath(): string {
  return join(import.meta.dir, "..", "..", "mcp", "src", "index.ts");
}

export type McpRegistrationStatus =
  | "registered"
  | "unchanged"
  | "not_installed"
  | "failed";

export interface McpRegistrationResult {
  claude: McpRegistrationStatus;
  codex: McpRegistrationStatus;
  errors: string[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface McpRegistrationOptions {
  cwd: string;
  serverPath?: string;
  which?: (name: string) => string | undefined;
  run?: (command: string[], cwd: string) => CommandResult;
}

function defaultRun(command: string[], cwd: string): CommandResult {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const decoder = new TextDecoder();
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function errorText(provider: string, result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return `${provider} MCP registration failed: ${detail}`;
}

/**
 * Registers Lineage without writing project files:
 * Claude uses project-local user state (`--scope local`), while Codex uses its
 * user config. Both commands are idempotent through their supported `mcp get`.
 */
export async function ensureMcpRegistrations(
  options: McpRegistrationOptions,
): Promise<McpRegistrationResult> {
  const which = options.which ?? ((name: string) => Bun.which(name));
  const run = options.run ?? defaultRun;
  const server = options.serverPath ?? mcpServerPath();
  const errors: string[] = [];

  let claude: McpRegistrationStatus = "not_installed";
  const claudePath = which("claude");
  if (claudePath) {
    const existing = run([claudePath, "mcp", "get", "lineage"], options.cwd);
    if (existing.exitCode === 0) {
      claude = "unchanged";
    } else {
      const added = run([
        claudePath,
        "mcp",
        "add",
        "--scope",
        "local",
        "lineage",
        "--",
        "bun",
        server,
      ], options.cwd);
      claude = added.exitCode === 0 ? "registered" : "failed";
      if (claude === "failed") errors.push(errorText("Claude", added));
    }
  }

  let codex: McpRegistrationStatus = "not_installed";
  const codexPath = which("codex");
  if (codexPath) {
    const existing = run([codexPath, "mcp", "get", "lineage", "--json"], options.cwd);
    if (existing.exitCode === 0) {
      codex = "unchanged";
    } else {
      const added = run([
        codexPath,
        "mcp",
        "add",
        "lineage",
        "--",
        "bun",
        server,
      ], options.cwd);
      codex = added.exitCode === 0 ? "registered" : "failed";
      if (codex === "failed") errors.push(errorText("Codex", added));
    }
  }

  return { claude, codex, errors };
}
