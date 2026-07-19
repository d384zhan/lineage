import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@lineage/contracts";

interface CommandHook {
  type?: string;
  command?: string;
  timeout?: number;
}

interface PromptHookGroup {
  matcher?: string;
  hooks?: CommandHook[];
}

interface HookConfig {
  hooks?: {
    UserPromptSubmit?: PromptHookGroup[];
    state?: Record<string, { enabled?: boolean }>;
  };
}

export interface PromptHookOptions {
  provider: Provider | undefined;
  cwd: string;
  prompt: string;
  home?: string;
  env?: Record<string, string | undefined>;
}

async function loadConfig(path: string): Promise<HookConfig | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    const text = await file.text();
    return (path.endsWith(".toml") ? Bun.TOML.parse(text) : JSON.parse(text)) as HookConfig;
  } catch {
    return undefined;
  }
}

async function configuredCommands(options: PromptHookOptions): Promise<CommandHook[]> {
  const home = options.home ?? homedir();
  const paths = options.provider === "claude"
    ? [
        join(home, ".claude", "settings.json"),
        join(options.cwd, ".claude", "settings.json"),
        join(options.cwd, ".claude", "settings.local.json"),
      ]
    : options.provider === "codex"
      ? [join(home, ".codex", "config.toml"), join(options.cwd, ".codex", "config.toml")]
      : [];
  const commands: CommandHook[] = [];
  for (const path of paths) {
    const config = await loadConfig(path);
    const groups = config?.hooks?.UserPromptSubmit ?? [];
    for (const [groupIndex, group] of groups.entries()) {
      // Matcher semantics belong to the provider. Run only unconditional hooks.
      if (group.matcher) continue;
      for (const [hookIndex, hook] of (group.hooks ?? []).entries()) {
        const stateKey = `${path}:user_prompt_submit:${groupIndex}:${hookIndex}`;
        if (config?.hooks?.state?.[stateKey]?.enabled === false) continue;
        if (hook.type === "command" && hook.command?.trim()) commands.push(hook);
      }
    }
  }
  return commands.filter(
    (hook, index) => commands.findIndex((candidate) => candidate.command === hook.command) === index,
  );
}

function contextFromOutput(output: string): string | undefined {
  const text = output.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as {
      additionalContext?: unknown;
      hookSpecificOutput?: { additionalContext?: unknown };
    };
    const context = parsed.hookSpecificOutput?.additionalContext ?? parsed.additionalContext;
    return typeof context === "string" && context.trim() ? context.trim() : undefined;
  } catch {
    return text;
  }
}

async function runCommand(
  hook: CommandHook,
  options: PromptHookOptions,
): Promise<string | undefined> {
  const command = hook.command!;
  const shell = process.platform === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
    : [process.env.SHELL ?? "/bin/sh", "-lc", command];
  const child = Bun.spawn(shell, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      CLAUDE_PROJECT_DIR: options.cwd,
      LINEAGE_DISPATCH: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  child.stdin.write(JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    cwd: options.cwd,
    prompt: options.prompt,
  }));
  child.stdin.end();
  const output = new Response(child.stdout).text();
  const timeoutMs = Math.min(Math.max((hook.timeout ?? 5) * 1_000, 250), 10_000);
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timer);
  if (exitCode !== 0) return undefined;
  return contextFromOutput((await output).slice(0, 50_000));
}

/** Run the recipient's local context-producing prompt hooks after approval. */
export async function runUserPromptContextHooks(options: PromptHookOptions): Promise<string[]> {
  const hooks = await configuredCommands(options);
  const contexts: string[] = [];
  for (const hook of hooks) {
    const context = await runCommand(hook, options);
    if (context) contexts.push(context);
  }
  return contexts;
}
