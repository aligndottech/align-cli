/**
 * The AI-provider key, asked for where it is used: `align ask` on a terminal, the first time
 * it has nothing to write prose with.
 *
 * It used to be the last step of the first-run wizard (ALI-1284's guided Groq + Gemini
 * offer), immediately before align opened the coding agent. Read in that position, a Groq key
 * looks like something Claude Code needs - it is not. Inside a wrapped agent the agent writes
 * the prose from the MCP results; the key only serves align's own terminal `align ask`. So the
 * wizard no longer asks, and this module asks lazily, with the reason stated first.
 *
 * Secrets: a key is read through a masked password prompt, stored in the 0600 config file
 * (config.setProviderKey, the same store as every other saved credential) and never printed -
 * not in a log line, not in a confirmation. It is never written to process.env either (H1):
 * local-llm reads saved keys as data on every call, so it is live at once, and a child process
 * (the coding agent bare `align` opens) cannot inherit it.
 */
import * as p from '@clack/prompts';
import chalk from 'chalk';
import type { LlmPreference } from './config.js';
import { listConfiguredCredentials, unusedExportedKeys } from './local-llm.js';
import {
  type LlmProviderId,
  PROVIDER_KEY_URL,
  PROVIDER_LABEL,
  STORABLE_PROVIDERS,
  type StoredProviderId,
} from './llm-providers.js';
import { guardedPrompt } from './prompt-guard.js';

/** The slice of the config store this module needs. */
export interface KeyStore {
  getProviderKey(provider: StoredProviderId): string | null;
  setProviderKey(provider: StoredProviderId, key: string): void;
  getLlmPreference?(): LlmPreference;
  setLlmPreference(pref: LlmPreference): void;
}

export interface OfferStore extends KeyStore {
  setAskKeyOfferDismissed(dismissed: boolean): void;
}

/** The command that re-opens this choice later. */
export const CHOOSE_PROVIDER_COMMAND = 'align ai';

/** Masked paste for one provider. null when nothing usable was entered (or the prompt crashed). */
async function pasteKey(id: StoredProviderId): Promise<string | null | symbol> {
  p.log.info(`Get one: ${chalk.bold(PROVIDER_KEY_URL[id])}`);
  const key = await guardedPrompt(`${PROVIDER_LABEL[id]} API key`, () =>
    p.password({ message: `  ${PROVIDER_LABEL[id]} API key:` }));
  if (p.isCancel(key)) return key;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

/**
 * "Use a key I already have": pick the provider, paste, save. Returns the provider saved, or
 * null when the user backed out or pasted nothing.
 */
export async function promptForProviderKey(config: KeyStore): Promise<StoredProviderId | null> {
  // Keys already exported for a provider align does not use on its own (HF_TOKEN for model
  // downloads, say) come first: picking one saves only the CHOICE, so the key stays in the
  // user's shell and is never copied into align's config.
  const exported = unusedExportedKeys().filter((k) => k.id !== 'custom' && k.id !== 'ollama');
  const choice = await guardedPrompt('Provider', () => p.select<string>({
    message: 'Which provider is the key for?',
    options: [
      ...exported.map((k) => ({ value: `env:${k.id}`, label: `${PROVIDER_LABEL[k.id]} (found ${k.envVar} in your shell)` })),
      ...STORABLE_PROVIDERS.map((value) => ({ value, label: PROVIDER_LABEL[value] })),
    ],
  }));
  if (choice === null || p.isCancel(choice) || typeof choice !== 'string') return null;
  if (choice.startsWith('env:')) {
    const id = choice.slice(4) as StoredProviderId;
    config.setLlmPreference({ provider: id });
    p.log.success(`${chalk.bold('align ask')} now uses ${PROVIDER_LABEL[id]} with the key in your shell.`);
    return id;
  }
  const id = choice as StoredProviderId;
  const key = await pasteKey(id);
  if (key === null || typeof key !== 'string') {
    if (key === null) p.log.warn('No key entered - nothing saved.');
    return null;
  }
  config.setProviderKey(id, key);
  p.log.success(`Saved your ${PROVIDER_LABEL[id]} key - ${chalk.bold('align ask')} uses it from now on.`);
  return id;
}

/** "Get a free Groq key": today's guided path, Gemini backup included. */
async function freeGroqKey(config: KeyStore): Promise<boolean> {
  p.log.info(`Groq's free tier needs no card, ever.`);
  const groq = await pasteKey('groq');
  if (typeof groq !== 'string') {
    if (groq === null) p.log.warn('No key entered - nothing saved.');
    return false;
  }
  config.setProviderKey('groq', groq);
  p.log.success(`Saved - ${chalk.bold('align ask')} will use it on this machine from now on.`);

  const wantGemini = await p.confirm({
    message: `Also add a Gemini key as backup for when Groq's daily limit is hit? (also free, no card)`,
    initialValue: true,
  });
  if (p.isCancel(wantGemini) || !wantGemini) return true;
  const gemini = await pasteKey('gemini');
  if (typeof gemini === 'string') {
    config.setProviderKey('gemini', gemini);
    p.log.success('Saved as backup.');
  } else if (gemini === null) {
    p.log.warn('No key entered - skipping the backup.');
  }
  return true;
}

export type OfferResult = 'configured' | 'dismissed' | 'cancelled';

/**
 * The first-ask choice. 'configured': a key was saved and is live for the next call - ask again.
 * 'dismissed': "Not now", remembered so `align ask` stops asking. 'cancelled': backed out
 * (Ctrl-C, empty paste) - nothing saved, nothing remembered, the list prints as usual.
 */
export async function offerAskProviderKey(config: OfferStore): Promise<OfferResult> {
  p.log.info(
    `${chalk.bold('align ask')} writes answers with an AI model. Inside your coding agent you don't need this - the agent writes them.`,
  );
  const choice = await guardedPrompt('AI model', () => p.select<'existing' | 'groq' | 'later'>({
    message: `To get answers here in the terminal, pick one (change it any time: ${CHOOSE_PROVIDER_COMMAND}):`,
    options: [
      { value: 'existing', label: 'Use a key I already have' },
      { value: 'groq', label: 'Get a free Groq key' },
      { value: 'later', label: 'Not now - just show matching decisions' },
    ],
    initialValue: 'later',
  }));
  if (choice === null || p.isCancel(choice)) return 'cancelled';
  if (choice === 'later') {
    config.setAskKeyOfferDismissed(true);
    return 'dismissed';
  }
  const saved = choice === 'groq' ? await freeGroqKey(config) : (await promptForProviderKey(config)) !== null;
  return saved ? 'configured' : 'cancelled';
}

export interface DetectedProvider {
  id: LlmProviderId;
  /** env: exported in the shell. saved: a key align stored. local: found running on this machine. */
  source: 'env' | 'saved' | 'local';
}

/**
 * Every provider `align ask` could use right now, in the default order (exported credentials,
 * then saved ones, then Ollama). The Ollama check is the same 2s /api/tags probe the ask path
 * runs, injected so tests never touch the network.
 */
export async function detectProviders(probeOllama: () => Promise<string | null>): Promise<DetectedProvider[]> {
  const found: DetectedProvider[] = listConfiguredCredentials();
  if (await probeOllama()) found.push({ id: 'ollama', source: 'local' });
  return found;
}
