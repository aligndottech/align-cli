import { execa } from 'execa';
import { normaliseDecidedAt } from '../local-db.js';

/**
 * When an ADR was decided (ALI-2114), in the order a human would trust it:
 *  1. a `Date:` line in the body (Nygard; `* Date:` and `**Date:**` too) or an AsciiDoc `:revdate:`,
 *  2. YAML front matter `date:` (MADR),
 *  3. the date of the file's first commit, when the repo is a git repo.
 * A declared date that is not a real date drops the field: it is never replaced by a guess.
 */
const DATE_LINE = /^[ \t>*_-]*(?:date[*_]*[ \t]*:|:revdate:)[*_ \t]*["']?([^\r\n"']*)/im;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const FM_DATE = /^date[ \t]*:[ \t]*["']?([^\r\n"']*)/im;

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
export function declaredAdrDate(content: string): string | null | undefined {
  const fm = content.match(FRONT_MATTER);
  const body = fm ? content.slice(fm[0].length) : content;
  const line = body.match(DATE_LINE);
  if (line) return isoOrNull(line[1]);
  const fmDate = fm?.[1].match(FM_DATE);
  if (fmDate) return isoOrNull(fmDate[1]);
  return undefined;
}

/** Author date of the commit that first added the file, or undefined (not a repo, untracked, git missing). */
export async function firstCommitDate(repoRoot: string, relPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa('git', ['log', '--follow', '--find-renames=100%', '--diff-filter=A', '--format=%aI', '--', relPath], { cwd: repoRoot });
    const last = stdout.trim().split('\n').pop()?.trim();
    return last && normaliseDecidedAt(last) !== null ? last : undefined;
  } catch {
    return undefined;
  }
}

export async function adrDecisionDate(repoRoot: string, relPath: string, content: string): Promise<string | undefined> {
  const declared = declaredAdrDate(content);
  if (declared !== undefined) return declared ?? undefined; // a bad declared date is dropped, not replaced
  return firstCommitDate(repoRoot, relPath);
}
