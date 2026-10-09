import envPaths from 'env-paths';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** $XDG_CACHE_HOME/align-cli/launch, honoured on every platform; else the OS cache dir. */
export function launchCacheDir(env: Record<string, string | undefined>): string {
  const xdg = env['XDG_CACHE_HOME'];
  const base = xdg ? path.join(xdg, 'align-cli') : envPaths('align-cli', { suffix: '' }).cache;
  return path.join(base, 'launch');
}

/**
 * Write `content` only when it differs from what is there, via a temp file and rename so a
 * reader (the agent starting up) never sees a half-written file. Returns whether it wrote.
 */
export function writeIfChanged(dir: string, name: string, content: string): boolean {
  const target = path.join(dir, name);
  try {
    if (readFileSync(target, 'utf8') === content) return false;
  } catch {
    // missing: write it
  }
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, target);
  return true;
}
