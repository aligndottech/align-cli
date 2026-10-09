/**
 * The providers `align ask` can write answers with, as data: their ids, labels, the env vars
 * that carry their keys and models, and which ones a user can save a key for. Shared by the
 * config store (hydration), local-llm.ts (preference) and the `align ai` / first-ask prompts,
 * so there is one list rather than three that drift. Dependency-free on purpose: config.ts
 * imports it on every command.
 */

/** Every id `ALIGN_LLM_PROVIDER` / `align ai --provider` accepts. */
export const LLM_PROVIDER_IDS = [
  'anthropic', 'openai', 'openrouter', 'gemini', 'groq', 'mistral', 'grok', 'custom', 'ollama',
] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

/** The providers a key can be saved for, in the order the key prompt lists them. */
export const STORABLE_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'gemini', 'groq', 'mistral', 'grok'] as const;
export type StoredProviderId = (typeof STORABLE_PROVIDERS)[number];

export const PROVIDER_LABEL: Record<LlmProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  groq: 'Groq',
  mistral: 'Mistral',
  grok: 'xAI',
  custom: 'Custom endpoint',
  ollama: 'Ollama',
};

/** Where to get a key, shown beside the paste prompt. */
export const PROVIDER_KEY_URL: Record<StoredProviderId, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/keys',
  gemini: 'https://aistudio.google.com/apikey',
  groq: 'https://console.groq.com/keys',
  mistral: 'https://console.mistral.ai/api-keys',
  grok: 'https://console.x.ai',
};

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';

/**
 * For each named provider: the env var a saved key is hydrated into (the first entry), and
 * every alias local-llm.ts's keyForProvider also reads. A real value under ANY alias wins
 * over a saved key. OpenRouter has none here: it rides the ALIGN_LLM_BASE_URL slot.
 * In the chain's own order (Groq before Gemini), so a listing reads the way the chain runs.
 */
export const KEY_ENV_VARS: Record<Exclude<StoredProviderId, 'openrouter'>, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  grok: ['XAI_API_KEY', 'GROK_API_KEY'],
};

/** The env var each provider's model override is read from (see local-llm.ts). */
export const MODEL_ENV_VAR: Record<LlmProviderId, string> = {
  anthropic: 'ALIGN_ANTHROPIC_MODEL',
  openai: 'ALIGN_OPENAI_MODEL',
  openrouter: 'ALIGN_LLM_MODEL',
  gemini: 'ALIGN_GEMINI_MODEL',
  groq: 'ALIGN_GROQ_MODEL',
  mistral: 'ALIGN_MISTRAL_MODEL',
  grok: 'ALIGN_GROK_MODEL',
  custom: 'ALIGN_LLM_MODEL',
  ollama: 'ALIGN_OLLAMA_MODEL',
};

const ALIASES: Record<string, LlmProviderId> = { xai: 'grok' };

/** A user-typed provider id, normalised, or null when it names nothing we support. */
export function parseProviderId(raw: string): LlmProviderId | null {
  const id = raw.trim().toLowerCase();
  if (ALIASES[id]) return ALIASES[id];
  return (LLM_PROVIDER_IDS as readonly string[]).includes(id) ? (id as LlmProviderId) : null;
}
