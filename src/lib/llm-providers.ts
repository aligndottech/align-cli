/**
 * The providers `align ask` can write answers with, as data: their ids, labels, the env vars
 * that carry their keys and models, endpoints and default models, and which ones a user can
 * save a key for. Shared by local-llm.ts (resolution and preference), the config store, the
 * launcher (which must not leak these variables to an agent) and the `align ai` / first-ask
 * prompts, so there is one list rather than several that drift. Dependency-free on purpose.
 */

/** A provider reached with its own key from an env variable or a saved key. */
export interface NamedProvider {
  id: NamedProviderId;
  label: string;
  /** Every env var holding a key, read in order; a real value under ANY of them beats a saved key. */
  keyEnv: readonly string[];
  /** The env var that overrides the model. */
  modelEnv: string;
  defaultModel: string;
  /** Which request shape. 'openai' posts Chat Completions to `endpoint`. */
  api: 'anthropic' | 'gemini' | 'openai';
  /** Full Chat Completions URL, for api 'openai'. */
  endpoint?: string;
  /** Where to get a key, shown beside the paste prompt. */
  keyUrl: string;
}

export type NamedProviderId = 'anthropic' | 'openai' | 'groq' | 'gemini' | 'mistral' | 'grok';

/**
 * In the fixed fallback order (ALI-1284: Groq ahead of Gemini, so the free pairing has a real
 * primary). A provider is only ever tried when the user has a key for it.
 */
export const NAMED_PROVIDERS: readonly NamedProvider[] = [
  {
    id: 'anthropic', label: 'Anthropic', keyEnv: ['ANTHROPIC_API_KEY'], modelEnv: 'ALIGN_ANTHROPIC_MODEL',
    defaultModel: 'claude-haiku-4-5-20251001', api: 'anthropic', keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai', label: 'OpenAI', keyEnv: ['OPENAI_API_KEY'], modelEnv: 'ALIGN_OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini', api: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'groq', label: 'Groq', keyEnv: ['GROQ_API_KEY'], modelEnv: 'ALIGN_GROQ_MODEL',
    defaultModel: 'llama-3.1-8b-instant', api: 'openai', endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    // ALI-1284: a Flash-Lite model, which is what the free pairing is sold as. Override with
    // ALIGN_GEMINI_MODEL if Google retires it.
    id: 'gemini', label: 'Gemini', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], modelEnv: 'ALIGN_GEMINI_MODEL',
    defaultModel: 'gemini-2.5-flash-lite', api: 'gemini', keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'mistral', label: 'Mistral', keyEnv: ['MISTRAL_API_KEY'], modelEnv: 'ALIGN_MISTRAL_MODEL',
    defaultModel: 'mistral-small-latest', api: 'openai', endpoint: 'https://api.mistral.ai/v1/chat/completions',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'grok', label: 'xAI', keyEnv: ['GROK_API_KEY', 'XAI_API_KEY'], modelEnv: 'ALIGN_GROK_MODEL',
    defaultModel: 'grok-2-latest', api: 'openai', endpoint: 'https://api.x.ai/v1/chat/completions',
    keyUrl: 'https://console.x.ai',
  },
];

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';

/** Every id `ALIGN_LLM_PROVIDER` / `align ai --provider` accepts. */
export const LLM_PROVIDER_IDS = [
  ...NAMED_PROVIDERS.map((p) => p.id), 'openrouter', 'custom', 'ollama',
] as readonly LlmProviderId[];
export type LlmProviderId = NamedProviderId | 'openrouter' | 'custom' | 'ollama';

/**
 * The providers a key can be saved for, in the order the key prompt lists them: the original
 * seven first (OpenRouter third, as it always was), then the rest in table order.
 */
export const STORABLE_PROVIDERS: readonly StoredProviderId[] = [
  'anthropic', 'openai', 'openrouter', 'gemini', 'groq', 'mistral', 'grok',
  ...NAMED_PROVIDERS.map((p) => p.id).filter((id) => !['anthropic', 'openai', 'gemini', 'groq', 'mistral', 'grok'].includes(id)),
];
export type StoredProviderId = NamedProviderId | 'openrouter';

export function namedProvider(id: string): NamedProvider | undefined {
  return NAMED_PROVIDERS.find((p) => p.id === id);
}

export const PROVIDER_LABEL: Record<LlmProviderId, string> = {
  ...Object.fromEntries(NAMED_PROVIDERS.map((p) => [p.id, p.label])) as Record<NamedProviderId, string>,
  openrouter: 'OpenRouter',
  custom: 'Custom endpoint',
  ollama: 'Ollama',
};

/** Where to get a key, shown beside the paste prompt. */
export const PROVIDER_KEY_URL: Record<StoredProviderId, string> = {
  ...Object.fromEntries(NAMED_PROVIDERS.map((p) => [p.id, p.keyUrl])) as Record<NamedProviderId, string>,
  openrouter: 'https://openrouter.ai/keys',
};

/**
 * Every env variable that carries an align LLM credential, endpoint, model or preference. The
 * launcher resets each one to the value the user's shell had when align started, so nothing
 * align put into its own environment reaches a coding agent (a saved ANTHROPIC_API_KEY would
 * switch Claude Code from a Max subscription to API billing).
 */
export const PROVIDER_ENV_VARS: readonly string[] = [
  ...NAMED_PROVIDERS.flatMap((p) => [...p.keyEnv, p.modelEnv]),
  'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_MODEL', 'ALIGN_LLM_PROVIDER', 'ALIGN_OLLAMA_MODEL',
];

const ALIASES: Record<string, LlmProviderId> = { xai: 'grok' };

/** A user-typed provider id, normalised, or null when it names nothing we support. */
export function parseProviderId(raw: string): LlmProviderId | null {
  const id = raw.trim().toLowerCase();
  if (ALIASES[id]) return ALIASES[id];
  return (LLM_PROVIDER_IDS as readonly string[]).includes(id) ? (id as LlmProviderId) : null;
}
