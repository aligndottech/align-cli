import { hasConfiguredProvider, probeOllama, RECOMMENDED_OLLAMA_PULL } from './local-llm.js';

interface Deps {
  hasProvider: () => boolean;
  probeOllama: () => Promise<string | null>;
}

/**
 * Conflict checks need an AI model. With no key and no usable Ollama model, every check says "could not
 * check" and the first person to find out is the one whose agent just printed it. Returns the lines to show
 * at the end of setup when that is the case, and null when a model is available.
 */
export async function modelReadinessLines(deps: Deps = { hasProvider: hasConfiguredProvider, probeOllama }): Promise<string[] | null> {
  if (deps.hasProvider()) return null;
  try {
    if ((await deps.probeOllama()) !== null) return null;
  } catch {
    // A probe that fails is the same as no Ollama.
  }
  return [
    'Conflict checks need an AI model, and none is set up, so they will not run yet (checks say "could not check").',
    'Pick one: set a key (ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY), or run a local model:',
    `  ollama pull ${RECOMMENDED_OLLAMA_PULL}`,
  ];
}
