/**
 * Reduce a natural-language question to its content words, for use as a SECOND
 * retrieval attempt when the raw query matched nothing.
 *
 * Deliberately NOT a replacement for the raw query. ALI-105 removed the old
 * `normaliseWhyQuery()` because normalising BEFORE the cloud gateway defeated its
 * strategy selector, which routes on the shape of the query. That decision stands:
 * the raw query is still what gets embedded first, in both modes.
 *
 * What this exists for is the LOCAL path, which has no strategy selector. There the
 * raw string is embedded and compared against a flat floor, so the scaffolding of a
 * question ("why do we ...") dilutes the vector: measured on a fresh git-seeded graph,
 * `postgres` scored 0.44 against a decision that `why do we use postgres` could not
 * clear 0.25 to reach. Falling back to the content words recovers that without
 * lowering the floor, which is pinned to the gateway's own so local and cloud answer
 * the same question at the same bar.
 *
 * Returns null when there is nothing to strip, or when only scaffolding remains -
 * both mean a second embedding would be wasted.
 */
const SCAFFOLDING = new Set([
  // interrogatives
  'why', 'how', 'what', 'when', 'where', 'who', 'whom', 'whose', 'which',
  // auxiliaries and copulas
  'do', 'does', 'did', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'can', 'should', 'would',
  // first and second person, which a user asking about their own repo always supplies
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'they', 'their',
  // determiners and common prepositions
  'a', 'an', 'the', 'of', 'to', 'for', 'on', 'in', 'at', 'about', 'and', 'or',
  'that', 'this', 'it', 'its', 'there',
]);

export function contentWordQuery(query: string): string | null {
  const tokens = query.toLowerCase().replace(/[?]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = tokens.filter(t => !SCAFFOLDING.has(t));
  if (!kept.length) return null;
  const reduced = kept.join(' ');
  return reduced === tokens.join(' ') ? null : reduced;
}
