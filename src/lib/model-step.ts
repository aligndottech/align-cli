import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore } from './config.js';
import { freeGroqKey, promptForProviderKey } from './ask-key-offer.js';
import { guardedPrompt } from './prompt-guard.js';
import { type LlmProviderId, PROVIDER_LABEL } from './llm-providers.js';
import { hasConfiguredProvider, probeOllama, RECOMMENDED_OLLAMA_PULL, unusedExportedKeys } from './local-llm.js';

/**
 * The wizard's model step. Conflict checks classify a pair of decisions with an AI model, and Align runs that in its
 * own process, so it cannot borrow the login of the coding agent it wraps (Claude Code, OpenCode, Codex ... each
 * keep theirs to themselves). With no key and no local model, every check said "could not check" and the first person
 * to find out was the one whose agent printed it. This asks once, at setup, only when it is true, and offers what this
 * machine already has first: a key exported in the shell (DeepSeek, Anthropic ...), then a key to paste, a free Groq
 * key, or a local model. The choice is saved in Align's own config, so it holds for every agent.
 */

export interface ModelStepDeps {
  hasProvider: () => boolean;
  ollamaModel: () => Promise<string | null>;
  unusedExported: () => Array<{ id: LlmProviderId; envVar: string }>;
  select: (options: Array<{ value: string; label: string; hint?: string }>) => Promise<string | null>;
  pasteKey: () => Promise<unknown>;
  freeGroq: () => Promise<boolean>;
  setPreference: (pref: { provider: LlmProviderId }) => void;
  log: { info: (m: string) => void; warn: (m: string) => void; success: (m: string) => void };
}

export type ModelStepResult = 'ready' | 'configured' | 'skipped';

export function modelStepOptions(exported: Array<{ id: LlmProviderId; envVar: string }>): Array<{ value: string; label: string; hint?: string }> {
  return [
    ...exported.map((k) => ({ value: `env:${k.id}`, label: `Use ${PROVIDER_LABEL[k.id]}`, hint: `found ${k.envVar} in your shell` })),
    { value: 'key', label: 'Paste an API key I already have', hint: 'Anthropic, OpenAI, Gemini, DeepSeek and more' },
    { value: 'groq', label: 'Get a free Groq key', hint: 'no card needed' },
    { value: 'ollama', label: 'Run a local model with Ollama', hint: 'free, nothing leaves this machine' },
    { value: 'skip', label: 'Skip for now', hint: 'your agent still judges conflicts; align check cannot yet' },
  ];
}

export function noModelLines(): string[] {
  return [
    // Scoped to what actually needs it: inside the agent, the agent adjudicates the related decisions itself.
    'No AI model is set up. Inside your agent that is fine: the agent judges conflicts itself.',
    '`align check` in the terminal and CI needs one, and says "could not check" until it has one.',
    `Free and local:  ollama pull ${RECOMMENDED_OLLAMA_PULL}`,
    'Or a key:        export ANTHROPIC_API_KEY (or OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY ...), then run: align ai',
  ];
}

function realDeps(): ModelStepDeps {
  const config = createConfigStore();
  return {
    hasProvider: hasConfiguredProvider,
    ollamaModel: probeOllama,
    unusedExported: () => unusedExportedKeys().filter((k) => k.id !== 'custom' && k.id !== 'ollama'),
    select: async (options) => {
      const choice = await guardedPrompt('AI model', () => p.select<string>({ message: 'Which AI model should check your changes against the graph?', options }));
      return choice === null || p.isCancel(choice) ? null : choice;
    },
    pasteKey: () => promptForProviderKey(config),
    freeGroq: () => freeGroqKey(config),
    setPreference: (pref) => config.setLlmPreference(pref),
    log: { info: (m) => p.log.info(m), warn: (m) => p.log.warn(m), success: (m) => p.log.success(m) },
  };
}

export async function runModelStep(opts: { interactive: boolean }, deps: ModelStepDeps = realDeps()): Promise<ModelStepResult> {
  if (deps.hasProvider()) return 'ready';
  try {
    if ((await deps.ollamaModel()) !== null) return 'ready';
  } catch {
    // A probe that fails is the same as no Ollama.
  }
  const warn = (): ModelStepResult => {
    deps.log.warn(noModelLines().join('\n'));
    return 'skipped';
  };
  if (!opts.interactive) return warn();

  const choice = await deps.select(modelStepOptions(deps.unusedExported()));
  if (choice === null || choice === 'skip') return warn();
  if (choice.startsWith('env:')) {
    const provider = choice.slice(4) as LlmProviderId;
    deps.setPreference({ provider });
    deps.log.success(`Checks will use ${PROVIDER_LABEL[provider]} with the key in your shell.`);
    return 'configured';
  }
  if (choice === 'ollama') {
    deps.log.info(`Run this in another terminal; checks pick it up on their own:\n  ${chalk.bold(`ollama pull ${RECOMMENDED_OLLAMA_PULL}`)}`);
    return warn();
  }
  const saved = choice === 'groq' ? await deps.freeGroq() : (await deps.pasteKey()) !== null;
  if (saved) return 'configured';
  return warn();
}
