/**
 * What `align local relink` will cost, before it calls anything (review F3).
 *
 * Priced only for a provider's DEFAULT model, from the list prices below (USD per million
 * tokens). Any other model, Ollama, or an unlisted provider reads "unknown price": a number we
 * cannot stand behind is worse than none. The output side uses the max_tokens ceiling, so the
 * figure is an upper bound on output, and the input side uses the CLI's own token estimator.
 */
import { type LlmProviderId, NAMED_PROVIDERS } from './llm-providers.js';

/** List prices, USD per million tokens, for the default models the CLI ships. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
};

export interface CostEstimate { usd: number | null; model?: string; note?: string }

export function costEstimate(inputTokens: number, maxOutputTokens: number, provider: LlmProviderId | undefined,
  env: Record<string, string | undefined> = process.env): CostEstimate {
  if (provider === 'ollama') return { usd: null, note: 'unknown price (Ollama runs locally)' };
  const named = NAMED_PROVIDERS.find((p) => p.id === provider);
  if (!named) return { usd: null, note: 'unknown price for this provider' };
  const override = named.modelEnv ? env[named.modelEnv] : undefined;
  if (override !== undefined && override.trim() !== '') return { usd: null, note: `unknown price for ${override}` };
  const price = PRICES[named.defaultModel];
  if (!price) return { usd: null, note: `unknown price for ${named.defaultModel}` };
  return { usd: (inputTokens * price.input + maxOutputTokens * price.output) / 1_000_000, model: named.defaultModel };
}
