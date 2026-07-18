export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean } = {},
): Promise<GitResult> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
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
