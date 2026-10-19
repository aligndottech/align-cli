/**
 * ALI-1749 / ALI-1782: the evidence block the model writes an `align ask` answer from.
 *
 * Raw commit bodies invite a confident-sounding invented rationale (a version bump read as "chosen
 * for its robustness"). So each retrieved decision is rendered as structured fields: id, date,
 * source, similarity and `reason`, the author's own stated why pulled out by extractReason with no
 * model. A short excerpt appears ONLY when no reason was found, and dependency bumps and other
 * housekeeping rows are marked as stating no reason so the model has nothing to infer a motive from.
 *
 * Quoted text is JSON-escaped onto one line: retrieved text is attacker-controlled data, and a body
 * with a newline must not be able to forge a new row or an instruction-looking line.
 */
import { excerptOf, withoutTitle } from './ask-listing.js';
import { extractReason, stripImporterMetadata } from './reason-extract.js';

/** Characters of body shown when a row has no reason. A display choice, kept short on purpose. */
export const EVIDENCE_EXCERPT_MAX_CHARS = 240;

export interface EvidenceDecision {
  id: string;
  title: string;
  summary: string;
  /** What to cite this decision as (a commit cite, a PR number). Falls back to `id`. */
  ref?: string;
  date?: string;
  platform?: string;
  similarity?: number;
}

const HOUSEKEEPING_TITLE = [
  /^(?:chore|build|ci|fix|deps?)(?:\([^)]*\))?!?:\s*(?:bump|update|upgrade|release|pin|lock|renovate|dependabot)\b/i,
  /^(?:chore|build)\(deps(?:-dev)?\)/i,
  /^(?:chore\(main\):\s*)?release\b/i,
  /^bump\b/i,
  /^(?:update|upgrade) (?:dependency|dependencies|lockfile|deps)\b/i,
  /^update lockfile\b/i,
  /^merge (?:pull request|branch|remote-tracking)\b/i,
  /^v?\d+\.\d+\.\d+(?:[-.\w]*)?$/,
];
const HOUSEKEEPING_BODY = /^\s*(?:bumps?|updates?|upgrades?)\s+(?:\[?`?[\w@/.-]+`?\]?(?:\([^)]*\))?\s+)?(?:from|to)\b|this pr contains the following updates|^\s*dependabot will resolve/im;

/** A dependency bump, release or merge row: it records that something changed, never why. */
export function isHousekeeping(title: string, body: string): boolean {
  const t = (title ?? '').trim();
  return HOUSEKEEPING_TITLE.some((re) => re.test(t)) || HOUSEKEEPING_BODY.test(stripImporterMetadata(body ?? ''));
}

const quote = (s: string): string => JSON.stringify(s.replace(/\s+/g, ' ').trim());

/** The text a row's own title line echoes is dropped from its excerpt, as the ranked list does. */
function excerptFor(d: EvidenceDecision): string {
  const body = withoutTitle(stripImporterMetadata(d.summary ?? ''), d.title);
  return excerptOf(body, EVIDENCE_EXCERPT_MAX_CHARS);
}

/** One row. It opens with its id, the handle the answer cites, and carries no row number the model could cite instead. */
export function renderEvidence(d: EvidenceDecision): string {
  const head = [`id: ${d.ref ?? d.id}`];
  if (d.date) head.push(`date: ${d.date}`);
  if (d.platform) head.push(`source: ${d.platform}`);
  if (d.similarity !== undefined) head.push(`match: ${d.similarity.toFixed(2)}`);
  const lines = [head.join(' | '), `title: ${quote(d.title)}`];
  const reason = extractReason(d.title, d.summary);
  if (reason) {
    lines.push(`reason: ${quote(reason)}`);
  } else {
    lines.push('reason: none stated');
    if (isHousekeeping(d.title, d.summary)) {
      lines.push('[housekeeping: states no reason]');
    } else {
      const excerpt = excerptFor(d);
      if (excerpt) lines.push(`excerpt: ${quote(excerpt)}`);
    }
  }
  return lines.join('\n');
}
