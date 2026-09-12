import fs from "node:fs";
import path from "node:path";

const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: string[] } | null = null;

/**
 * Candidate project directories: one level below each configured workspace root,
 * keeping those that contain a `.git` entry. (A file, not just a directory — that is
 * how worktrees and submodules present.)
 *
 * Roots that do not exist on this machine are skipped rather than erroring;
 * workspaceRoots is machine-local config and may list paths from another box.
 */
export function scanWorkspaces(roots: string[]): string[] {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const found: string[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(root, entry.name);
      try {
        if (fs.existsSync(path.join(dir, ".git"))) found.push(dir);
      } catch {
        /* unreadable directory */
      }
    }
  }

  const value = [...new Set(found)].sort();
  cache = { at: Date.now(), value };
  return value;
}

export function clearWorkspaceCache(): void {
  cache = null;
}
