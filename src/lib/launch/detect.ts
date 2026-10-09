import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A PATH scan and nothing else: no subprocess, and never a config dir. `~/.claude` existing
 * says the agent was installed once, not that it can be launched now. On win32 the candidates
 * come from PATHEXT, because an npm global install is `claude.cmd`.
 */
export function findOnPath(bin: string, env: Record<string, string | undefined>, platform: string): string | null {
  const win = platform === 'win32';
  const raw = env['PATH'] ?? env['Path'] ?? '';
  if (!raw) return null;
  const exts = win ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const names = win && path.extname(bin) ? [bin] : exts.map((e) => bin + (win ? e.toLowerCase() : e));
  for (const dir of raw.split(win ? ';' : ':')) {
    if (!dir) continue;
    for (const name of names) {
      // Absolute, so what was checked here is what gets spawned whatever the cwd is by then.
      const candidate = path.resolve(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!win) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here, or not executable: keep scanning
      }
    }
  }
  return null;
}
