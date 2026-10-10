/**
 * Load a frozen JSON snapshot into a THROWAWAY local graph (shared detector plan, Phase B).
 *
 * No user command reaches this: it is driven by scripts/load-local-snapshot.ts, so a benchmark
 * can build a local graph from the same decisions the hosted arm reads. It keeps each decision's
 * id, decided_at and platform exactly (ingestBatch re-extracts and cannot), and imports the
 * snapshot's links only when asked, stamped detector_version 'snapshot' so `align local relink`
 * (which reads v0 rows only) never re-types them and a count by version separates them.
 *
 * It never writes the user's real graph: it refuses a path that already exists and the default
 * local.db path, and it validates the whole snapshot before creating any file.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RELATIONSHIP_CONTRACT } from '../detector/relationship-contract.js';
import { createLocalDb } from './local-db.js';
import { getLocalDbPath } from './local-mode.js';

export interface SnapshotDecision {
  id: string;
  title: string;
  summary: string;
  source_url: string | null;
  platform: string;
  decided_at: string | null;
  repo?: string | null;
}

export interface SnapshotLink { source_id: string; target_id: string; relation: string; confidence: number }

export interface Snapshot { snapshot: string; decisions: SnapshotDecision[]; links?: SnapshotLink[] }

function validate(s: Snapshot, withLinks: boolean): void {
  if (!s.decisions.length) throw new Error('The snapshot holds no decisions; refusing to write an empty graph.');
  const ids = new Set<string>();
  for (const d of s.decisions) {
    if (ids.has(d.id)) throw new Error(`The snapshot has a duplicate id "${d.id}".`);
    ids.add(d.id);
  }
  if (!withLinks) return;
  const types: readonly string[] = RELATIONSHIP_CONTRACT.types;
  for (const l of s.links ?? []) {
    for (const id of [l.source_id, l.target_id]) if (!ids.has(id)) throw new Error(`A snapshot link names "${id}", which the snapshot does not hold.`);
    if (!types.includes(l.relation)) throw new Error(`A snapshot link has relation "${l.relation}", which is not in the contract vocabulary.`);
  }
}

export function loadSnapshot(s: Snapshot, dbPath: string, opts: { links: boolean; realDbPath?: string }): { decisions: number; links: number } {
  const real = resolve(opts.realDbPath ?? getLocalDbPath());
  if (resolve(dbPath) === real) throw new Error(`${dbPath} is the real local graph; load a snapshot into a throwaway path instead.`);
  if (existsSync(dbPath)) throw new Error(`${dbPath} already exists; the loader only writes a new, throwaway graph.`);
  validate(s, opts.links);

  createLocalDb(dbPath).close(); // creates and migrates the schema
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const insertDecision = db.prepare('INSERT INTO decisions (id, title, summary, source_url, platform, decided_at, repo) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const d of s.decisions) insertDecision.run(d.id, d.title, d.summary, d.source_url, d.platform, d.decided_at, d.repo ?? null);
    let links = 0;
    if (opts.links) {
      const insertLink = db.prepare(`INSERT OR IGNORE INTO decision_links (id, source_id, target_id, relation, confidence, detector_version) VALUES (?, ?, ?, ?, ?, 'snapshot')`);
      for (const [i, l] of (s.links ?? []).entries()) links += Number(insertLink.run(`snapshot:${i}`, l.source_id, l.target_id, l.relation, l.confidence).changes);
    }
    db.exec('COMMIT');
    return { decisions: s.decisions.length, links };
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}
