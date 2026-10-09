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
  /** Which request shape. 'openai' posts Chat Completions to `endpoint`; 'anthropic' posts
   *  Messages to `endpoint` (default Anthropic's own). */
  api: 'anthropic' | 'gemini' | 'openai';
  /** The full request URL. Required for 'openai'. */
  endpoint?: string;
  /**
   * Use a key exported under keyEnv with no further say-so. True for the original six only.
   * Every later provider's variables are commonly exported for OTHER tools (HF_TOKEN for model
   * downloads, NVIDIA_API_KEY for NGC), so an exported key alone only makes the provider
   * AVAILABLE: align uses it once the user saves a key for it or chooses it (`align ai`,
   * ALIGN_LLM_PROVIDER). Otherwise their decision text would go to a provider they never picked.
   */
  autoFromEnv?: true;
  /** Where to get a key, shown beside the paste prompt. */
  keyUrl: string;
}

export type NamedProviderId =
  | 'anthropic' | 'openai' | 'groq' | 'gemini' | 'mistral' | 'grok'
  | 'deepseek' | 'zai' | 'moonshotai' | 'cerebras' | 'fireworks' | 'together' | 'nvidia'
  | 'huggingface' | 'baseten' | 'xiaomi' | 'qwen' | 'qwen-token-plan' | 'minimax' | 'kimi-coding' | 'vercel-ai-gateway';

/**
 * In the fixed fallback order (ALI-1284: Groq ahead of Gemini, so the free pairing has a real
 * primary). A provider is only ever tried when the user has a key for it.
 */
export const NAMED_PROVIDERS: readonly NamedProvider[] = [
  {
    autoFromEnv: true,
    id: 'anthropic', label: 'Anthropic', keyEnv: ['ANTHROPIC_API_KEY'], modelEnv: 'ALIGN_ANTHROPIC_MODEL',
    defaultModel: 'claude-haiku-4-5-20251001', api: 'anthropic', keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    autoFromEnv: true,
    id: 'openai', label: 'OpenAI', keyEnv: ['OPENAI_API_KEY'], modelEnv: 'ALIGN_OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini', api: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    autoFromEnv: true,
    id: 'groq', label: 'Groq', keyEnv: ['GROQ_API_KEY'], modelEnv: 'ALIGN_GROQ_MODEL',
    defaultModel: 'llama-3.1-8b-instant', api: 'openai', endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    // ALI-1284: a Flash-Lite model, which is what the free pairing is sold as. Override with
    // ALIGN_GEMINI_MODEL if Google retires it.
    autoFromEnv: true,
    id: 'gemini', label: 'Gemini', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], modelEnv: 'ALIGN_GEMINI_MODEL',
    defaultModel: 'gemini-2.5-flash-lite', api: 'gemini', keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    autoFromEnv: true,
    id: 'mistral', label: 'Mistral', keyEnv: ['MISTRAL_API_KEY'], modelEnv: 'ALIGN_MISTRAL_MODEL',
    defaultModel: 'mistral-small-latest', api: 'openai', endpoint: 'https://api.mistral.ai/v1/chat/completions',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    autoFromEnv: true,
    id: 'grok', label: 'xAI', keyEnv: ['GROK_API_KEY', 'XAI_API_KEY'], modelEnv: 'ALIGN_GROK_MODEL',
    defaultModel: 'grok-2-latest', api: 'openai', endpoint: 'https://api.x.ai/v1/chat/completions',
    keyUrl: 'https://console.x.ai',
  },

  // ---- Appended after the original six, so they only run when the user has their key. ----
  // Source for every env var name, base URL, API shape and model id below, unless a comment
  // says otherwise: @earendil-works/pi-ai 0.87.1 (MIT), dist/env-api-keys.js and
  // dist/providers/data/<id>.json. Default models are the cheapest current id that table lists
  // for the provider, preferring a non-reasoning model where one is cheap (a reasoning model
  // spends align's 1,024-token answer budget thinking).
  openAi('deepseek', 'DeepSeek', ['DEEPSEEK_API_KEY'], 'https://api.deepseek.com/chat/completions',
    'deepseek-flash', 'https://platform.deepseek.com/api_keys'),
  // pi-ai lists the GLM Coding Plan endpoint (/api/coding/paas/v4). This is Z.ai's GENERAL
  // endpoint, for an ordinary pay-as-you-go key - https://docs.z.ai/api-reference/introduction
  // says the coding endpoint is only for Coding Plan subscribers.
  openAi('zai', 'Z.ai (GLM)', ['ZAI_API_KEY'], 'https://api.z.ai/api/paas/v4/chat/completions',
    'glm-5.3-flash', 'https://z.ai/manage-apikey/apikey-list'),
  openAi('moonshotai', 'Moonshot (Kimi)', ['MOONSHOT_API_KEY'], 'https://api.moonshot.ai/v1/chat/completions',
    'kimi-k2.6', 'https://platform.moonshot.ai/console/api-keys'),
  openAi('cerebras', 'Cerebras', ['CEREBRAS_API_KEY'], 'https://api.cerebras.ai/v1/chat/completions',
    'gpt-oss-120b', 'https://cloud.cerebras.ai'),
  openAi('fireworks', 'Fireworks AI', ['FIREWORKS_API_KEY'], 'https://api.fireworks.ai/inference/v1/chat/completions',
    'accounts/fireworks/models/glm-5p3-flash', 'https://app.fireworks.ai/settings/users/api-keys'),
  openAi('together', 'Together AI', ['TOGETHER_API_KEY'], 'https://api.together.ai/v1/chat/completions',
    'Qwen/Qwen2.5-7B-Instruct-Turbo', 'https://api.together.ai/settings/api-keys'),
  openAi('nvidia', 'NVIDIA', ['NVIDIA_API_KEY'], 'https://integrate.api.nvidia.com/v1/chat/completions',
    'google/gemma-3-12b-it', 'https://build.nvidia.com'),
  openAi('huggingface', 'Hugging Face', ['HF_TOKEN'], 'https://router.huggingface.co/v1/chat/completions',
    'meta-llama/Llama-3.1-8B-Instruct', 'https://huggingface.co/settings/tokens'),
  openAi('baseten', 'Baseten', ['BASETEN_API_KEY'], 'https://inference.baseten.co/v1/chat/completions',
    'deepseek-ai/DeepSeek-V4-Flash-0731', 'https://app.baseten.co/settings/api_keys'),
  openAi('xiaomi', 'Xiaomi MiMo', ['XIAOMI_API_KEY'], 'https://api.xiaomimimo.com/v1/chat/completions',
    'mimo-v2.5', 'https://platform.xiaomimimo.com'),
  {
    // Alibaba Model Studio: an ordinary Model Studio key (what the paste prompt's console link
    // issues), at the international DashScope compatible-mode domain Alibaba documents as
    // still valid - https://www.alibabacloud.com/help/en/model-studio/base-url - with
    // qwen3.5-flash from https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions.
    id: 'qwen', label: 'Qwen (Alibaba Model Studio)', keyEnv: ['DASHSCOPE_API_KEY'], modelEnv: 'ALIGN_QWEN_MODEL',
    defaultModel: 'qwen3.5-flash', api: 'openai',
    endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    keyUrl: 'https://modelstudio.console.alibabacloud.com',
  },
  // The Alibaba Token Plan: a different product on a different host; a key for one is
  // rejected by the other. Env name, endpoint and model from pi-ai.
  openAi('qwen-token-plan', 'Qwen Token Plan', ['QWEN_TOKEN_PLAN_API_KEY'],
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    'qwen3.6-flash', 'https://modelstudio.console.alibabacloud.com'),
  // These three speak Anthropic Messages in pi-ai's table, so they reuse align's Anthropic
  // adapter at their own base URL (POST <base>/v1/messages). UNVERIFIED: that each accepts the
  // Anthropic-style `x-api-key` header rather than only a Bearer token - no live call was made.
  anthropicAt('minimax', 'MiniMax', ['MINIMAX_API_KEY'], 'https://api.minimax.io/anthropic/v1/messages',
    'MiniMax-M2.7', 'https://platform.minimax.io'),
  anthropicAt('kimi-coding', 'Kimi Coding Plan', ['KIMI_API_KEY'], 'https://api.kimi.com/coding/v1/messages',
    'kimi-for-coding', 'https://www.kimi.com/code'),
  anthropicAt('vercel-ai-gateway', 'Vercel AI Gateway', ['AI_GATEWAY_API_KEY'], 'https://ai-gateway.vercel.sh/v1/messages',
    'openai/gpt-4o-mini', 'https://vercel.com/dashboard/ai-gateway'),
  // Not included: cloudflare-workers-ai (needs CLOUDFLARE_ACCOUNT_ID in the URL) and Azure
  // OpenAI (a per-resource endpoint, deployment name and api-version) - neither fits a fixed
  // endpoint. Both work today through ALIGN_LLM_BASE_URL.
];

function modelEnvFor(id: string): string {
  return `ALIGN_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MODEL`;
}

function openAi(id: NamedProviderId, label: string, keyEnv: string[], endpoint: string, defaultModel: string, keyUrl: string): NamedProvider {
  return { id, label, keyEnv, modelEnv: modelEnvFor(id), defaultModel, api: 'openai', endpoint, keyUrl };
}

function anthropicAt(id: NamedProviderId, label: string, keyEnv: string[], endpoint: string, defaultModel: string, keyUrl: string): NamedProvider {
  return { id, label, keyEnv, modelEnv: modelEnvFor(id), defaultModel, api: 'anthropic', endpoint, keyUrl };
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';
/** OpenRouter's own key variable (pi-ai's name) and align's model override for it. */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';
export const OPENROUTER_MODEL_ENV = 'ALIGN_OPENROUTER_MODEL';

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
  OPENROUTER_KEY_ENV, OPENROUTER_MODEL_ENV,
];

const ALIASES: Record<string, LlmProviderId> = { xai: 'grok' };

/** A user-typed provider id, normalised, or null when it names nothing we support. */
export function parseProviderId(raw: string): LlmProviderId | null {
  const id = raw.trim().toLowerCase();
  if (ALIASES[id]) return ALIASES[id];
  return (LLM_PROVIDER_IDS as readonly string[]).includes(id) ? (id as LlmProviderId) : null;
}
