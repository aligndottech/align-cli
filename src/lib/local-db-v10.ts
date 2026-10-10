/**
 * Schema v10 (L9): the promotions ledger - what this machine has shared to which team workspace.
 *
 * One row per (local decision, environment, workspace). It holds the remote id (to retract), the
 * hash of the payload that was sent (to say "already shared" and to notice an edit), and whether
 * the share MATCHED a decision the team already held (`matched`: a retract must never archive
 * somebody else's decision).
 *
 * There is deliberately NO foreign key to `decisions`: `align local forget` must not erase the only
 * record that lets a person retract a copy that is on the team graph.
 *
 * Old `align push` rows (audit action 'pushed', detail `<env>:<cloudId>`) become 'legacy' rows: they
 * carry no workspace, so a second share of the same decision warns that it may create a second copy
 * instead of pretending the first never happened. Replay-safe: CREATE IF NOT EXISTS, INSERT OR IGNORE.
 */
import type { DatabaseSync } from 'node:sqlite';

export const PROMOTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS promotions (
  local_id     TEXT NOT NULL,
  env          TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  remote_id    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  matched      INTEGER NOT NULL DEFAULT 0,
  client_key   TEXT NOT NULL DEFAULT '',
  sent         TEXT NOT NULL DEFAULT '[]',
  confirm_pending INTEGER NOT NULL DEFAULT 0,
  shared_at    TEXT NOT NULL DEFAULT (datetime('now')),
  retracted_at TEXT,
  PRIMARY KEY (local_id, env, tenant_id)
);
`;

export function migrateV10(db: DatabaseSync): void {
  db.exec(PROMOTIONS_TABLE);
  const pushes = db.prepare(`SELECT decision_id, detail FROM decision_audit WHERE action = 'pushed' AND detail IS NOT NULL ORDER BY created_at, rowid`).all() as Array<{ decision_id: string; detail: string }>;
  const insert = db.prepare(`INSERT OR IGNORE INTO promotions (local_id, env, tenant_id, remote_id, content_hash) VALUES (?, ?, 'legacy', ?, '')`);
  for (const p of pushes) {
    const cut = p.detail.indexOf(':');
    const env = cut > 0 ? p.detail.slice(0, cut) : '';
    const remote = cut > 0 ? p.detail.slice(cut + 1) : '';
    if (env === '' || remote === '') continue; // no cloud id recorded: nothing a retract could name
    insert.run(p.decision_id, env, remote);
  }
}
