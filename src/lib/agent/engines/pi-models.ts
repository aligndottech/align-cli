import { NAMED_PROVIDERS, namedProvider, type NamedProviderId } from '../../llm-providers.js';
import { preferredProvider, probeOllama as probeLocalOllama, type SavedLlmConfig } from '../../local-llm.js';

/**
 * Which model the Align engine runs, and the key to run it with. No Pi types here: the result is
 * plain data and pi.ts builds Pi's model from it.
 *
 * Keys come from what the user already gave Align (an exported variable, or a key saved with
 * `align ai`) and travel in-process only (H1): they are never put into process.env, so a child
 * process cannot inherit them.
 *
 * NEVER a subscription login. Anthropic's terms forbid a Claude subscription login in third-party
 * apps, and Pi's other OAuth providers (openai-codex, github-copilot, ...) are partner-only. Nothing
 * here, or in pi.ts, calls or offers Pi's login; an override naming one is refused.
 */
export interface ResolvedPiModel {
  /** Pi's provider id, which is not always Align's (Align says gemini and grok; Pi says google and xai). */
  provider: string;
  modelId: string;
  apiKey?: string;
  /** Set for Ollama only: its OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** Shown in the header, e.g. "Anthropic claude-sonnet-5-5". */
  label: string;
}

/**
 * The default coding-grade model per Align provider, read from Pi 1.5.0's catalogue (the test
 * asserts every entry exists there, so a Pi bump that drops one fails loudly).
 *  - anthropic: Sonnet 5.5, the model the engine was built and tried against.
 *  - openai: gpt-6.1-sol, the newest non-pro flagship, priced like Sonnet 5.5 ($2/$10 per Mtok).
 *  - gemini: gemini-3.1-pro-preview, the only Pro-tier model in the catalogue (the rest are Flash).
 *  - grok: grok-4.7, the newest Grok. groq: gpt-oss-120b, its largest tool-calling model.
 *  - mistral: mistral-large-4, the newest large model with reasoning. deepseek: deepseek-v4-pro.
 * Other Align providers (OpenRouter, a custom endpoint, the long tail) have no default: pick one
 * with ALIGN_AGENT_MODEL, because a guess at a model on a gateway we cannot enumerate is worse than asking.
 */
export const DEFAULT_PI_MODELS: Record<string, { provider: string; modelId: string }> = {
  anthropic: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' },
  openai: { provider: 'openai', modelId: 'gpt-6.1-sol' },
  gemini: { provider: 'google', modelId: 'gemini-3.1-pro-preview' },
  grok: { provider: 'xai', modelId: 'grok-4.7' },
  groq: { provider: 'groq', modelId: 'openai/gpt-oss-120b' },
  mistral: { provider: 'mistral', modelId: 'mistral-large-4' },
  deepseek: { provider: 'deepseek', modelId: 'deepseek-v4-pro' },
};

/** Pi providers that sign in with a subscription. Refused outright (see the header). */
const SUBSCRIPTION_PROVIDERS = new Set([
  'openai-codex', 'openai-chatgpt', 'github-copilot', 'google-gemini-cli', 'google-antigravity',
]);

export interface ResolvePiModelOptions {
  /** Keys saved by `align ai`. The caller reads them from the config store; they never touch process.env. */
  saved?: SavedLlmConfig;
  /** Injected so tests need no network. Returns the model a reachable Ollama would use, or null. */
  probeOllama?: () => Promise<string | null>;
}

const label = (alignId: string, modelId: string): string =>
  `${namedProvider(alignId)?.label ?? alignId} ${modelId}`;

/** The key for one Align provider: a saved key, or an exported one that Align is allowed to use. */
function keyFor(alignId: NamedProviderId, saved: SavedLlmConfig, preferred: string | undefined): string | undefined {
  const p = namedProvider(alignId);
  if (!p) return undefined;
  const exported = p.keyEnv.map((n) => process.env[n]).find(Boolean);
  const saveKey = saved.keys[alignId];
  // Same rule as local-llm's credentials(): an exported key beyond the original six may be there for
  // another tool, so it counts only when the user also saved one or chose the provider.
  if (exported && (p.autoFromEnv || preferred === alignId || saveKey)) return exported;
  return saveKey;
}

export async function resolvePiModel(opts: ResolvePiModelOptions = {}): Promise<ResolvedPiModel | undefined> {
  const saved = opts.saved ?? { keys: {} };
  const preferred = preferredProvider(saved);

  const override = process.env['ALIGN_AGENT_MODEL'];
  if (override) {
    const slash = override.indexOf('/');
    if (slash < 1 || slash === override.length - 1) {
      throw new Error(`ALIGN_AGENT_MODEL must be provider/model-id (for example anthropic/claude-sonnet-5-5), got "${override}".`);
    }
    const provider = override.slice(0, slash);
    const modelId = override.slice(slash + 1);
    if (SUBSCRIPTION_PROVIDERS.has(provider)) {
      throw new Error(`ALIGN_AGENT_MODEL names ${provider}, which signs in with a subscription. Align runs on API keys only: use a provider you have a key for.`);
    }
    const alignId = Object.entries(DEFAULT_PI_MODELS).find(([, d]) => d.provider === provider)?.[0] ?? provider;
    const apiKey = namedProvider(alignId) ? keyFor(alignId as NamedProviderId, saved, preferred) : undefined;
    if (!apiKey) throw new Error(`ALIGN_AGENT_MODEL names ${provider}, but there is no key for it. Export its key or run align ai.`);
    return { provider, modelId, apiKey, label: label(alignId, modelId) };
  }

  // The preference goes first, then the fixed provider order, so the answer does not depend on which
  // shell variable happens to be set.
  const order = [preferred, ...NAMED_PROVIDERS.map((p) => p.id)].filter((id): id is NamedProviderId => Boolean(id) && id !== 'ollama' && id !== 'custom' && id !== 'openrouter');
  for (const alignId of order) {
    const def = DEFAULT_PI_MODELS[alignId];
    const apiKey = def ? keyFor(alignId, saved, preferred) : undefined;
    if (def && apiKey) return { provider: def.provider, modelId: def.modelId, apiKey, label: label(alignId, def.modelId) };
  }

  const model = await (opts.probeOllama ?? probeLocalOllama)();
  if (model) {
    // `||`, not `??`: OLLAMA_HOST='' must not make a relative URL (local-llm's ollamaHost says why).
    const host = (process.env['OLLAMA_HOST'] || 'http://localhost:11434').replace(/\/+$/, '');
    return { provider: 'ollama', modelId: model, apiKey: 'ollama', baseUrl: `${host}/v1`, label: `Ollama ${model}` };
  }
  return undefined;
}
