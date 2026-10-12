import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alignServerEntry, type McpFormat } from './mcp-setup.js';

/**
 * The absolute path of the `align` executable, resolved by align itself (ALI-1515).
 *
 * The MCP command handed to an agent used to be a bare `align`, which the AGENT then finds through its own PATH. A
 * PATH can carry relative or empty entries (`.`, `node_modules/.bin`), so a repo could plant an `align` and have the
 * agent spawn it. This resolves the path once, here, from the PATH entries that cannot be planted:
 *
 *   - ABSOLUTE entries only (a relative or empty entry is read against whatever directory the agent runs in);
 *   - never an entry inside the directory align was started in, because that directory is the repo (`npx` adds the
 *     repo's own `node_modules/.bin` to PATH as an absolute entry). Same guard as migrateLocalDb, and the same
 *     exception: when cwd is an ancestor of home (`/`), it is not a repo.
 *
 * The result is the path AS FOUND, not its realpath: an npm global `align` is a symlink, and an upgrade retargets the
 * link, so the link path keeps working where the resolved target would go stale.
 */
export function resolveTrustedAlignBin(
  opts: { pathEnv?: string; cwd?: string; home?: string; platform?: typeof process.platform } = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  const pathEnv = opts.pathEnv ?? process.env['PATH'] ?? '';
  const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const cwd = real(opts.cwd ?? process.cwd());
  const home = real(opts.home ?? os.homedir());
  const inside = (child: string, parent: string): boolean => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const names = platform === 'win32' ? ['align.exe', 'align.cmd'] : ['align'];
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    if (inside(real(entry), cwd) && !inside(home, cwd)) continue;
    for (const name of names) {
      const candidate = path.join(entry, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** Entry for the `align` server handed to an agent per session (ALI-1515): absolute trusted path when one resolves, bare `align` otherwise. */
export function launchAlignEntry(format: McpFormat): Record<string, unknown> {
  // ALIGN_NO_TRUSTED_BIN=1 keeps the bare name (an escape hatch, and how the suite stays machine-independent).
  const trustedBin = process.env['ALIGN_NO_TRUSTED_BIN'] === '1' ? null : resolveTrustedAlignBin();
  return alignServerEntry(format, 'local', { trustedBin });
}
