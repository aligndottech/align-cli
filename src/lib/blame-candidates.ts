import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { blameCommits, type BlamedCommit, type BlameOpts, isProseOrGeneratedFile, isWriterTitle, makeGitRunner, prUrlsFor, type Range } from './blame-attribution.js';
import type { DecisionRow, LocalDb } from './local-db.js';

/**
 * Candidates for the planning-time check (`align_check_alignment`): the decisions that wrote the code
 * the change is about to touch, found with `git blame` and a keyed lookup, no model.
 *
 *  - the input is a unified diff: blame each hunk's OLD-side lines (`blame-lines`);
 *  - otherwise, if the text names repo files that exist: the most recent decision writers of each file,
 *    capped at 3 per file (`blame-file`);
 *  - otherwise nothing.
 *
 * They are CANDIDATES. The existing judge still decides whether any of them is a conflict; being the
 * writer of a line is never a conflict by itself. Same writer filters as the edit hook (isWriterTitle, and
 * no blame for prose or lockfiles). The whole thing shares one time budget and fails open to [].
 */
export type BlameVia = 'blame-lines' | 'blame-file';
export interface BlameCandidate { row: DecisionRow; via: BlameVia }

export const CANDIDATE_BUDGET_MS = 2000;
const MAX_FILES = 3;
const MAX_WRITERS_PER_FILE = 3;
const MAX_FILE_LINES = 5000;
const MAX_HUNK_LINES = 400;

interface Target { file: string; ranges: Range[] | null; via: BlameVia }

/** Old-side line ranges per file of a unified diff. Pure insertions (old count 0) have no old lines to blame. */
export function parseDiffOldRanges(text: string): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  let file: string | null = null;
  for (const line of text.split('\n')) {
    const from = /^--- (?:a\/)?(\S.*?)(?:\t.*)?$/.exec(line);
    if (from) { file = from[1] === '/dev/null' ? null : from[1]!; continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) out.set(file, [...(out.get(file) ?? []), [start, start + Math.min(count, MAX_HUNK_LINES) - 1]]);
    }
  }
  return out;
}

const FILE_LIKE = /(?<![\w./@-])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]*)(?![\w-])/g;

/** File-looking tokens in prose, in order, unique. A token only counts later if it is a real file inside the repo. */
export function pathsNamedIn(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_LIKE)].map((m) => m[1]!))];
}

async function insideRepoFile(cwd: string, name: string): Promise<string | null> {
  const abs = path.resolve(cwd, name);
  const rel = path.relative(cwd, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try { return (await stat(abs)).isFile() ? abs : null; } catch { return null; }
}

async function targetsFor(text: string, cwd: string): Promise<Target[]> {
  const targets: Target[] = [];
  const diff = parseDiffOldRanges(text);
  if (diff.size) {
    for (const [name, ranges] of diff) {
      if (targets.length >= MAX_FILES) break;
      const abs = isProseOrGeneratedFile(name) ? null : await insideRepoFile(cwd, name);
      if (abs) targets.push({ file: abs, ranges, via: 'blame-lines' });
    }
    return targets;
  }
  for (const name of pathsNamedIn(text)) {
    if (targets.length >= MAX_FILES) break;
    const abs = isProseOrGeneratedFile(name) ? null : await insideRepoFile(cwd, name);
    if (abs) targets.push({ file: abs, ranges: null, via: 'blame-file' });
  }
  return targets;
}

export async function blameCandidates(
  text: string,
  cwd: string,
  db: Pick<LocalDb, 'findBySourceRefs'>,
  opts: BlameOpts = {},
): Promise<BlameCandidate[]> {
  try {
    const targets = await targetsFor(text, cwd);
    if (!targets.length) return [];
    const deadline = Date.now() + (opts.timeoutMs ?? CANDIDATE_BUDGET_MS);
    const perFile = await Promise.all(targets.map(async (t): Promise<BlameCandidate[]> => {
      try {
        const run = (args: string[]) => makeGitRunner({ ...opts, timeoutMs: Math.max(1, deadline - Date.now()) }, path.dirname(t.file))(args);
        const ranges: Range[] = t.ranges ?? [[1, Math.min(MAX_FILE_LINES, (await readFile(t.file, 'utf8')).split('\n').length)]];
        const commits = (await blameCommits(t.file, ranges, run)).sort((a, b) => b.time - a.time);
        if (!commits.length) return [];
        const prUrls = await prUrlsFor(commits, run);
        return rowsFor(commits, prUrls, db, t.via);
      } catch {
        return [];
      }
    }));
    const seen = new Set<string>();
    return perFile.flat().filter((c) => (seen.has(c.row.id) ? false : (seen.add(c.row.id), true)));
  } catch {
    return [];
  }
}

/** Newest-first writers: each commit's decision (by sha, or by its PR url), filtered like the hook, capped per file for a whole-file blame. */
function rowsFor(commits: BlamedCommit[], prUrls: string[], db: Pick<LocalDb, 'findBySourceRefs'>, via: BlameVia): BlameCandidate[] {
  const prFor = (c: BlamedCommit): string[] => {
    const n = /\(#(\d+)\)\s*$/.exec(c.subject)?.[1] ?? /^Merge pull request #(\d+)\b/.exec(c.subject)?.[1];
    return n ? prUrls.filter((u) => u.endsWith(`/pull/${n}`)) : [];
  };
  const out: BlameCandidate[] = [];
  const seen = new Set<string>();
  for (const c of commits) {
    for (const row of db.findBySourceRefs([c.sha], prFor(c))) {
      if (seen.has(row.id) || !isWriterTitle(row.title)) continue;
      seen.add(row.id);
      out.push({ row, via });
    }
  }
  return via === 'blame-file' ? out.slice(0, MAX_WRITERS_PER_FILE) : out;
}
