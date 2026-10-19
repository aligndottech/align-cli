/**
 * ALI-1749: the STATED reason behind a decision, pulled out of its own text with no model.
 *
 * `align ask` with no AI key lists related commits, and the first lines of a commit body are
 * often not the reason (a dependabot bump opens with release-note boilerplate, a squash merge
 * opens with a bullet list of sub-titles). This picks up to two sentences that SAY why.
 *
 * Rules, all deterministic and offline:
 *  - a sentence qualifies only through a causal marker (because, so that, to avoid, ...) or an
 *    explicit "Why:" / "Reason:" label. Strong markers outrank medium ones.
 *  - the text is the author's own words, only cleaned of markup. Nothing is paraphrased or invented.
 *  - what the importer embeds (Author/Date/Files changed/URL, see formatCommitAsText), commit
 *    trailers, "Fixes #N" lines, dependabot/renovate bodies, release-note dumps, tables, code,
 *    HTML comments and URLs are never reasons.
 *  - a sentence that only repeats the title is dropped.
 *  - null when nothing qualifies. A wrong reason is worse than none.
 */

/** Per-sentence cap, cut at a word boundary. A display choice, like EXCERPT_MAX_CHARS. */
export const REASON_MAX_CHARS = 180;
/** Reasons returned at most. */
const MAX_SENTENCES = 2;
/** Only the head of a body is read: a 280k-character line must not cost a second. */
const MAX_INPUT_CHARS = 6000;
/** Fewer words than this is a heading or a label, not a statement. */
const MIN_WORDS = 5;

// formatCommitAsText (src/lib/git.ts) appends: Author, Date, optional Files changed list, optional URL.
const IMPORTER_METADATA = /\n\nAuthor: [^\n]*\n\nDate: [^\n]*(?:\n\n(?:Files changed:|URL:)[\s\S]*)?$/;

/** The Author/Date/Files changed/URL block the git importer appends, removed. Anything else is returned unchanged. */
export function stripImporterMetadata(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(IMPORTER_METADATA, '');
}

const TRAILER = /^\s*(?:co-authored-by|signed-off-by|reviewed-by|reviewed-on|acked-by|tested-by|reported-by|suggested-by|helped-by|change-id|pr-url|cc|bug|jira|issue)\s*:/i;
const ISSUE_REF = '(?:#\\d+|gh-\\d+|[\\w.-]+\\/[\\w.-]+#\\d+|https?:\\/\\/\\S+)';
const FIXES_ONLY = new RegExp(`^\\s*(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|refs?|see|related to|part of)\\b:?\\s*${ISSUE_REF}(?:[\\s,;&]+(?:and\\s+)?${ISSUE_REF})*\\s*[.]?\\s*$`, 'i');

// Sections that start a dump of someone else's changes.
const DUMP_HEADING = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?(?:what'?s changed|release notes?|changelog|full changelog|commits|sourced from)\b/im;
const BUMP_BODY = /^\s*(?:bumps?|updates?|upgrades?)\s+(?:\[?`?[\w@/.-]+`?\]?(?:\([^)]*\))?\s+)?(?:from|to)\b|this pr contains the following updates|^\s*dependabot will resolve/im;

const STRONG = [
  /\bbecause\b/i, /\bso that\b/i, /\bin order to\b/i, /\bto avoid\b/i, /\bto prevent\b/i,
  /\bdue to\b/i, /\bas a result\b/i, /\bwas causing\b/i, /\bcaused by\b/i,
  // "since" as a cause starts a clause ("since it is...", "since Cargo finds..."); as a date or
  // version it does not ("since node 16", "since pnpm/pnpm#1234", "since the first release").
  /\bsince\s+(?:(?:the|it|its|we|they|this|that|there|a|an|our|these|those|you|i|all|both|each|every|no|not|only|one|most|many)\b(?!\s+(?:last|first|previous|beginning|start|release|version|v?\d))|[\w.:/#-]+\s+(?:is|are|was|were|has|have|had|does|do|can|could|will|would|must|should|may|might|needs?|uses?|finds?|takes?|lives?|stores?|ignores?|supports?|reads?|runs?|returns?|calls?|makes?|requires?|works?|handles?|treats?)\b)/i,
];
// These words DESCRIBE a change as often as they explain it ("X is no longer emitted", "use Y
// instead of Z"), so measured on fastify, vite and pnpm they were most of the noise. They count
// only next to a word that names a problem.
const MEDIUM = [
  /\binstead of\b/i, /\brather than\b/i, /\bpreviously\b/i, /\bno longer\b/i, /\bto fix\b/i,
  /\bregression\b/i, /\bdeprecated\b/i, /\breplaces\b/i, /\botherwise\b/i,
];
const PROBLEM = /\b(?:break(?:s|ing)?|broke|broken|fail(?:s|ed|ing|ure)?|crash(?:es|ed|ing)?|leak(?:s|ed|ing)?|incorrect(?:ly)?|wrong(?:ly)?|bugs?|errors?|slow(?:er|ly)?|hangs?|lead(?:s|ing)? to|result(?:s|ed|ing)? in|caus(?:e|es|ed|ing))\b/i;
const WEAK = [/\bsecurity\b/i, /\bperformance\b/i, /\bvulnerab\w*/i, /\bmemory leak\b/i, /\bcrash(?:es|ed)?\b/i];
const LABEL = /^(why|reason|rationale|motivation|problem)\s*:\s*/i;

const CONVENTIONAL_PREFIX = /^[a-z]+(?:\([^)]*\))?!?:\s+/;
const BULLET = /^\s*(?:[*+-]|\d+[.)])\s+/;
const NOISE_SENTENCE = /^merge pull request\b|\b(?:sourced from|dependabot|renovate)\b/i;

// A removed URL leaves a marker, so a reason whose OBJECT was the link ("because of <url>") can be
// dropped rather than printed with a hole in it. Only real HTML tags are stripped: `<path>` in a
// sentence is placeholder text the author wrote.
const URL_HOLE = '\uE000';
const HTML_TAG = /<\/?(?:a|p|em|strong|b|i|u|code|pre|br|hr|h[1-6]|ul|ol|li|details|summary|blockquote|div|span|img|sup|sub|table|thead|tbody|tr|td|th)\b[^>]*>/gi;
const DANGLING_LINK = /(?:\b(?:because of|due to|of|to|by|with|from|for|on|in|and|or)|,)\s*\uE000/;

function stripMarkup(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(HTML_TAG, ' ')
    .replace(/https?:\/\/\S+/g, ` ${URL_HOLE} `)
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function isMostlyEnglish(s: string): boolean {
  const letters = s.match(/\p{L}/gu)?.length ?? 0;
  const ascii = s.match(/[A-Za-z]/g)?.length ?? 0;
  return letters > 0 && ascii / letters >= 0.8;
}

function repeatsTitle(sentence: string, titleWords: string[], titleBodyWords: string[]): boolean {
  const sw = words(sentence);
  if (!sw.length || !titleWords.length) return false;
  const inTitle = new Set(titleWords);
  if (sw.filter((w) => inTitle.has(w)).length / sw.length >= 0.8) return true;
  // The importer cuts a long title at 80 characters, so a body that opens with the whole subject
  // continues past where the title stops. Same words up to the cut, last (cut) word aside.
  const head = titleBodyWords.slice(0, -1);
  return head.length >= 3 && head.every((w, i) => sw[i] === w);
}

function score(sentence: string, labelled: boolean): number {
  let n = labelled ? 3 : 0;
  if (STRONG.some((re) => re.test(sentence))) n = Math.max(n, 3);
  else if (MEDIUM.some((re) => re.test(sentence)) && PROBLEM.test(sentence.replace(/breaking change/gi, ''))) n = Math.max(n, 2);
  if (n > 0 && WEAK.some((re) => re.test(sentence))) n += 0.5;
  return n;
}

function cap(sentence: string): string {
  if (sentence.length <= REASON_MAX_CHARS) return sentence;
  const head = sentence.slice(0, REASON_MAX_CHARS);
  const cut = sentence[REASON_MAX_CHARS] === ' ' ? head : head.replace(/\s*\S*$/, '');
  return `${(cut.trimEnd() || head).replace(/[,;:\-\s]+$/, '')}...`;
}

function firstMarker(sentence: string): { index: number; end: number } | null {
  let best: { index: number; end: number } | null = null;
  for (const re of [...STRONG, ...MEDIUM]) {
    const m = re.exec(sentence);
    if (m && (!best || m.index < best.index)) best = { index: m.index, end: m.index + m[0].length };
  }
  return best;
}

/**
 * The text to show for a qualifying sentence. A long one is cut at the cap, which can hide the very
 * marker that qualified it (measured: a sentence kept for a "because" at character 230 printed only
 * its first 180, with no reason in it). A tail window starting mid-sentence was tried and read as a
 * fragment ("...so that half of the fix is v12 only."), so a sentence whose marker lies past the cap
 * is dropped.
 */
function fit(sentence: string, labelled: boolean): string | null {
  if (sentence.length <= REASON_MAX_CHARS || labelled) return cap(sentence);
  const m = firstMarker(sentence);
  return !m || m.end <= REASON_MAX_CHARS ? cap(sentence) : null;
}

/** Units are paragraphs and bullet items. Hard-wrapped lines of one unit are joined. */
function toUnits(text: string): Array<{ text: string; bullet: boolean }> {
  const units: Array<{ text: string; bullet: boolean }> = [];
  let cur: string[] = [];
  let curBullet = false;
  const flush = () => {
    if (cur.length) units.push({ text: cur.join(' '), bullet: curBullet });
    cur = [];
    curBullet = false;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*>+\s?/, '');
    if (!line.trim()) { flush(); continue; }
    if (/^\s*#{1,6}\s/.test(line) || /^\s*\|/.test(line) || /^\s*[-=*_|: ]{3,}\s*$/.test(line)) { flush(); continue; }
    if (TRAILER.test(line) || FIXES_ONLY.test(line)) { flush(); continue; }
    if (/^\s*(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/.test(line)) { flush(); continue; }
    if (BULLET.test(line)) { flush(); curBullet = true; cur.push(line.replace(BULLET, '')); continue; }
    cur.push(line.trim());
  }
  flush();
  return units;
}

const SENTENCE_SPLIT = /(?<=[.!?])(?<!\b(?:e\.g|i\.e|etc|vs|cf)\.)\s+(?=[A-Z0-9"'(`[])/;

export function extractReason(title: string, body: string | null | undefined): string | null {
  if (!body) return null;
  let text = stripImporterMetadata(body).slice(0, MAX_INPUT_CHARS);

  // The summary opens with its own title; the caller already prints it.
  const flatTitle = (title ?? '').replace(/\s+/g, ' ').trim();
  const trimmed = text.trimStart();
  const nl = trimmed.indexOf('\n');
  const firstLine = (nl < 0 ? trimmed : trimmed.slice(0, nl)).replace(/\s+/g, ' ').trim();
  if (flatTitle && firstLine === flatTitle) text = nl < 0 ? '' : trimmed.slice(nl);

  // Someone else's changes: bumps and release notes say what a dependency did, not why we took it.
  if (BUMP_BODY.test(text)) return null;
  const dump = DUMP_HEADING.exec(text);
  if (dump) text = text.slice(0, dump.index);

  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '\n').replace(/^\s*(```|~~~)[\s\S]*?(?:^\s*\1|$(?![\s\S]))/gm, '\n');

  const titleWords = words(flatTitle);
  const titleBodyWords = words(flatTitle.replace(CONVENTIONAL_PREFIX, ''));
  const scored: Array<{ pos: number; score: number; text: string }> = [];
  let pos = 0;
  for (const unit of toUnits(text)) {
    let t = stripMarkup(unit.text);
    let labelled = false;
    const label = LABEL.exec(t);
    if (label) { labelled = true; t = t.slice(label[0].length); }
    // A squashed sub-commit title (a "* " list item, or "fix(router): ...") says what changed. Only a strong marker makes it a reason.
    const conventional = CONVENTIONAL_PREFIX.test(t);
    if (conventional) t = t.replace(CONVENTIONAL_PREFIX, '');
    const subjectLike = conventional || unit.bullet;
    for (const sentence of t.split(SENTENCE_SPLIT)) {
      let s = sentence.trim();
      pos += 1;
      if (DANGLING_LINK.test(s)) continue;
      s = s.replace(/\s*\uE000\s*([.,;:!?])/g, '$1').replace(/\s*\uE000\s*/g, ' ').trim();
      if (words(s).length < MIN_WORDS || !isMostlyEnglish(s) || NOISE_SENTENCE.test(s) || repeatsTitle(s, titleWords, titleBodyWords)) continue;
      const sc = score(s, labelled);
      if (sc < 2 || (subjectLike && sc < 3)) continue;
      const shown = fit(s, labelled);
      if (shown) scored.push({ pos, score: sc, text: shown });
    }
  }
  if (!scored.length) return null;
  const picked = [...scored].sort((a, b) => b.score - a.score || a.pos - b.pos).slice(0, MAX_SENTENCES);
  return picked.sort((a, b) => a.pos - b.pos).map((p) => p.text).join(' ');
}

const COMMIT_SHA = /(?:\/commit\/|^git:\/\/commit\/)([0-9a-f]{7,40})(?:[/?#]|$)/;

/** The commit sha a commit-backed decision points at, from its source_url. Undefined for anything else. */
export function commitShaOf(sourceUrl: string | null | undefined): string | undefined {
  return sourceUrl ? COMMIT_SHA.exec(sourceUrl)?.[1] : undefined;
}

/**
 * Additive shaping for search results: each row gains `reason` (string, or an explicit null so an
 * agent can tell "no stated reason" from "not provided") and, with `sha`, the commit sha when the
 * row's source_url is a commit. No existing field is changed. Pure: the input is not mutated.
 */
export function withReasons<T extends { results?: unknown }>(payload: T, opts: { sha?: boolean } = {}): T {
  const rows = (payload as { results?: unknown })?.results;
  if (!Array.isArray(rows)) return payload;
  return {
    ...payload,
    results: rows.map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
      const r = row as Record<string, unknown>;
      const sha = opts.sha ? commitShaOf(typeof r['source_url'] === 'string' ? r['source_url'] : undefined) : undefined;
      return {
        ...r,
        ...(sha && !('sha' in r) ? { sha } : {}),
        reason: extractReason(String(r['title'] ?? ''), typeof r['summary'] === 'string' ? r['summary'] : null),
      };
    }),
  };
}
