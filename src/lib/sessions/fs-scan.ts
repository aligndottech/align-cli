import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every file under `root` (recursively) whose full path matches `pattern`. A missing or
 * unreadable root is "this agent has never run here" - the normal case, not an error - so
 * it returns [] rather than throwing. Every adapter's locateSessionFiles builds on this.
 */
export function findFilesRecursive(root: string, pattern: RegExp): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...findFilesRecursive(full, pattern));
    } else if (pattern.test(full)) {
      found.push(full);
    }
  }
  return found;
}

/** Newest-first by mtime - agent-agnostic, so it works whether or not a format's own
 *  embedded timestamp was parseable. */
export function sortByMtimeDesc(files: string[]): string[] {
  return [...files].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}
