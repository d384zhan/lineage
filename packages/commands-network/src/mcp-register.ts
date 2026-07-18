import { isAbsolute, join, relative } from "node:path";

/** Path to the MCP stdio server entry, relative to this file. */
export function mcpServerPath(): string {
  return join(import.meta.dir, "..", "..", "mcp", "src", "index.ts");
}

function portablePath(repoRoot: string, serverPath: string): string {
  const rel = relative(repoRoot, serverPath);
  // Keep the committed .mcp.json machine-independent when the server lives
  // inside the repo (the demo case); fall back to an absolute path otherwise.
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.replaceAll("\\", "/");
  return serverPath;
}

/**
 * Writes/merges the project-level `.mcp.json` so Claude Code loads the
 * lineage MCP server. Returns what happened for user feedback.
 */
export async function ensureClaudeMcpConfig(
  repoRoot: string,
  serverPath = mcpServerPath(),
): Promise<"written" | "updated" | "unchanged"> {
  const configPath = join(repoRoot, ".mcp.json");
  const file = Bun.file(configPath);
  const existing = (await file.exists()) ? await file.json() : undefined;
  const config =
    typeof existing === "object" && existing !== null
      ? (existing as Record<string, unknown>)
      : {};
  const servers =
    typeof config.mcpServers === "object" && config.mcpServers !== null
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  const desired = { command: "bun", args: [portablePath(repoRoot, serverPath)] };
  const current = JSON.stringify(servers.lineage);
  if (current === JSON.stringify(desired)) return "unchanged";
  const outcome = existing === undefined ? "written" : "updated";
  servers.lineage = desired;
  config.mcpServers = servers;
  await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return outcome;
}

export function codexConfigPath(home = process.env.USERPROFILE ?? process.env.HOME ?? ""): string {
  return join(home, ".codex", "config.toml");
}

export function codexConfigSnippet(serverPath = mcpServerPath()): string {
  const escaped = serverPath.replaceAll("\\", "\\\\");
  return [
    "[mcp_servers.lineage]",
    'command = "bun"',
    `args = ["${escaped}"]`,
  ].join("\n");
}

export async function codexConfigHasLineage(configPath = codexConfigPath()): Promise<boolean> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return false;
  return (await file.text()).includes("[mcp_servers.lineage]");
}
