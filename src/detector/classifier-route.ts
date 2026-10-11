import { NAMED_PROVIDERS, OPENROUTER_KEY_ENV, STORABLE_PROVIDERS } from '../lib/llm-providers.js';

/** Only KEY variables make a route hosted. A model name or a base URL alone does not (it has no key). */
const KEY_ENVS: readonly string[] = [...NAMED_PROVIDERS.flatMap((p) => p.keyEnv), 'ALIGN_LLM_API_KEY', OPENROUTER_KEY_ENV];

/**
 * Where the relationship classifier sends its calls: `hosted` when a hosted provider key is set in
 * the environment or saved, `local` when none is (the classifier then uses a local Ollama). The
 * detector default follows this route: v1 on hosted, where it matches the paid product, and v0 on
 * local, where v1 loses recall on small models (docs/local-mode.md).
 */
export type ClassifierRoute = 'hosted' | 'local';

export function classifierRoute(
  env: Record<string, string | undefined>,
  config: { getProviderKey(p: (typeof STORABLE_PROVIDERS)[number]): string | null },
): ClassifierRoute {
  const envKey = KEY_ENVS.some((name) => (env[name] ?? '').trim() !== '');
  if (envKey) return 'hosted';
  const saved = STORABLE_PROVIDERS.some((p) => (config.getProviderKey(p) ?? '').trim() !== '');
  return saved ? 'hosted' : 'local';
}
