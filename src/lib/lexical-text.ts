/**
 * What text of a git decision the lexical index reads.
 *
 * A git decision's stored summary is `formatCommitAsText`: subject, body, then `Author:`, `Date:`,
 * `Files changed:` and `URL:` blocks. The reason a commit exists lives in the first lines of the body, so
 * the index reads the start of that body, with trailers and metadata dropped. The stored summary and the
 * embedding text are never changed, only what the lexical index derives from them.
 *
 * Pure.
 */

/** How much of the cleaned body the index reads. Measured on eval v2: 500, 1000 and 2000 chars
 *  scored the same (recall@8 95.7%) and none at all scored 79.9%, so the body matters and its length does
 *  not; 500 keeps the persisted index small. */
export const INDEX_BODY_CHARS = 500;

const TRAILER_LINE = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|helped-by|cc|refs?|closes?|fixes?|resolves?)\s*:\s*\S/i;
const GENERATED_WITH = /^(?:🤖\s*)?generated (with|by)\b/i;

/** The prose of a git decision's body: no subject echo, no trailers, no Author/Date/Files/URL block. */
export function commitBodyOf(title: string, summary: string): string {
  const metaAt = summary.lastIndexOf('\n\nAuthor: ');
  let text = metaAt === -1 ? summary : summary.slice(0, metaAt);
  if (text.startsWith(title)) text = text.slice(title.length);
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !TRAILER_LINE.test(l) && !GENERATED_WITH.test(l) && l !== '---------')
    .join(' ');
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return space > max * 0.6 ? cut.slice(0, space) : cut;
}

/** The body the lexical index reads for a git decision. */
export function indexBodyFor(title: string, summary: string): string {
  return clip(commitBodyOf(title, summary), INDEX_BODY_CHARS);
}
