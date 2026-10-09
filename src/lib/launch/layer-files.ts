import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ALIGN_NUDGE_START } from '../agent-rules.js';

/** A file's text, or null when it is missing or unreadable (a directory, no permission). */
export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** cwd and every directory above it, to the filesystem root, nearest first. */
export function ancestors(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.dirname(dir) === dir) return dirs;
  }
}

/** The file carries the managed align block (`align setup`'s instructions). */
export function fileHasBlock(file: string): boolean {
  return readText(file)?.includes(ALIGN_NUDGE_START) ?? false;
}

/**
 * The value of a root option in the user's own args, before any `--` (`--opt v` or `--opt=v`).
 * The last one wins, as a CLI parser reads it. undefined when absent.
 */
export function optionValue(passthrough: string[], name: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < passthrough.length; i++) {
    const a = passthrough[i]!;
    if (a === '--') break;
    if (a === name) value = passthrough[++i];
    else if (a.startsWith(`${name}=`)) value = a.slice(name.length + 1);
  }
  return value;
}
