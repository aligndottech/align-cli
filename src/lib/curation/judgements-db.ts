/**
 * LM: reads and writes of `local_judgements` (schema v7), one person's verdicts on this machine.
 *
 * "Person" is the installation: `judge_id` is the install id the CLI already keeps, and it is the
 * only identity a local graph has (Decision 11). A judge's later judgement replaces THEIR OWN
 * earlier one on the same key and never touches another judge's row; notes append.
 *
 * `context_key` (a hash of the files a check covered) is REVERSIBLE for a small set: hash the likely
 * paths of a repo and compare. It stays on this machine. Nothing the share phase reads may include it
 * or any file path.
 *
 * TOMBSTONES: when a person undoes a conflict or check verdict, the row stays with `value` NULL and
 * note 'undone' (via 'cli'). Readers skip it, so it is no verdict, but an agent's write on that key
 * still meets a person's row and is refused until a person marks it again. ANYTHING THAT READS THIS
 * TABLE (the share phase included) MUST ignore a verdict-kind row whose value is NULL.
 *
 * Builds before the round-3 fix (never released) let an agent write supersede and not_a_decision rows
 * and gave a supersede link a random id. Those rows still read correctly, and `--undo` removes their
 * judgement but cannot tell their link from a classifier's, so the link stays; no repair is attempted.
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

/** Thrown when an agent's write would replace a mark the person made themselves. Nothing was stored. */
export class HumanMarkError extends Error {
  constructor() {
    super('The person marked this themselves, and an agent cannot replace a person\'s mark.');
    this.name = 'HumanMarkError';
  }
}

function humanRowExists(db: DatabaseSync, w: JudgementWrite, judge: Judge): boolean {
  return db.prepare(
    `SELECT 1 AS x FROM local_judgements WHERE kind = ? AND judge_id = ? AND decision_id = ?
       AND COALESCE(counterpart_id, context_key, decision_id) = ? AND via = 'cli' LIMIT 1`,
  ).get(w.kind, judge.judgeId, w.decisionId, keyOf(w)) !== undefined;
}

/** Whether an agent's write of `w` would be refused. Lets a caller refuse BEFORE any side effect (the supersedes link). */
export function agentWouldOverrideHuman(dbPath: string, w: JudgementWrite, judge: Judge): boolean {
  if (w.kind === 'note') return false;
  return readDb(dbPath, false, (db) => humanRowExists(db, w, judge));
}

/**
 * Store a judgement. Returns whether it REPLACED an earlier one of this judge's (idempotent: the
 * same call twice leaves one row). Delete then insert inside one IMMEDIATE transaction, rather than
 * ON CONFLICT, because the unique index is on an expression and a partial predicate.
 */
export function upsertJudgement(dbPath: string, w: JudgementWrite, judge: Judge, origin: Origin, now = new Date()): { replaced: boolean; id: string } {
  return withDb(dbPath, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      let replaced = false;
      let id: string = randomUUID();
      // A prompt-injected agent must not silence a verdict a person recorded. Checked inside the
      // transaction so a CLI mark landing in between cannot be overwritten.
      if (w.kind !== 'note' && origin.via === 'mcp' && humanRowExists(db, w, judge)) throw new HumanMarkError();
      if (w.kind !== 'note') {
        const sel = `FROM local_judgements WHERE kind = ? AND judge_id = ? AND decision_id = ?
             AND COALESCE(counterpart_id, context_key, decision_id) = ?`;
        // The row keeps its id when it is replaced: a supersedes link is owned by `mark:<id>`, so a
        // re-mark and its --undo must still find it.
        const before = db.prepare(`SELECT id, value ${sel}`).get(w.kind, judge.judgeId, w.decisionId, keyOf(w)) as { id: string; value: string | null } | undefined;
        if (before) {
          id = before.id;
          // A tombstone (a verdict the person took back) is not an answer being replaced.
          replaced = !(before.value === null && isVerdictKind(w.kind));

          db.prepare(`DELETE ${sel}`).run(w.kind, judge.judgeId, w.decisionId, keyOf(w));
        }
      }
      db.prepare(
        `INSERT INTO local_judgements (id, decision_id, counterpart_id, context_key, kind, value, note, judge_id, judge_label, via, agent_id, judged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, w.decisionId, w.counterpartId ?? null, w.contextKey ?? null, w.kind, w.value ?? null, w.note ?? null,
        judge.judgeId, judge.judgeLabel, origin.via, origin.via === 'mcp' ? origin.agentId : null, now.toISOString(),
      );
      db.exec('COMMIT');
      return { replaced, id };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });
}

const isVerdictKind = (k: JudgementKind): boolean => k === 'conflict_verdict' || k === 'check_verdict';

/**
 * Take back this judge's own mark for the key (never another judge's). Returns the ids of the marks
 * that were taken back.
 *
 * A verdict a PERSON gave is not deleted but turned into a TOMBSTONE: the same row with no value
 * (`value` NULL, note 'undone'). Readers skip it, so the guardrail behaves as if the verdict never
 * existed, but an agent's write on that key still meets a person's row and is refused until a
 * person marks it again. Without it, undoing a "real" verdict would hand the key to an agent.
 * A mark an agent made, and the kinds an agent cannot write at all, are deleted outright.
 */
export function removeJudgement(dbPath: string, w: Omit<JudgementWrite, 'value' | 'note'>, judge: Judge, now = new Date()): string[] {
  if (w.kind === 'note') throw new Error('Notes append and are not removed by key.');
  return withDb(dbPath, (db) => {
    const sel = `FROM local_judgements WHERE kind = ? AND judge_id = ? AND decision_id = ?
       AND COALESCE(counterpart_id, context_key, decision_id) = ?`;
    const found = db.prepare(`SELECT id, via, value ${sel}`).all(w.kind, judge.judgeId, w.decisionId, keyOf(w)) as unknown as Array<{ id: string; via: string; value: string | null }>;
    const gone: string[] = [];
    for (const r of found) {
      if (isVerdictKind(w.kind) && r.via === 'cli') {
        if (r.value === null) continue;
        db.prepare(`UPDATE local_judgements SET value = NULL, note = 'undone', judged_at = ? WHERE id = ?`).run(now.toISOString(), r.id);
      } else {
        db.prepare('DELETE FROM local_judgements WHERE id = ?').run(r.id);
      }
      gone.push(r.id);
    }
    return gone;
  });
}

/** Every row of this judge, newest first, optionally only those that name one decision. */
export function listJudgements(dbPath: string, judgeId: string, decisionId?: string): JudgementRow[] {
  return readDb<JudgementRow[]>(dbPath, [], (db) => db.prepare(
    // Anonymous placeholders, each bound: Node 22.16's DatabaseSync rejects numbered ones with 'column index out of range'.
    `SELECT * FROM local_judgements WHERE judge_id = ? AND (? IS NULL OR decision_id = ? OR counterpart_id = ?)
       AND NOT (value IS NULL AND kind IN ('conflict_verdict', 'check_verdict'))
     ORDER BY judged_at DESC, rowid DESC`,
  ).all(judgeId, decisionId ?? null, decisionId ?? null, decisionId ?? null) as unknown as JudgementRow[]);
}

export interface CheckVerdictLookup {
  /** This judge's verdict for exactly this file set, if any. `agent_id` is set when an agent relayed it. */
  here: { value: Verdict; judged_at: string; agent_id: string | null } | null;
  /** The newest `false` this judge gave for a DIFFERENT file set: annotates, never hides. */
  elsewhereFalse: { judged_at: string; agent_id: string | null } | null;
}

export function checkVerdictFor(dbPath: string, judgeId: string, decisionId: string, contextKey: string | null): CheckVerdictLookup {
  return readDb<CheckVerdictLookup>(dbPath, { here: null, elsewhereFalse: null }, (db) => {
    const rows = db.prepare(
      `SELECT context_key, value, judged_at, agent_id FROM local_judgements WHERE kind = 'check_verdict' AND value IS NOT NULL AND judge_id = ? AND decision_id = ?
       ORDER BY judged_at DESC, rowid DESC`,
    ).all(judgeId, decisionId) as unknown as Array<{ context_key: string; value: Verdict; judged_at: string; agent_id: string | null }>;
    const here = contextKey === null ? undefined : rows.find((r) => r.context_key === contextKey);
    const other = rows.find((r) => r.context_key !== contextKey && r.value === 'false');
    return {
      here: here ? { value: here.value, judged_at: here.judged_at, agent_id: here.agent_id } : null,
      elsewhereFalse: other ? { judged_at: other.judged_at, agent_id: other.agent_id } : null,
    };
  });
}

export interface MarkMeta { agent_id: string | null; judged_at: string }

/** Decisions this judge excluded from ask and check retrieval, with who marked each and when. */
export function notADecisionMarks(dbPath: string, judgeId: string): Map<string, MarkMeta> {
  return readDb<Map<string, MarkMeta>>(dbPath, new Map(), (db) => new Map(
    (db.prepare(`SELECT decision_id, agent_id, judged_at FROM local_judgements WHERE kind = 'not_a_decision' AND judge_id = ?`).all(judgeId) as unknown as Array<{ decision_id: string } & MarkMeta>)
      .map((r) => [r.decision_id, { agent_id: r.agent_id, judged_at: r.judged_at }] as const),
  ));
}

/** The newest supersede mark this judge made about `olderId` being replaced, with the newer decision's id. */
export function supersedeMarkFor(dbPath: string, judgeId: string, olderId: string): (MarkMeta & { newer: string }) | null {
  return readDb<(MarkMeta & { newer: string }) | null>(dbPath, null, (db) => {
    const r = db.prepare(
      `SELECT decision_id AS newer, agent_id, judged_at FROM local_judgements WHERE kind = 'supersede' AND judge_id = ? AND counterpart_id = ?
       ORDER BY judged_at DESC, rowid DESC LIMIT 1`,
    ).get(judgeId, olderId) as (MarkMeta & { newer: string }) | undefined;
    return r ?? null;
  });
}

/** Every conflict verdict this judge gave, keyed by `lowerId|higherId`: one read for a whole list of pairs. */
export function pairVerdictsFor(dbPath: string, judgeId: string): Map<string, { value: Verdict; judged_at: string; agent_id: string | null }> {
  return readDb(dbPath, new Map(), (db) => new Map(
    (db.prepare(`SELECT decision_id, counterpart_id, value, judged_at, agent_id FROM local_judgements WHERE kind = 'conflict_verdict' AND value IS NOT NULL AND judge_id = ?`).all(judgeId) as Array<{ decision_id: string; counterpart_id: string; value: Verdict; judged_at: string; agent_id: string | null }>)
      .map((r) => [`${r.decision_id}|${r.counterpart_id}`, { value: r.value, judged_at: r.judged_at, agent_id: r.agent_id }] as const),
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
