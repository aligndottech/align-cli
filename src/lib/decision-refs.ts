/**
 * What a decision's text points AT: ticket keys, PR/issue numbers, and links into the
 * tools where the rest of the story lives (ALI-792).
 *
 * These refs are the foundation of the gap-driven connect prompt ("12 decisions cite
 * Jira keys I can't read - `align connect jira`"): a ref whose platform has no
 * connected source is a gap the graph can name. Until this module, the git import
 * discarded the commit body, so every one of these shapes died before ingest.
 *
 * Platforms are connector ids where the ref names one ('slack', 'jira', ...), 'tracker'
 * for a bare KEY-123 that cannot distinguish Jira from Linear, and 'code' for a #N
 * pull/issue number that belongs to whichever forge hosts the repo. Only shapes a
 * connect prompt can act on are extracted - an arbitrary web URL is not a gap.
 */

export interface DecisionRef {
  ref: string;
  platform: 'github' | 'jira' | 'confluence' | 'linear' | 'slack' | 'tracker' | 'code';
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
/** Trailing prose punctuation is not part of a URL someone pasted mid-sentence. */
const TRAILING_PUNCTUATION = /[.,;:!?\]]+$/;

const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
/**
 * KEY-N shapes that are technical vocabulary, not tracker tickets (review finding,
 * 2026-09-01): UTF-8, SHA-256, ISO-8601, RFC-8446, TLS-1.3, X86-64, AES-256, MD-5
 * are routine in commit bodies, and CVE-2024-N names an advisory no connector can
 * fill. Matched on the letter prefix, so SHA-256 and SHA-512 both stay out.
 */
const VOCABULARY_PREFIXES = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'TLS', 'X86', 'AES', 'MD', 'CVE']);
/** `#N` only when it starts a word (after whitespace, "(", or start of line) and is
 *  immediately followed by digits - "# 45" is a markdown heading, not an issue. */
const ISSUE_NUMBER = /(?:^|[\s(])(#\d+)\b/gm;

function countOf(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function classifyUrl(url: string): DecisionRef['platform'] | null {
  if (/slack\.com\/archives\//.test(url)) return 'slack';
  if (/linear\.app\//.test(url)) return 'linear';
  if (/\/browse\/[A-Z][A-Z0-9]*-\d+/.test(url)) return 'jira';
  if (/atlassian\.net\/wiki\//.test(url)) return 'confluence';
  // A commit URL is the decision's OWN address (formatCommitAsText appends it),
  // not a reference to something the graph cannot see.
  if (/\/commit\//.test(url)) return null;
  if (/\/(?:pull|issues)\/\d+/.test(url)) return 'github';
  return null;
}

export function extractRefs(text: string): DecisionRef[] {
  const found = new Map<string, DecisionRef>();
  const add = (ref: string, platform: DecisionRef['platform']) => {
    if (!found.has(ref)) found.set(ref, { ref, platform });
  };

  // URLs first, then blank them out of the text, so a ticket key that only exists
  // inside a URL's path is one ref, not two - a double-counted gap prompt overstates
  // every linked ticket.
  let remaining = text;
  for (const raw of text.match(URL_PATTERN) ?? []) {
    let url = raw.replace(TRAILING_PUNCTUATION, '');
    // A ")" belongs to the URL only while an "(" inside it is unclosed - Confluence
    // pretty-URLs carry balanced parens ("...Auth+(v2)"), while "(see <url>)" wraps
    // the whole thing in prose parens that are not part of it.
    while (url.endsWith(')') && countOf(url, '(') < countOf(url, ')')) {
      url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
    }
    const platform = classifyUrl(url);
    if (platform) add(url, platform);
    remaining = remaining.replace(raw, ' ');
  }

  for (const key of remaining.match(TICKET_KEY) ?? []) {
    if (VOCABULARY_PREFIXES.has(key.slice(0, key.indexOf('-')))) continue;
    add(key, 'tracker');
  }
  for (const m of remaining.matchAll(ISSUE_NUMBER)) {
    add(m[1], 'code');
  }

  return [...found.values()];
}
