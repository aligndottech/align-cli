/**
 * An ADR that says "Supersedes the REST-only rule in CLAUDE.md" replaces ONE rule in a file whose
 * section is stored as ONE row holding several. So this is deliberately not a `supersedes` link:
 * that marks the whole row replaced (status, `isSuperseded`, a RETIRED classifier verdict) and
 * would hide the rules in it that still hold. It is a note beside the row instead: the hook says
 * "partly replaced by <ADR>" and lists the ADR, and nothing is hidden.
 *
 * The sentence is read from the stored text, so there is no model and no key, and only an explicit
 * "Supersedes ... in <file>" counts. "Supersedes ADR 0002" is left alone on purpose: replacing a
 * whole ADR is a person's act (`align mark`, ADR Guard), never an inference from a sentence.
 *
 * A NEW TABLE, not a column: like `decision_identities` it does not bump user_version, an older
 * CLI never reads it, and every reader joins `decisions` so a row it leaves behind links nothing.
 */
import type { DatabaseSync } from 'node:sqlite';

export function hasPartialSupersessionTable(db: DatabaseSync): boolean {
  return db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'decision_partial_supersessions'`).get() !== undefined;
}

export function migratePartialSupersessions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS decision_partial_supersessions (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_partial_supersessions_target ON decision_partial_supersessions (target_id)');
}

const NOTE = /\bsupersedes\s+([^.\n]{0,160}?)\s+in\s+[`'"(]*((?:[\w.-]+\/)*[\w-]+\.(?:md|mdx|rst|txt))\b/gi;
// Words that say "a rule" without saying which one.
const FILLER = new Set(['the', 'rule', 'rules', 'only', 'and', 'for', 'any', 'all', 'our', 'this', 'that', 'section', 'sections', 'old', 'one', 'from', 'with']);

export interface SupersedeNote { file: string; words: string[] }

export function supersedeNotes(text: string): SupersedeNote[] {
  return [...text.matchAll(NOTE)].map((m) => ({
    file: m[2]!.toLowerCase(),
    words: m[1]!.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !FILLER.has(w)),
  }));
}

interface DocRow { id: string; sourceUrl: string; text: string }

const inFile = (r: DocRow, file: string): boolean => r.sourceUrl.split('#')[0]!.toLowerCase().endsWith(`/${file.replace(/^\.?\//, '')}`);

/** The rows of the note's file it can mean: those sharing a rule word, else the file's only row. */
function targetsOf(note: SupersedeNote, docs: DocRow[], self: string): string[] {
  const rows = docs.filter((r) => r.id !== self && inFile(r, note.file));
  const named = rows.filter((r) => note.words.some((w) => new RegExp(`\\b${w}\\b`).test(r.text)));
  return (named.length ? named : rows.length === 1 ? rows : []).map((r) => r.id);
}

/**
 * Record what `id` supersedes in other files, and what other files' decisions say they supersede in
 * `id`, both ways so the order two rows arrive in does not matter. Idempotent, and a row whose text
 * no longer says it loses the link, as linkByReference does for a dropped reference.
 */
export function linkPartialSupersessions(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM decision_partial_supersessions WHERE source_id = ? OR target_id = ?').run(id, id);
  const docs = (db.prepare(`SELECT id, source_url AS sourceUrl, title || char(10) || summary AS text FROM decisions WHERE platform = 'docs' AND source_url IS NOT NULL`).all() as unknown as DocRow[]);
  const self = docs.find((r) => r.id === id);
  if (!self) return;
  const add = db.prepare('INSERT OR IGNORE INTO decision_partial_supersessions (source_id, target_id) VALUES (?, ?)');
  for (const note of supersedeNotes(self.text)) for (const t of targetsOf(note, docs, id)) add.run(id, t);
  for (const other of docs) {
    if (other.id === id || !/supersedes/i.test(other.text)) continue;
    for (const note of supersedeNotes(other.text)) if (targetsOf(note, docs, other.id).includes(id)) add.run(other.id, id);
  }
}

/** The decisions that say they replace part of `targetId`, newest row first. */
export function partialSupersessorsOf(db: DatabaseSync, targetId: string): string[] {
  if (!hasPartialSupersessionTable(db)) return [];
  return (db.prepare(
    `SELECT s.id AS id FROM decision_partial_supersessions p JOIN decisions s ON s.id = p.source_id WHERE p.target_id = ? ORDER BY s.created_at DESC, s.id`,
  ).all(targetId) as Array<{ id: string }>).map((r) => r.id);
}
