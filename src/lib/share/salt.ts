/**
 * L9: the install's PRIVATE share salt, for the opaque `client_key` and local-only source URLs.
 *
 * A separate random value, kept in the CLI's own state directory (mode 0600, the same lstat-checked directory
 * as the pending shares), never sent anywhere and NOT the telemetry install id: that id is a stable identifier
 * the usage ping carries, and a salt equal to it would let anyone who sees both link a team-graph key to an
 * install. Created on first use. If it is ever lost, decisions already shared keep working: their key is stored
 * in the ledger at the first share, and only a decision never shared would get a new one.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { alignStateDir } from '../backfill-state.js';

export function shareSalt(): string {
  const base = alignStateDir();
  if (base === null) throw new Error('Cannot create a private state directory for the share salt, so nothing was prepared.');
  const file = path.join(base, 'share-salt');
  let present = false;
  try {
    const have = fs.readFileSync(file, 'utf8').trim();
    present = true;
    if (/^[0-9a-f]{64}$/.test(have)) return have;
  } catch { /* not created yet */ }
  const salt = randomBytes(32).toString('hex');
  if (present) {
    // A damaged file is replaced, atomically, rather than trusted: a salt that is not 64 hex characters is not ours.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, salt, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return salt;
  }
  // wx: two first runs cannot overwrite each other; the loser reads the winner's value.
  try { fs.writeFileSync(file, salt, { mode: 0o600, flag: 'wx' }); return salt; } catch { return fs.readFileSync(file, 'utf8').trim(); }
}
