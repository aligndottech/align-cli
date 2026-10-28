/**
 * How `align ask` prints its ranked list when no answer was written (no provider,
 * or the provider failed). Display only - retrieval and ranking are untouched, and `--json`
 * never reaches this module.
 *
 * A commit body is the match's summary, and it arrives with its own hard line wraps and
 * trailers. Printed whole, one `ask` on a 4,906-commit repo was 516 lines. The list is for
 * scanning: title, a short excerpt, where it came from.
 */
import { stripImporterMetadata, TRAILER } from './reason-extract.js';
import { RELATES_THRESHOLD } from './local-thresholds.js';

/** Characters of summary shown per match. A display choice, not a calibrated number. */
export const EXCERPT_MAX_CHARS = 200;

/**
 * Matches printed when the user did not type --limit. Retrieval still fetches the CLI's
 * default (8); this only trims what the no-answer list shows. A display choice too.
 */
export const LIST_DISPLAY_CAP = 5;

/**
 * Below this a match is called weak. It is the relatedness floor the CLI already uses
 * (RELATES_THRESHOLD), not a new number. Measured on fastify (4,906 commits, 10 questions,
 * dense cosine): questions with a real answer in the graph scored 48-51% at best, questions
 * with none scored 31-42% at best. Noisy at 45-49%, which is why a weak set is marked, not hidden.
 */
export const WEAK_MATCH_BELOW = RELATES_THRESHOLD;

/**
 * Collapse hard wraps and blank lines to single spaces, then cut at a word boundary.
 * Never cuts mid-word: when the cap lands inside a word, that whole word is dropped.
 * A summary that already fits comes back unchanged (whitespace collapsed, no ellipsis).
 */
export function excerptOf(summary: string, max: number = EXCERPT_MAX_CHARS): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // The character right after the cap decides: a space there means the cut is already on a boundary.
  const cut = flat[max] === ' ' ? flat.slice(0, max) : flat.slice(0, max).replace(/\s*\S*$/, '');
  // One token longer than the cap (a URL, a hash): keep it whole rather than print an empty excerpt.
  const kept = cut.trimEnd() || flat.split(' ')[0];
  return `${kept}...`;
}

export function isWeak(similarity: number | undefined): boolean {
  return similarity !== undefined && similarity < WEAK_MATCH_BELOW;
}

/** True when every match with a score is weak. No scores at all is not "weak". */
export function allWeak(similarities: Array<number | undefined>): boolean {
  const scored = similarities.filter((s): s is number => s !== undefined);
  return scored.length > 0 && scored.every(isWeak);
}

export function matchNoun(count: number): string {
  return `${count} related decision${count === 1 ? '' : 's'}`;
}

/**
 * A commit's summary opens with its own title (the commit message), which the line above
 * already printed. Drop that echo so the excerpt is the body. Only an exact leading match.
 */
export function withoutTitle(summary: string, title: string): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  const t = title.replace(/\s+/g, ' ').trim();
  return t && flat.startsWith(`${t} `) ? flat.slice(t.length + 1) : flat;
}

// The dashed rule a squash merge puts above its trailers. The trailer keys themselves come from
// reason-extract's TRAILER, the one list, anchored to the line start.
const SEPARATOR_LINE = /^\s*-{3,}\s*$/;

/**
 * A commit body without its TRAILING block of git trailers (reason-extract's TRAILER list) and
 * the `---------` rule squash merges add above them. Only the end is stripped, as git defines
 * trailers: a mid-body or opening "Issue: ..." line, or a markdown rule, stays. Line-based, so
 * it must run BEFORE whitespace is flattened. Display only: the stored summary keeps its
 * trailers, which are provenance and still feed search.
 */
export function withoutTrailers(summary: string): string {
  const lines = summary.split('\n');
  let end = lines.length;
  // Walk up from the end over trailer lines, blanks and dashed rules; the first other line ends the block.
  while (end > 0 && (TRAILER.test(lines[end - 1]) || SEPARATOR_LINE.test(lines[end - 1]) || !lines[end - 1].trim())) end -= 1;
  return lines.slice(0, end).join('\n').trim();
}

const normTitle = (t: string): string =>
  t.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\s*\(#\d+\)$/, '');

/**
 * What a ranked-list row quotes under its title: the body with importer metadata, trailers
 * and the echoed title removed. Empty when nothing is left, or what is left only repeats the
 * title (whitespace, case and a trailing "(#123)" ignored): the caller then prints no quote.
 */
export function excerptBody(summary: string, title: string): string {
  const body = withoutTitle(withoutTrailers(stripImporterMetadata(summary)), title);
  return normTitle(body) === normTitle(title) ? '' : body;
}
