/**
 * The evidence block the model writes an `align ask` answer from.
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

const VERSIONED = String.raw`(?:from\s+\S+\s+to\s+\S+|to\s+v?\d+(?:\.\d+)*\b|\bv?\d+\.\d+)`;
const HOUSEKEEPING_TITLE = [
  new RegExp(String.raw`^(?:chore|build|ci|fix|deps?)(?:\([^)]*\))?!?:\s*(?:bump|update|upgrade|pin)\b[^\n]*${VERSIONED}`, 'i'),
  /^(?:chore|build)\(deps(?:-dev)?\)/i,
  /^chore\(main\):\s*release\b/i,
  /^release\s+v?\d+\.\d+/i,
  new RegExp(String.raw`^bump\b[^\n]*(?:${VERSIONED}|$)`, 'i'),
  /^(?:update|upgrade) (?:dependency|dependencies|lockfile|deps)\b/i,
  /^update lockfile\b/i,
  /^merge (?:pull request|branch|remote-tracking)\b/i,
  /^v?\d+\.\d+\.\d+(?:[-.\w]*)?$/,
];
// Only the first line of the body: "Update X to Y" further down is ordinary prose, not a bump.
const HOUSEKEEPING_BODY = new RegExp(String.raw`^\s*(?:bumps?|updates?|upgrades?)\s+(?:\[?\x60?[\w@/.-]+\x60?\]?(?:\([^)]*\))?\s+)?${VERSIONED}|this pr contains the following updates|^\s*dependabot will resolve`, 'i');

/** A dependency bump, release or merge row: it records that something changed, never why. */
export function isHousekeeping(title: string, body: string): boolean {
  const t = (title ?? '').trim();
  const flat = stripImporterMetadata(body ?? '').trimStart();
  const nl = flat.indexOf('\n');
  const firstLine = nl < 0 ? flat : flat.slice(0, nl);
  return HOUSEKEEPING_TITLE.some((re) => re.test(t)) || HOUSEKEEPING_BODY.test(firstLine) || /this pr contains the following updates|^\s*dependabot will resolve/im.test(flat);
}

/** A header field is a single token: anything outside this set (a newline, a pipe, a quote) is dropped, so it cannot forge a row. */
const field = (s: string): string => s.replace(/[^\w@#./:+-]/g, '');
const quote = (s: string): string => JSON.stringify(s.replace(/\s+/g, ' ').trim());

/** The text a row's own title line echoes is dropped from its excerpt, as the ranked list does. */
function excerptFor(d: EvidenceDecision, max: number): string {
  const body = withoutTitle(stripImporterMetadata(d.summary ?? ''), d.title);
  // excerptOf keeps one over-long token whole (a URL, a hash); here that token is a wall, so cut it.
  const cut = excerptOf(body, max);
  return cut.length > max + 3 ? `${cut.slice(0, max)}...` : cut;
}

/** One row. It opens with its id, the handle the answer cites, and carries no row number the model could cite instead. */
export function renderEvidence(d: EvidenceDecision, excerptMax: number = EVIDENCE_EXCERPT_MAX_CHARS): string {
  const head = [`id: ${field(d.ref ?? d.id)}`];
  if (d.date) head.push(`date: ${field(d.date)}`);
  if (d.platform) head.push(`source: ${field(d.platform)}`);
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
      const excerpt = excerptMax > 0 ? excerptFor(d, Math.min(excerptMax, EVIDENCE_EXCERPT_MAX_CHARS)) : '';
      if (excerpt) lines.push(`excerpt: ${quote(excerpt)}`);
    }
  }
  return lines.join('\n');
}
