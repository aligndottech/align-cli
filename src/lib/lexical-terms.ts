import { SCAFFOLDING } from './search-query.js';

/**
 * Terms for the lexical half of local search. Pure, no I/O.
 *
 * Why a lexical ranking exists: a dense embedding of a whole commit message blurs a rare identifier
 * ("find-my-way", "pino", "node18") into the surrounding prose, so the one commit that names it can sit
 * far down the dense order. A lexical score does the opposite: a rare term that appears in a document is
 * worth a lot, and a common one is worth nothing.
 *
 * Tokens are identifier-aware: `find-my-way` yields `find-my-way`, `find`, `my`, `way`; `getUserName`
 * yields `getusername`, `get`, `user`, `name`; `lib/route.js` yields `lib/route.js`, `lib`, `route`, `js`;
 * `node18` yields `node18`, `node`, `18`. The whole identifier stays a token so a query that quotes it
 * matches exactly, and the parts let a plain question ("why do we use find my way") still find it.
 */

/** A term in the title counts this many times in the document, so a title hit outweighs a body hit. */
export const TITLE_TERM_WEIGHT = 3;

const STOP = new Set([...SCAFFOLDING, 'we', 'with', 'from', 'by', 'as', 'not', 'no', 'but', 'if', 'so', 'than', 'then', 'into', 'out', 'up', 'all', 'any', 'has', 'have', 'had', 'will', 'also', 'use', 'used', 'using']);

/**
 * One deterministic light stemmer, used for the index AND the query, so the two cannot disagree: plural,
 * then -ed/-ing, then a final -e. "process" and "processes" meet, and so do "remove", "removed", "removes"
 * and "removing". Not a linguistic stemmer: it only has to give both sides the same answer.
 */
export function stem(token: string): string {
  let t = token.toLowerCase();
  if (t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) t = `${t.slice(0, -3)}y`;
  else if (/(ss|x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2);
  else if (t.endsWith('s') && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
  if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  if (/([^aeiou\d])\1$/.test(t) && !/(ss|ll|zz)$/.test(t)) t = t.slice(0, -1);
  if (t.length > 4 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

/** Split an identifier-ish chunk into its parts: camelCase, snake_case, digits against letters. */
function parts(chunk: string): string[] {
  return chunk
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The tokens of a text, lowercased and stemmed, with each identifier kept whole AND in parts. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const chunk = raw.replace(/^[^\p{L}\p{N}@]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
    if (!chunk) continue;
    const whole = chunk.toLowerCase();
    const pieces = parts(chunk).map(p => p.toLowerCase());
    // The whole token is kept only when it is a compound (it has a separator or a case/digit
    // boundary); a plain word would otherwise count twice, once whole and once as its own part.
    const compound = pieces.length > 1 || /[^\p{L}\p{N}]/u.test(chunk);
    if (compound) out.push(whole);
    for (const piece of pieces) if (!STOP.has(piece) && piece.length > 1) out.push(stem(piece));
  }
  return out;
}

/** Term frequencies of one document: a title term counts TITLE_TERM_WEIGHT times, a body term once. */
export function termCounts(title: string, body: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokenize(title)) counts.set(t, (counts.get(t) ?? 0) + TITLE_TERM_WEIGHT);
  for (const t of tokenize(body)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

/** Query terms with weight 1 each (a repeated word counts once). */
export function queryTerms(query: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokenize(query)) out.set(t, 1);
  return out;
}
