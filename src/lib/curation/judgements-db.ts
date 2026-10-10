/**
 * LM: reads and writes of `local_judgements` (schema v7), one person's verdicts on this machine.
 *
 * "Person" is the installation: `judge_id` is the install id the CLI already keeps, and it is the
 * only identity a local graph has (Decision 11). A judge's later judgement replaces THEIR OWN
 * earlier one on the same key and never touches another judge's row; notes append.
 *
 * Ratification is not here: it stays in `decisions.ratified_by` (Decision 14), because storing it
 * twice would give one fact two writers.
 *
 * Every function opens its own short-lived handle, the sync-state pattern, so the MCP server and a
 * sync child can both be live. A reader never creates a missing graph file.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { assertSchemaSupported } from '../local-db-migrate.js';

export type JudgementKind = 'conflict_verdict' | 'check_verdict' | 'supersede' | 'not_a_decision' | 'note';
export type Verdict = 'real' | 'false';

export interface JudgementRow {
  id: string;
  decision_id: string;
  counterpart_id: string | null;
  context_key: string | null;
  kind: JudgementKind;
  value: Verdict | null;
  note: string | null;
  judge_id: string;
  judge_label: string | null;
  via: 'cli' | 'mcp';
  agent_id: string | null;
  judged_at: string;
}

export interface JudgementWrite {
  kind: JudgementKind;
  decisionId: string;
  counterpartId?: string;
  contextKey?: string;
  value?: Verdict;
  note?: string;
}

export interface Judge { judgeId: string; judgeLabel: string | null }
/** `agentId` is a registry id or 'unknown' and only ever accompanies `via: 'mcp'` (the table's CHECK says so). */
export type Origin = { via: 'cli' } | { via: 'mcp'; agentId: string };

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    assertSchemaSupported((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    return fn(db);
  } finally {
    db.close();
  }
}

/** A reader must never create the graph it was asked to look at, and a pre-v7 file reads as no judgements. */
function readDb<T>(dbPath: string, fallback: T, fn: (db: DatabaseSync) => T): T {
  if (dbPath === '' || !fs.existsSync(dbPath)) return fallback;
  return withDb(dbPath, (db) => {
    try {
      return fn(db);
    } catch (e) {
      if (/no such table/i.test((e as Error).message)) return fallback;
      throw e;
    }
  });
}

/** The unique-index key of a non-note row: what "the same judgement" means for one judge. */
function keyOf(w: JudgementWrite): string {
  return w.counterpartId ?? w.contextKey ?? w.decisionId;
}

/**
 * Store a judgement. Returns whether it REPLACED an earlier one of this judge's (idempotent: the
 * same call twice leaves one row). Delete then insert inside one IMMEDIATE transaction, rather than
 * ON CONFLICT, because the unique index is on an expression and a partial predicate.
 */
export function upsertJudgement(dbPath: string, w: JudgementWrite, judge: Judge, origin: Origin, now = new Date()): { replaced: boolean } {
  return withDb(dbPath, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      let replaced = false;
      if (w.kind !== 'note') {
        const gone = db.prepare(
          `DELETE FROM local_judgements WHERE kind = ? AND judge_id = ? AND decision_id = ?
             AND COALESCE(counterpart_id, context_key, decision_id) = ?`,
        ).run(w.kind, judge.judgeId, w.decisionId, keyOf(w));
        replaced = Number(gone.changes) > 0;
      }
      db.prepare(
        `INSERT INTO local_judgements (id, decision_id, counterpart_id, context_key, kind, value, note, judge_id, judge_label, via, agent_id, judged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(), w.decisionId, w.counterpartId ?? null, w.contextKey ?? null, w.kind, w.value ?? null, w.note ?? null,
        judge.judgeId, judge.judgeLabel, origin.via, origin.via === 'mcp' ? origin.agentId : null, now.toISOString(),
      );
      db.exec('COMMIT');
      return { replaced };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });
}

/** Remove this judge's own row for the key (never another judge's). Returns how many rows went. */
export function removeJudgement(dbPath: string, w: Omit<JudgementWrite, 'value' | 'note'>, judge: Judge): number {
  if (w.kind === 'note') throw new Error('Notes append and are not removed by key.');
  return withDb(dbPath, (db) => Number(db.prepare(
    `DELETE FROM local_judgements WHERE kind = ? AND judge_id = ? AND decision_id = ?
       AND COALESCE(counterpart_id, context_key, decision_id) = ?`,
  ).run(w.kind, judge.judgeId, w.decisionId, keyOf(w)).changes));
}

/** Every row of this judge, newest first, optionally only those that name one decision. */
export function listJudgements(dbPath: string, judgeId: string, decisionId?: string): JudgementRow[] {
  return readDb<JudgementRow[]>(dbPath, [], (db) => db.prepare(
    `SELECT * FROM local_judgements WHERE judge_id = ?1 AND (?2 IS NULL OR decision_id = ?2 OR counterpart_id = ?2)
     ORDER BY judged_at DESC, rowid DESC`,
  ).all(judgeId, decisionId ?? null) as unknown as JudgementRow[]);
}

/** This judge's verdict on a stored conflict pair, whichever order the ids come in (the pair is stored lower id first). */
export function pairVerdictFor(dbPath: string, judgeId: string, a: string, b: string): { value: Verdict; judged_at: string } | null {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return readDb<{ value: Verdict; judged_at: string } | null>(dbPath, null, (db) => (db.prepare(
    `SELECT value, judged_at FROM local_judgements WHERE kind = 'conflict_verdict' AND judge_id = ? AND decision_id = ? AND counterpart_id = ?`,
  ).get(judgeId, lo, hi) as { value: Verdict; judged_at: string } | undefined) ?? null);
}

export interface CheckVerdictLookup {
  /** This judge's verdict for exactly this file set, if any. */
  here: { value: Verdict; judged_at: string } | null;
  /** The newest `false` this judge gave for a DIFFERENT file set: annotates, never hides. */
  elsewhereFalse: { judged_at: string } | null;
}

export function checkVerdictFor(dbPath: string, judgeId: string, decisionId: string, contextKey: string | null): CheckVerdictLookup {
  return readDb<CheckVerdictLookup>(dbPath, { here: null, elsewhereFalse: null }, (db) => {
    const rows = db.prepare(
      `SELECT context_key, value, judged_at FROM local_judgements WHERE kind = 'check_verdict' AND judge_id = ? AND decision_id = ?
       ORDER BY judged_at DESC, rowid DESC`,
    ).all(judgeId, decisionId) as unknown as Array<{ context_key: string; value: Verdict; judged_at: string }>;
    const here = contextKey === null ? undefined : rows.find((r) => r.context_key === contextKey);
    const other = rows.find((r) => r.context_key !== contextKey && r.value === 'false');
    return { here: here ? { value: here.value, judged_at: here.judged_at } : null, elsewhereFalse: other ? { judged_at: other.judged_at } : null };
  });
}

/** Decisions this judge excluded from ask and check retrieval. */
export function notADecisionIds(dbPath: string, judgeId: string): Set<string> {
  return readDb<Set<string>>(dbPath, new Set(), (db) => new Set(
    (db.prepare(`SELECT decision_id FROM local_judgements WHERE kind = 'not_a_decision' AND judge_id = ?`).all(judgeId) as Array<{ decision_id: string }>)
      .map((r) => r.decision_id),
  ));
}

/** Titles of the decisions that exist among `ids`, so a mark can name an unknown id instead of storing a verdict on nothing. */
export function existingTitles(dbPath: string, ids: string[]): Map<string, string> {
  return readDb<Map<string, string>>(dbPath, new Map(), (db) => {
    const found = new Map<string, string>();
    for (const id of ids) {
      const row = db.prepare('SELECT title FROM decisions WHERE id = ?').get(id) as { title: string } | undefined;
      if (row) found.set(id, row.title);
    }
    return found;
  });
}
