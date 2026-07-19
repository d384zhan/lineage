import { posix, win32 } from "node:path";

function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

/** Store and compare repository paths in Git's forward-slash form on every OS. */
export function canonicalRepoPath(path: string, cwd?: string): string {
  const clean = path.trim().replace(/^['"]|['",;]$/g, "");
  if (!clean) return "";

  const pathApi = isWindowsAbsolute(clean) || (cwd !== undefined && isWindowsAbsolute(cwd))
    ? win32
    : posix;
  let candidate = clean;
  if (cwd && pathApi.isAbsolute(clean)) {
    const relative = pathApi.relative(cwd, clean);
    candidate = relative.startsWith("..") || pathApi.isAbsolute(relative) ? clean : relative;
  }

  return posix.normalize(candidate.replace(/\\/g, "/").replace(/^\.\//, ""));
}
