/**
 * No test may read or write the developer's real home folder.
 *
 * The product resolves agent and config folders from the home directory: `~/.claude` for
 * Claude Code sessions and memory, `~/.codex`, `~/.cursor`, `~/.config/align-cli` through
 * env-paths, `~/.local/state/align-cli` for backfill state. A test that reaches the real one
 * reads whatever that machine happens to hold - 3.7 GB under `~/.claude` on one box, which
 * made two suites take 4-8 s per case and time out - and can write into it.
 *
 * `isolated-home.setup.ts` points HOME (and USERPROFILE, for Windows) at a temp folder before
 * any test module is imported. It has to be BEFORE: env-paths reads `os.homedir()` once, when
 * it is first imported, so a stub inside a test file is already too late for it.
 *
 * `assertIsolatedHome` is the guard. Call it with the root a module under test will resolve.
 */
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Set by the setup file from the passwd entry, which HOME does not change. */
export const REAL_HOME_ENV = 'ALIGN_TEST_REAL_HOME';
/** The temp home the setup file created for the current test file. */
export const TEST_HOME_ENV = 'ALIGN_TEST_HOME';

function resolved(p: string): string {
  // The nearest existing ancestor, so a root that does not exist yet still compares correctly,
  // and macOS's /var -> /private/var link does not make a temp path look foreign.
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Throws unless `root` sits under the OS temp folder and outside the real home.
 * Defaults to `os.homedir()`, which is what every product path helper starts from.
 */
export function assertIsolatedHome(root: string = os.homedir()): void {
  const r = resolved(root);
  const tmp = resolved(os.tmpdir());
  const realHome = process.env[REAL_HOME_ENV];
  if (!isInside(r, tmp)) {
    throw new Error(
      `test isolation: ${root} resolves to ${r}, outside the temp folder ${tmp}. ` +
        'A test would read the real home folder. Is src/__tests__/helpers/isolated-home.setup.ts still in vitest.config.ts setupFiles?',
    );
  }
  if (realHome && isInside(r, resolved(realHome)) && !isInside(tmp, resolved(realHome))) {
    throw new Error(`test isolation: ${root} resolves inside the real home folder ${realHome}.`);
  }
}
