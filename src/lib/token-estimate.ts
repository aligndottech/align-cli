// ALI-845 Phase 0: no token-estimation helper existed anywhere in the CLI, so every
// prompt was assembled by concatenating decision text with no cap. This is the
// conservative estimator for that phase - a real per-family table is ALI-852's job.

/**
 * Chars per token, measured (2026-09-03 research doc) with Anthropic's count_tokens against a
 * rendered decision corpus: 2.56 on 4.7+ models, 3.43 on older ones. The SMALLER ratio is the
 * conservative one - it estimates MORE tokens per char - so Phase 0 uses it for every family.
 * Never chars/4: that under-counts our corpus by ~36% and the under-count is silent.
 * The per-family table is ALI-852.
 */
export const CHARS_PER_TOKEN = 2.56;
export const ESTIMATE_MARGIN = 1.1;

/** Conservative token estimate for a string: rounds UP, and adds a 10% margin on top. */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * ESTIMATE_MARGIN);
}

/**
 * The char budget that fits `tokens`, inverse of estimateTokens. Rounds DOWN, so a caller
 * that slices text to `charsForTokens(n)` characters never re-estimates above `n`.
 */
export function charsForTokens(tokens: number): number {
  return Math.floor((tokens * CHARS_PER_TOKEN) / ESTIMATE_MARGIN);
}
