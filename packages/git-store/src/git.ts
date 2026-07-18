export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: {
    allowFailure?: boolean;
    input?: string;
    env?: Record<string, string>;
  } = {},
): Promise<GitResult> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    env: { ...globalThis.process.env, ...options.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return { stdout, stderr, exitCode };
}

export async function findRepositoryRoot(cwd: string): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return result.stdout.trim();
}
