// A code edit and a decision's prose embed far apart, so the edit hook also asks retrieval a second
// question made only of the words the edit and its path already contain. No model, no network, and
// no table mapping a host or package to a concept: a name nobody has heard of passes through as is.

const MAX_TOKENS = 40;
const MIN_TOKEN_CHARS = 3;
const MAX_TOKEN_CHARS = 24;
// Fewer real words than this from the edit's own text is not enough to ask a second question with.
const MIN_TEXT_TOKENS = 3;
// Path segments kept, counted from the file name. Claude sends an absolute path, whose leading
// segments are a username, a workspace and a repo name, none of which describe the edit. Two is the
// most that stays clear of a repo name under a short path; the home directory is stripped separately.
const PATH_SEGMENTS = 2;
// Longest run of consonants a real word has, plus one. English tops out at 5 ("strengths"), and
// compounds such as "httpclient" reach 6.
const MAX_CONSONANT_RUN = 7;

// Grammar, not meaning: keywords, scheme and extension noise, and the type and result words every
// language has. Kept small and shared across languages on purpose, and it names no concept: every
// entry added is a word the line can no longer carry. The type and result words are here because
// "string", "result" and "json" scored as much of a Rust edit's line as its subject did.
const STOP = new Set(
  ('const let var fn pub use mod impl struct class def function return import export from async await new ' +
    'if else true false null rs ts js py com www http https ' +
    'enum trait for while match mut ref self super crate type interface extends implements static void undefined ' +
    'of this that the and not are try catch throw throws finally switch case break continue public private protected ' +
    'diff git index mode deleted binary files differ final override default string number boolean any ok err some none result json org net').split(' '),
);

const NON_SOURCE_EXT = /\.(?:md|mdx|txt|rst|lock|css|scss|svg)$/i;
const NON_SOURCE_NAME = /^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|uv\.lock|poetry\.lock|go\.sum|\.gitignore|changelog(?:\.(?:md|mdx|txt|rst))?|licen[cs]e(?:\.(?:md|txt|rst))?|licen[cs]e-(?:mit|apache|bsd|gpl|lgpl|mpl|isc|unlicense))$/i;

// The edits that matched process decisions in measurement (a README typo, a lockfile bump, a
// changelog entry) carry no intent a code decision could apply to, so they get no second query.
function isNonSource(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  if (norm.split('/').includes('node_modules')) return true;
  const name = norm.slice(norm.lastIndexOf('/') + 1);
  return NON_SOURCE_EXT.test(name) || NON_SOURCE_NAME.test(name);
}

// A token a person could have typed: Latin letters only (words in other scripts are not split, so an edit
// written only in them gets no second query), no run of seven consonants, and a vowel once it is long
// enough to need one (so xml, sql, html and grpc pass). Accents are ignored for the vowel test. 'y'
// counts as a vowel so 'rhythm' and 'crypt' pass.
const plain = (w: string): string => w.normalize('NFD').replace(/\p{M}/gu, '');
const looksLikeWord = (w: string): boolean => {
  if (w.length > MAX_TOKEN_CHARS || !/^\p{Script=Latin}+$/u.test(w)) return false;
  const p = plain(w);
  return (p.length < 5 || /[aeiouy]/.test(p)) && !new RegExp(`[^aeiouy]{${MAX_CONSONANT_RUN},}`).test(p);
};

// Hashes and base64 blobs, removed before splitting so their letters never become words. A blob is 24+
// base64 characters with upper case, lower case and a digit. No '/', '_' or '-': paths, constants and
// kebab names carry those, and they are what the import and constant words come from.
const BLOB = /[A-Za-z0-9+=]{24,}/g;
const isBlob = (m: string): boolean => /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m);
const stripBlobs = (raw: string): string => raw.replace(/\b[0-9a-f]{7,}\b/gi, ' ').replace(BLOB, (m) => (isBlob(m) ? ' ' : m));

// A drive letter and a home directory name the machine's owner, not the edit.
const tail = (filePath: string): string => {
  const segs = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (/^[A-Za-z]:$/.test(segs[0] ?? '')) segs.shift();
  if (/^(?:home|users)$/i.test(segs[0] ?? '')) segs.splice(0, 2);
  return segs.slice(-PATH_SEGMENTS).join('/');
};

const words = (raw: string): string[] =>
  raw
    .replace(/([\p{Ll}0-9])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

export function intentLine({ filePath, text }: { filePath?: string; text: string }): string {
  if (filePath && isNonSource(filePath)) return '';
  const out: string[] = [];
  const seen = new Set<string>();
  const textWords = new Set<string>();
  const add = (parts: string[], fromText: boolean): void => {
    for (const w of parts) {
      if (w.length < MIN_TOKEN_CHARS || STOP.has(w) || !looksLikeWord(w)) continue;
      // Counted before the path dedup, so a word the path also holds still shows the edit says something.
      if (fromText) textWords.add(w);
      if (out.length >= MAX_TOKENS || seen.has(w)) continue;
      seen.add(w);
      out.push(w);
    }
  };
  add(words(tail(filePath ?? '')), false);
  text = stripBlobs(text);
  // What the code depends on and talks to comes before the rest of its words, so the cap cuts the long tail.
  const targets = [...text.matchAll(/(?:require\(\s*|\bfrom\s+|\bimport\s+|\buse\s+|extern crate\s+)["']?([@\w:./-]+)/g)].map((m) => m[1]!);
  add(targets.flatMap(words), true);
  const hosts = [...text.matchAll(/https?:\/\/([^\s"'`)]+)/g)].map((m) => m[1]!);
  add(hosts.flatMap(words), true);
  add(words(text), true);
  // Counted on the text alone: a path with no words in the edit asks retrieval about a file name.
  return textWords.size < MIN_TEXT_TOKENS ? '' : out.join(' ');
}

type Scored = { decisionId: string; score: number };

/** One row per decision with the larger of its two scores, best first, ties by id code unit. */
export function maxScorePerDecision(a: Scored[], b: Scored[]): Scored[] {
  const best = new Map<string, number>();
  for (const { decisionId, score } of [...a, ...b]) {
    const prior = best.get(decisionId);
    if (prior === undefined || score > prior) best.set(decisionId, score);
  }
  return [...best].map(([decisionId, score]) => ({ decisionId, score }))
    .sort((x, y) => y.score - x.score || (x.decisionId < y.decisionId ? -1 : x.decisionId > y.decisionId ? 1 : 0));
}
