/**
 * ALI-1780: how `align ask` prints its ranked list when no answer was written (no provider,
 * or the provider failed). Display only - retrieval and ranking are untouched, and `--json`
 * never reaches this module.
 *
 * A commit body is the match's summary, and it arrives with its own hard line wraps and
 * trailers. Printed whole, one `ask` on a 4,906-commit repo was 516 lines. The list is for
 * scanning: title, a short excerpt, where it came from.
 */
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
