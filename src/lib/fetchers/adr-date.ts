import { execa } from 'execa';
import { normaliseDecidedAt } from '../local-db.js';

/**
 * When an ADR was decided (ALI-2114), in the order a human would trust it:
 *  1. a `Date:` line in the body (Nygard; `* Date:` and `**Date:**` too) or an AsciiDoc `:revdate:`,
 *  2. YAML front matter `date:` (MADR),
 *  3. the date of the file's first commit, when the repo is a git repo.
 * A declared date that is not a real date drops the field: it is never replaced by a guess.
 */
const DATE_LINE = /^[ \t*_-]*(?:date[*_]*[ \t]*:|:revdate:)[*_ \t]*["']?([^\r\n"']*)/im;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const FM_DATE = /^date[ \t]*:[ \t]*["']?([^\r\n"']*)/im;

/**
 * Drop fenced code blocks line by line (CommonMark): the opener records its character and
 * length; only a line of the SAME character, at least that long, with nothing after it but
 * whitespace closes it; an unclosed fence runs to the end of input.
 */
function stripFences(text: string): string {
  const out: string[] = [];
  let open: { ch: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    if (open === null) {
      const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
      if (m) open = { ch: m[1][0], len: m[1].length };
      else out.push(line);
    } else {
      const m = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/);
      if (m && m[1][0] === open.ch && m[1].length >= open.len) open = null;
    }
  }
  return out.join('\n');
}

/** A blank value or an unfilled template placeholder ("{YYYY-MM-DD ...}") is not a declaration. */
function isUnfilled(value: string): boolean {
  const v = value.trim();
  return v === '' || /^\{.*\}?$|YYYY/.test(v);
}

/** Only an ISO day (or instant) counts: '12' or 'March' must not become a date. */
function isoOrNull(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)\s*$/);
  if (!m) return null;
  const day = m[1].slice(0, 10);
  // Date.parse rolls 2024-13-45 over silently in some engines; require the day to round-trip.
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return null;
  return normaliseDecidedAt(m[1]) === null ? null : m[1];
}

/** The date an ADR declares, or `undefined` when it declares none. `null` means it declared a bad one. */
export function declaredAdrDate(content: string, adoc = false): string | null | undefined {
  const fm = content.match(FRONT_MATTER);
  const body = fm ? content.slice(fm[0].length) : content;
  // Only the header declares the date: a Date line in a code fence, a quote, a revision log
  // or any later section is content about something else. Header = before the first section.
  const noFences = stripFences(body);
  const header = noFences.split(adoc ? /^==[ \t]/m : /^##[ \t]/m)[0];
  const line = header.match(DATE_LINE);
  // An unfilled value is not a declaration; a value a person wrote ("TBD") is, and drops the field (D4b).
  if (line && !isUnfilled(line[1])) return isoOrNull(line[1]);
  const fmDate = fm?.[1].match(FM_DATE);
  if (fmDate && !isUnfilled(fmDate[1])) return isoOrNull(fmDate[1]);
  return undefined;
}

const GIT_TIMEOUT_MS = 10_000;
export const GIT_CONCURRENCY = 8;

/** In a shallow clone the root commit "adds" every file, so a git date there is the clone's, not the ADR's. */
export async function isShallowRepo(repoRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoRoot, timeout: GIT_TIMEOUT_MS });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Order-preserving map with at most `limit` calls in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Author date of the commit that first added the file, or undefined (not a repo, untracked, git missing). */
export async function firstCommitDate(
  repoRoot: string, relPath: string, opts: { timeoutMs?: number } = {},
): Promise<string | undefined> {
  try {
    const { stdout } = await execa(
      'git', ['log', '--follow', '--find-renames=100%', '--diff-filter=A', '--format=%aI', '--', relPath],
      { cwd: repoRoot, timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS },
    );
    // Not `--reverse`: git applies it before --follow's rename tracking and loses the pre-move adds.
    // Take the earliest add by instant instead, so merged or rebased history cannot pick a later one.
    // Returned as one canonical ISO instant: git prints %aI as `+00:00` or `Z` depending on its
    // version, and the stored value must not depend on which git the user has.
    let best: number | undefined;
    for (const raw of stdout.split('\n').map((l) => l.trim())) {
      const iso = normaliseDecidedAt(raw);
      if (iso === null) continue;
      const ms = Date.parse(iso);
      if (best === undefined || ms < best) best = ms;
    }
    return best === undefined ? undefined : new Date(best).toISOString();
  } catch {
    return undefined;
  }
}

export async function adrDecisionDate(
  repoRoot: string, relPath: string, content: string, useGit = true,
): Promise<string | undefined> {
  const declared = declaredAdrDate(content, /\.(adoc|asciidoc)$/i.test(relPath));
  if (declared !== undefined) return declared ?? undefined; // a bad declared date is dropped, not replaced
  return useGit ? firstCommitDate(repoRoot, relPath) : undefined;
}
