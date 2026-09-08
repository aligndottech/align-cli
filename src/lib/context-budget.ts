// ALI-852: each hosted provider rung gets its own real context window, replacing the Phase 0
// (ALI-845) `HOSTED_WINDOW_TOKENS_DEFAULT = 100_000` placeholder every rung shared.
//
// A leaf module: `local-llm.ts`, `local-relationship-classifier.ts` and
// `local-gateway-client.ts` import this; this imports nothing from any of them (and nothing
// from `config.ts` either - the 24h cache is threaded in structurally via `WindowCacheStore`
// rather than by importing `createConfigStore`'s concrete type, so a caller can pass a plain
// object in tests with no `conf` involved at all). One direction, no cycle.
//
// The window table only carries VALUES VERIFIED against a live provider API (Task 1 of
// align-stack's thoughts/shared/plans/2026-09-08-ali-852-cli-context-budget-resolver.md).
// Anthropic and OpenAI were verified live against the Models API on 2026-09-06 (recorded in
// align-stack's services/brain/app/context_budget.py, whose comment this table's two rows are
// copied from). Gemini, Groq, Mistral and Grok could NOT be live-verified in this environment
// - no GROQ_API_KEY / MISTRAL_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY was available - so
// their table stays EMPTY rather than carrying a guessed row (a missing row is honest and
// over-slices; a guessed row that is too high overflows and 400s). They fall through to
// UNVERIFIED_GROUP_FALLBACK, which is the ticket's OWN stated conservative fallback number for
// that group, not a measurement. A future session with those keys should verify and promote
// rows directly into WINDOWS - never edit the fallback literal to look like a measured value.

export type BudgetProvider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'groq'
  | 'mistral'
  | 'grok'
  | 'ollama'
  | 'custom';

export type WindowSource = 'env' | 'models_api' | 'cache' | 'table' | 'fallback';

export interface ModelWindow {
  maxInputTokens: number;
  maxOutputTokens: number;
  source: WindowSource;
}

export interface Budget {
  promptTokens: number;
  reservedOutput: number;
}

interface CachedWindow {
  maxInputTokens: number;
  maxOutputTokens: number;
  resolvedAt: number;
}

/** Structural, not `config.ts`'s concrete return type - a test can pass a plain in-memory
 *  object with no `conf`/filesystem involved. `config.ts`'s real store satisfies this once it
 *  grows the two methods (Task 3). */
export interface WindowCacheStore {
  getResolvedWindow(key: string): CachedWindow | undefined;
  setResolvedWindow(key: string, value: CachedWindow): void;
}

export interface ResolveWindowOpts {
  /** Required for the Anthropic live lookup; absent means "table/fallback only" for that rung. */
  apiKey?: string;
  /** Injected clock, defaulting to Date.now - so the 24h TTL is tested by moving a number,
   *  never by waiting 24 real hours. */
  now?: () => number;
  /** The 24h disk cache. Omit to resolve fresh every call (no caching). */
  store?: WindowCacheStore;
  /** Where a non-silent branch logs. Defaults to console.error, matching every other
   *  diagnostic in this codebase (resolveOllamaWindow, resolveLlmTimeoutMs, resolveMaxTokens). */
  warn?: (message: string) => void;
}

/** Never hand out the last 5% of a window - matches align-stack's contextBudget.ts. */
export const SAFETY_MARGIN = 0.95;

/**
 * Floor used when Ollama's real window cannot be resolved. MOVED here from `local-llm.ts`
 * (ALI-852) so this module needs no import from it; `local-llm.ts` re-exports this constant so
 * its public surface is unchanged (refactoring.md - "the re-export facade preserves the public
 * surface").
 */
export const OLLAMA_CONTEXT_FLOOR = 4_096;

/** The ticket's own conservative window for an arbitrary OpenAI-compatible custom endpoint -
 *  there is no table to verify against for "some local llama.cpp server". */
export const CUSTOM_FALLBACK_WINDOW = 32_000;

const WINDOW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * provider -> model prefix -> [maxInput, maxOutput]. Longest-prefix matched: the chain sends
 * dated ids (claude-haiku-4-5-20251001) that an exact match would miss. Every row here is a
 * value verified against the provider's own API - see the file header for which providers
 * that covers and which it does not.
 */
export const WINDOWS: Record<BudgetProvider, Record<string, readonly [number, number]>> = {
  anthropic: {
    'claude-opus-5': [1_000_000, 128_000],
    'claude-sonnet-5': [1_000_000, 128_000],
    'claude-sonnet-4-6': [1_000_000, 128_000],
    'claude-haiku-4-5': [200_000, 64_000],
  },
  openai: {
    'gpt-4o-mini': [128_000, 16_384],
  },
  // Not live-verified in this environment. See the file header.
  gemini: {},
  groq: {},
  mistral: {},
  grok: {},
  // Not table-driven at all - ollama resolves its real window via /api/show
  // (local-llm.ts's resolveOllamaWindow) and custom has no table to check against.
  ollama: {},
  custom: {},
};

/**
 * The ticket's own conservative fallback for the "unverified hosted provider" group - not a
 * measurement of any specific model. Smaller than every verified row above on purpose:
 * guessing high overflows the window and 400s the call, guessing low only over-slices.
 */
const UNVERIFIED_GROUP_FALLBACK: readonly [number, number] = [128_000, 8_192];

function minWindowOf(table: Record<string, readonly [number, number]>): readonly [number, number] | undefined {
  const entries = Object.values(table);
  if (!entries.length) return undefined;
  let best = entries[0]!;
  for (const entry of entries) {
    if (entry[0] < best[0]) best = entry;
  }
  return best;
}

/**
 * Each provider's fallback is the minimum of ITS OWN table, computed rather than written, so a
 * new row smaller than every existing one lowers the fallback automatically - a hand-written
 * literal sitting beside a table whose smallest entry is smaller is exactly the two-writers-
 * of-one-fact shape (code-style.md), and it fails in the overflow direction.
 *
 * `ollama` and `custom` are never in the table at all - there is nothing to compute a minimum
 * FROM - and keep their own literal. `gemini`/`groq`/`mistral`/`grok` fall to
 * UNVERIFIED_GROUP_FALLBACK for the same reason their table is empty (see file header).
 */
function fallbackFor(provider: BudgetProvider): readonly [number, number] {
  const computed = minWindowOf(WINDOWS[provider]);
  if (computed) return computed;
  if (provider === 'ollama') return [OLLAMA_CONTEXT_FLOOR, OLLAMA_CONTEXT_FLOOR];
  if (provider === 'custom') return [CUSTOM_FALLBACK_WINDOW, CUSTOM_FALLBACK_WINDOW];
  return UNVERIFIED_GROUP_FALLBACK;
}

/** Longest matching prefix key in `table` for `model`, or undefined if none matches. */
export function longestPrefixMatch<T>(table: Record<string, T>, model: string): T | undefined {
  let bestKey: string | undefined;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && (bestKey === undefined || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey === undefined ? undefined : table[bestKey];
}

/** `ALIGN_<PROVIDER>_CONTEXT_TOKENS` for a named provider; the custom rung keeps the ticket's
 *  own name beside its existing ALIGN_LLM_BASE_URL/ALIGN_LLM_MODEL/ALIGN_LLM_API_KEY trio. */
export function envOverrideKey(provider: BudgetProvider): string {
  if (provider === 'custom') return 'ALIGN_LLM_CONTEXT_TOKENS';
  return `ALIGN_${provider.toUpperCase()}_CONTEXT_TOKENS`;
}

function parsePositiveInt(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function fetchAnthropicWindow(model: string, apiKey: string): Promise<readonly [number, number] | undefined> {
  try {
    const res = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      // Discovery, not generation - the same 2s budget resolveOllamaWindow's /api/show probe
      // and the /api/tags probe already use, and for the same reason: a small GET that either
      // answers immediately or is not going to help, sitting before the chat call the user is
      // actually waiting on.
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { max_input_tokens?: unknown; max_output_tokens?: unknown };
    if (typeof data.max_input_tokens !== 'number' || typeof data.max_output_tokens !== 'number') return undefined;
    return [data.max_input_tokens, data.max_output_tokens];
  } catch {
    return undefined;
  }
}

/**
 * Resolve a provider+model's real context window.
 *
 * Precedence: env override > (Anthropic only, with a key) cached-or-live Models API >
 * table > the provider's computed fallback. Every non-table, non-env answer logs at
 * `opts.warn` (default console.error) saying which branch answered and why - never silent.
 *
 * Never throws on the request path: a rejected or timed-out Models API call falls through to
 * the table/fallback exactly like no key being configured at all. Only `splitBudget` throws,
 * deliberately, on a genuinely unusable window.
 */
export async function resolveWindow(
  provider: BudgetProvider,
  model: string,
  opts: ResolveWindowOpts = {},
): Promise<ModelWindow> {
  const warn = opts.warn ?? ((message: string) => console.error(message));
  const now = opts.now ?? Date.now;

  const envKey = envOverrideKey(provider);
  const rawEnv = process.env[envKey];
  if (rawEnv !== undefined && rawEnv.trim() !== '') {
    const parsed = parsePositiveInt(rawEnv);
    if (parsed !== undefined) {
      return { maxInputTokens: parsed, maxOutputTokens: parsed, source: 'env' };
    }
    warn(
      `align: ignoring ${envKey}=${JSON.stringify(rawEnv)} - it must be a positive number of ` +
      `tokens. Note this override applies to every ${provider} model equally - falling through ` +
      `to the table/fallback for ${model}.`,
    );
  }

  if (provider === 'anthropic' && opts.apiKey) {
    const cacheKey = `${provider}:${model}`;
    if (opts.store) {
      const cached = opts.store.getResolvedWindow(cacheKey);
      // A resolvedAt in the future (a clock that jumped backwards, or a hand-edited config)
      // is treated as expired, not as fresh forever.
      if (cached && cached.resolvedAt <= now() && now() - cached.resolvedAt < WINDOW_CACHE_TTL_MS) {
        return { maxInputTokens: cached.maxInputTokens, maxOutputTokens: cached.maxOutputTokens, source: 'cache' };
      }
    }
    const live = await fetchAnthropicWindow(model, opts.apiKey);
    if (live) {
      const [maxInputTokens, maxOutputTokens] = live;
      if (opts.store) {
        opts.store.setResolvedWindow(cacheKey, { maxInputTokens, maxOutputTokens, resolvedAt: now() });
      }
      return { maxInputTokens, maxOutputTokens, source: 'models_api' };
    }
    warn(`align: the Anthropic Models API lookup for ${model} did not answer - falling back to the table.`);
  }

  const tableHit = longestPrefixMatch(WINDOWS[provider], model);
  if (tableHit) {
    return { maxInputTokens: tableHit[0], maxOutputTokens: tableHit[1], source: 'table' };
  }

  const [maxInputTokens, maxOutputTokens] = fallbackFor(provider);
  warn(
    `align: no known context window for ${provider} model ${model} - using the conservative ` +
    `fallback of ${maxInputTokens} input / ${maxOutputTokens} output tokens.`,
  );
  return { maxInputTokens, maxOutputTokens, source: 'fallback' };
}

/**
 * Split a resolved window into what the prompt may use vs. what is reserved for the model's
 * answer. Throws on a non-positive prompt budget - a silently zero or negative prompt budget
 * looks like an empty prompt, not a misconfiguration (the one deliberate exception to "never
 * throw", matching align-stack's `splitBudget`).
 */
export function splitBudget(window: ModelWindow, reservedOutput: number): Budget {
  const promptTokens = Math.floor(window.maxInputTokens * SAFETY_MARGIN) - reservedOutput;
  if (promptTokens <= 0) {
    throw new Error(
      `splitBudget: a ${window.maxInputTokens}-token window (source: ${window.source}) cannot ` +
      `fit a ${reservedOutput}-token output reservation - nothing would be left for the prompt.`,
    );
  }
  return { promptTokens, reservedOutput };
}
