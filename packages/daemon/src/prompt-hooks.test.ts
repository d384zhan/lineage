import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUserPromptContextHooks } from "./prompt-hooks";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lineage-prompt-hooks-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  tempDirs.push(root);
  return { home, cwd };
}

function commandFor(script: string, mode: string): string {
  const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  return `${quote(process.execPath)} ${quote(script)} ${mode}`;
}

async function writeHook(root: string): Promise<string> {
  const script = join(root, "hook.ts");
  await Bun.write(script, `
const input = JSON.parse(await Bun.stdin.text());
const context = \`context for \${input.prompt}\`;
if (process.argv[2] === "json") {
  console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: context } }));
} else {
  console.log(context);
}
`);
  return script;
}

describe("recipient prompt context hooks", () => {
  test("normalizes Claude plain-text hook output", async () => {
    const { home, cwd } = fixture();
    const script = await writeHook(join(home, ".."));
    mkdirSync(join(home, ".claude"), { recursive: true });
    await Bun.write(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: commandFor(script, "plain") }] }] },
    }));

    expect(await runUserPromptContextHooks({
      provider: "claude",
      cwd,
      home,
      prompt: "Why cookies?",
    })).toEqual(["context for Why cookies?"]);
  });

  test("normalizes Codex additionalContext output and skips matched hooks", async () => {
    const { home, cwd } = fixture();
    const script = await writeHook(join(home, ".."));
    mkdirSync(join(home, ".codex"), { recursive: true });
    const command = commandFor(script, "json");
    const configPath = join(home, ".codex", "config.toml");
    const disabledStateKey = `${configPath}:user_prompt_submit:1:0`;
    await Bun.write(configPath, `
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = ${JSON.stringify(command)}

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = ${JSON.stringify(commandFor(script, "plain"))}

[[hooks.UserPromptSubmit]]
matcher = "something-provider-specific"
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "exit 9"

[hooks.state.${JSON.stringify(disabledStateKey)}]
enabled = false
`);

    expect(await runUserPromptContextHooks({
      provider: "codex",
      cwd,
      home,
      prompt: "What changed?",
    })).toEqual(["context for What changed?"]);
  });
});
