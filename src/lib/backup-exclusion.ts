/**
 * Keep the local graph out of backups and sync, best effort.
 *
 * The graph holds decision text from every connector a person imported, and it is not encrypted
 * (by design, see docs/local-mode.md). A Time Machine disk or a backup service is a second copy of
 * it, in a place the person may not think of as theirs to protect. So, once, the directory that
 * holds it is:
 * - excluded from Time Machine on macOS (`tmutil addexclusion`, a sticky exclusion that follows
 *   the folder, run only when /usr/bin/tmutil exists), and
 * - tagged with CACHEDIR.TAG (https://bford.info/cachedir/), which borg, restic, tar and other
 *   backup tools skip when asked to exclude caches.
 *
 * There is no marker-FILE convention for iCloud or Dropbox: iCloud skips items whose NAME ends in
 * `.nosync`, which would mean renaming the user's config directory. Neither syncs the config
 * directory by default, so nothing is written for them. Undo: `tmutil removeexclusion <dir>` and
 * delete the tag (docs/local-mode.md); a separate `.backup-exclusion-done` marker
 * keeps that undo from being reversed.
 *
 * Never fatal: every step is wrapped, and nothing here can stop a command from running.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CACHEDIR_TAG_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';
const TMUTIL = '/usr/bin/tmutil';

export interface BackupDeps {
  platform: string;
  hasTmutil: () => boolean;
  run: (cmd: string, args: string[]) => void;
  writeFile?: (p: string, data: string) => void;
}

const defaultDeps: BackupDeps = {
  platform: process.platform,
  hasTmutil: () => fs.existsSync(TMUTIL),
  run: (cmd, args) => { spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000 }); },
};

/** Exclude the directory holding `dbPath` from backups, once. A no-op until the graph exists. */
export function excludeGraphFromBackups(dbPath: string, deps: BackupDeps = defaultDeps): void {
  try {
    if (!fs.existsSync(dbPath)) return;
    const dir = path.dirname(dbPath);
    const tag = path.join(dir, 'CACHEDIR.TAG');
    // Its own "already done" marker, not the tag: a person who deletes the tag to back the graph up again
    // (the documented undo) must not have it, or the Time Machine exclusion, put back by the next command.
    const done = path.join(dir, '.backup-exclusion-done');
    if (fs.existsSync(done) || fs.existsSync(tag)) return;
    try { fs.writeFileSync(done, '', { mode: 0o600 }); } catch { /* best effort */ }
    if (deps.platform === 'darwin' && deps.hasTmutil()) {
      try { deps.run(TMUTIL, ['addexclusion', dir]); } catch { /* best effort */ }
    }
    const body = `${CACHEDIR_TAG_SIGNATURE}\n# This file marks the Align CLI local decision graph so backup tools can skip it.\n# See https://bford.info/cachedir/ and docs/local-mode.md in align-cli.\n`;
    (deps.writeFile ?? ((p, d) => fs.writeFileSync(p, d, { mode: 0o600 })))(tag, body);
  } catch { /* best effort: never stop a command */ }
}
