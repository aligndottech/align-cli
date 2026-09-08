// ALI-845 Phase 0: no token-estimation helper existed anywhere in the CLI, so every
// prompt was assembled by concatenating decision text with no cap. ALI-852 widens the
// single flat ratio Phase 0 shipped into a per-family table: newer Anthropic tokenizers
// (4.7+) and gpt-4o-mini measure differently from older Anthropic models, and using one
// ratio for all of them either wastes budget or silently under-counts.

/**
 * Chars per token, measured (2026-09-03 research doc) with Anthropic's count_tokens against a
 * rendered decision corpus: 2.56 on 4.7+ models, 3.43 on older ones; gpt-4o-mini's own
 * tokenizer measures at 4.0. Longest-prefix matched against the model string, the same way
 * context-budget.ts matches its window table - a dated id (claude-haiku-4-5-20251001) must
 * still match the undated prefix.
 *
 * Values are copied from align-stack's `contextBudget.ts` (ALI-850), which is the one that
 * measured them. No Gemini/Groq/Mistral/Grok rows exist here - unlike the window table,
 * there is no live "count my tokens" endpoint for those providers to verify against, so an
 * unknown model (including all four of those) falls to FALLBACK_CHARS_PER_TOKEN, which is
 * deliberately the SMALLEST ratio in the table - it estimates MORE tokens per char, so an
 * unmeasured model is over-estimated (safe) rather than under-estimated (silently overflows).
 * Never chars/4: that under-counts our corpus by ~36%, and the under-count is silent.
 */
export const CHARS_PER_TOKEN: Record<string, number> = {
  'claude-opus-5': 2.56,
  'claude-sonnet-5': 2.56,
  'claude-opus-4-8': 2.56,
  'claude-opus-4-7': 2.56,
  'claude-opus-4-6': 3.43,
  'claude-sonnet-4-6': 3.43,
  'claude-haiku-4-5': 3.43,
  'gpt-4o-mini': 4.0,
};

/** The smallest ratio in the table, computed rather than written - see the comment above:
 *  a smaller ratio estimates MORE tokens per char, which is the conservative direction. */
export const FALLBACK_CHARS_PER_TOKEN = Math.min(...Object.values(CHARS_PER_TOKEN));

export const ESTIMATE_MARGIN = 1.1;

function ratioFor(model: string | undefined): number {
  if (!model) return FALLBACK_CHARS_PER_TOKEN;
  let bestKey: string | undefined;
  for (const key of Object.keys(CHARS_PER_TOKEN)) {
    if (model.startsWith(key) && (bestKey === undefined || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey === undefined ? FALLBACK_CHARS_PER_TOKEN : CHARS_PER_TOKEN[bestKey]!;
}

/** Conservative token estimate for a string: rounds UP, and adds a 10% margin on top.
 *  `model` is optional - omitting it (or passing an unrecognised model) uses the same
 *  conservative fallback ratio Phase 0 shipped, so every existing call site keeps
 *  compiling and keeps today's behaviour exactly. */
export function estimateTokens(text: string, model?: string): number {
  return Math.ceil((text.length / ratioFor(model)) * ESTIMATE_MARGIN);
}

/**
 * The char budget that fits `tokens`, inverse of estimateTokens. Rounds DOWN, so a caller
 * that slices text to `charsForTokens(n)` characters never re-estimates above `n`.
 */
export function charsForTokens(tokens: number, model?: string): number {
  return Math.floor((tokens * ratioFor(model)) / ESTIMATE_MARGIN);
}
