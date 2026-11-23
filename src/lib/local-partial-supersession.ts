/**
 * An ADR that says "Supersedes the REST-only rule in CLAUDE.md" replaces ONE rule in a file whose
 * section is stored as ONE row holding several. So this is deliberately not a `supersedes` link:
 * that marks the whole row replaced (status, `isSuperseded`, a RETIRED classifier verdict) and
 * would hide the rules in it that still hold. It is a note beside the row instead: the hook says
 * "partly replaced by <ADR>" and lists the ADR, and nothing is hidden.
 *
 * The sentence is read from the stored text, so there is no model and no key. Only the shape
 * "Supersedes the <words> rule|section|convention|policy|guideline|decision in <file>" counts, the
 * file written bare or as a markdown link. A looser reading tags prose that is not a decision.
 * "Supersedes ADR 0002" is left alone on purpose: replacing a whole ADR is a person's act
 * (`align mark`, ADR Guard), never an inference from a sentence.
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

// A word may hold a dot ("Node.js") but a dot that ends the sentence ends the match.
const WORD = String.raw`(?:[\w-]|\.(?=\w))+`;
const FILE_PART = String.raw`(?:the\s+)?(?:\[[^\]\n]*\]\(([^)\s]+)\)|\x60?([\w./-]+)\x60?)(?:\s+file\b)?`;
// One "the <words> rule in <file>" item, matched where the previous one ended.
const ITEM = new RegExp(String.raw`(?:ADR[- ]?\d+\s*(?:,\s*and|,|and)?\s+)*the\s+(${WORD}(?:\s+${WORD}){0,7}?)\s+(?:rule|section|convention|policy|guideline|decision)s?\s+in\s+${FILE_PART}\s*(?:(?:,\s*and|,|and)\s+)?`, 'iy');
// The verb must START its clause: a line start after an optional bullet, bold or italic marks and a
// subject ("This ADR", "We"), or the start of a sentence. "ADR 2 says it supersedes ..." is not a decision.
const CLAUSE = /(?:^|(?<=[.!?]\s))[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+)?[*_]*(?:(?:this\s+(?:adr|decision)|we)\s+)?supersedes[*_]*:?[*_]*\s+/gim;
const NEGATION = /\b(?:not|never|no\s+longer|doesn'?t|don'?t|isn'?t|wasn'?t)\b/i;
// Words that name a kind of thing or a connective, never which rule.
const FILLER = new Set(['that', 'this', 'with', 'from', 'only', 'rule', 'rules', 'section', 'sections', 'convention', 'policy', 'guideline', 'decision', 'using', 'when', 'them', 'they', 'have', 'been', 'more']);
const DOC_FILE = /\.(?:md|mdx|rst|txt)$/i;

export interface SupersedeNote { file: string; words: string[] }

/** What a reader would call the ADR's own statement: no code fences, quotations or quoted lines. */
function ownProse(text: string): string {
  let fenced = false;
  return text.split(/\r?\n/).filter((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; return false; }
    return !fenced && !/^\s*>/.test(line);
  }).join('\n').replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
}

/** When unsure, nothing: a clause with any negation, or text after the items that is not another item, yields no note. */
export function supersedeNotes(text: string): SupersedeNote[] {
  const prose = ownProse(text);
  const out: SupersedeNote[] = [];
  for (const m of prose.matchAll(CLAUSE)) {
    const rest = prose.slice(m.index + m[0].length);
    const body = rest.slice(0, (/\.(?=\s|$)|\n/.exec(rest)?.index ?? rest.length) + 1);
    if (NEGATION.test(body)) continue;
    ITEM.lastIndex = 0;
    for (let it = ITEM.exec(body); it; it = ITEM.exec(body)) {
      const file = (it[2] ?? it[3] ?? '').split(/[#?]/)[0]!.replace(/\.+$/, '').replace(/^(?:\.{1,2}\/)+/, '').replace(/^\//, '');
      if (!DOC_FILE.test(file)) break;
      out.push({ file, words: it[1]!.split(/[^A-Za-z0-9]+/).map((w) => w.toLowerCase()).filter((w) => w.length >= 4 && !FILLER.has(w)) });
    }
  }
  return out;
}

interface DocRow { id: string; sourceUrl: string; repo: string | null; text: string }

const DOCS = `SELECT id, source_url AS sourceUrl, repo, title || char(10) || summary AS text FROM decisions WHERE platform = 'docs' AND source_url IS NOT NULL`;

/** A whole path segment, any case ("claude.md" names CLAUDE.md): "docs/OLD-CLAUDE.md" is not "CLAUDE.md". */
const inFile = (r: DocRow, file: string): boolean => r.sourceUrl.split(/[#?]/)[0]!.toLowerCase().endsWith(`/${file.toLowerCase()}`);
/** The same repository, or both unattributed. One side naming none is NOT a match: a local file says nothing about a repository's. */
const sameRepo = (a: string | null, b: string | null): boolean => a === b;

/**
 * The rows of the note's file it can mean: those holding a rule word (any case), else the file's
 * only row. A vendored vendor/CLAUDE.md in the same repo is a candidate on the same terms.
 */
function targetsOf(note: SupersedeNote, docs: DocRow[], source: DocRow): string[] {
  const rows = docs.filter((r) => r.id !== source.id && inFile(r, note.file) && sameRepo(r.repo, source.repo));
  const score = (r: DocRow) => new Set(note.words.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(r.text))).size;
  const scored = rows.map((r) => ({ r, n: score(r) }));
  const best = Math.max(0, ...scored.map((x) => x.n));
  const named = scored.filter((x) => best > 0 && x.n === best).map((x) => x.r);
  return (named.length ? named : rows.length === 1 ? rows : []).map((r) => r.id);
}

function relink(db: DatabaseSync, source: DocRow, docs: DocRow[]): void {
  db.prepare('DELETE FROM decision_partial_supersessions WHERE source_id = ?').run(source.id);
  const add = db.prepare('INSERT OR IGNORE INTO decision_partial_supersessions (source_id, target_id) VALUES (?, ?)');
  for (const note of supersedeNotes(source.text)) for (const t of targetsOf(note, docs, source)) add.run(source.id, t);
}

/**
 * Record what `id` supersedes in other files, and redo the resolution of every decision whose
 * sentence names the file `id` is in, so a row arriving later moves a single-row fallback link
 * onto the row the rule word picks. Idempotent. The docs rows are loaded and scanned only when
 * `id` itself says "supersede" or a stored decision does and names `id`'s file: an ingest with no
 * such sentence anywhere costs one indexed delete and one LIKE.
 */
export function linkPartialSupersessions(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM decision_partial_supersessions WHERE source_id = ? OR target_id = ?').run(id, id);
  const self = db.prepare(`SELECT id, source_url AS sourceUrl, repo, title || char(10) || summary AS text, platform FROM decisions WHERE id = ?`).get(id) as (DocRow & { platform: string }) | undefined;
  if (!self || self.platform !== 'docs' || self.sourceUrl === null) return;
  // LIKE is case-insensitive for ASCII, which is the prefilter the check below repeats exactly.
  const namers = (db.prepare(`SELECT id, source_url AS sourceUrl, repo, title || char(10) || summary AS text FROM decisions WHERE platform = 'docs' AND id != ? AND (title LIKE '%supersede%' OR summary LIKE '%supersede%')`).all(id) as unknown as DocRow[])
    .filter((o) => supersedeNotes(o.text).some((n) => inFile(self, n.file)));
  const selfNames = /supersede/i.test(self.text) && supersedeNotes(self.text).length > 0;
  if (!selfNames && namers.length === 0) return;
  const docs = db.prepare(DOCS).all() as unknown as DocRow[];
  if (selfNames) relink(db, self, docs);
  for (const o of namers) relink(db, o, docs);
}

/** The decisions that say they replace part of `targetId`, newest row first. */
export function partialSupersessorsOf(db: DatabaseSync, targetId: string): string[] {
  if (!hasPartialSupersessionTable(db)) return [];
  return (db.prepare(
    `SELECT s.id AS id FROM decision_partial_supersessions p JOIN decisions s ON s.id = p.source_id WHERE p.target_id = ? ORDER BY s.created_at DESC, s.rowid DESC`,
  ).all(targetId) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * A row of `url`'s file is gone: redo the resolution of every decision naming that file, so a link
 * that rested on the single-row fallback or on the deleted row does not go stale.
 */
export function relinkNamersOfFile(db: DatabaseSync, url: string | null): void {
  if (url === null || !hasPartialSupersessionTable(db)) return;
  const namers = (db.prepare(`SELECT id, source_url AS sourceUrl, repo, title || char(10) || summary AS text FROM decisions WHERE platform = 'docs' AND (title LIKE '%supersede%' OR summary LIKE '%supersede%')`).all() as unknown as DocRow[])
    .filter((o) => supersedeNotes(o.text).some((n) => inFile({ sourceUrl: url } as DocRow, n.file)));
  if (namers.length === 0) return;
  const docs = db.prepare(DOCS).all() as unknown as DocRow[];
  for (const o of namers) relink(db, o, docs);
}
