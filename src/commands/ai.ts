import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore } from '../lib/config.js';
import { probeOllama } from '../lib/local-llm.js';
import { LLM_PROVIDER_IDS, type LlmProviderId, parseProviderId, PROVIDER_LABEL } from '../lib/llm-providers.js';
import { type DetectedProvider, detectProviders, promptForProviderKey } from '../lib/ask-key-offer.js';
import { guardedPrompt } from '../lib/prompt-guard.js';

/** `--provider auto`: forget the choice and use the default order again. */
const AUTO = 'auto';

function sourceHint(d: DetectedProvider): string {
  return d.source === 'env' ? 'env' : d.source === 'saved' ? 'saved' : 'local';
}

/**
 * `align ai`: which AI provider `align ask` writes its terminal answers with. Only matters
 * when more than one is available, or to add a key: with exactly one, `align ask` already
 * uses it, and inside a coding agent none of this is used at all.
 *
 * The choice is stored (config `llm`) and hydrated into ALIGN_LLM_PROVIDER, where an exported
 * value wins - see preferredProvider in local-llm.ts for the full precedence.
 */
export function registerAiCommand(program: Command): void {
  program
    .command('ai')
    .description('Choose the AI model `align ask` writes terminal answers with, or add a key')
    .option('--provider <id>', `Use this provider first: ${[...LLM_PROVIDER_IDS, AUTO].join(', ')}`)
    .option('--model <model>', 'With --provider: the model to ask for')
    .action(async (opts: { provider?: string; model?: string }) => {
      const config = createConfigStore();

      if (opts.provider !== undefined) {
        if (opts.provider.trim().toLowerCase() === AUTO) {
          config.clearLlmPreference();
          console.log(`  ${chalk.bold('align ask')} now uses the first available provider, in the default order.`);
          return;
        }
        const id = parseProviderId(opts.provider);
        if (!id) {
          console.error(`Unknown provider "${opts.provider}". Use one of: ${[...LLM_PROVIDER_IDS, AUTO].join(', ')}.`);
          process.exit(1);
        }
        config.setLlmPreference(opts.model ? { provider: id, model: opts.model } : { provider: id });
        console.log(`  ${chalk.bold('align ask')} now tries ${PROVIDER_LABEL[id]}${opts.model ? ` (${opts.model})` : ''} first.`);
        return;
      }
      if (opts.model !== undefined) {
        console.error('--model needs --provider, so it is clear which provider the model is for.');
        process.exit(1);
      }

      const found = await detectProviders(config, process.env, probeOllama);
      const current = parseProviderId(config.getLlmPreference().provider ?? '');
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

      if (!interactive) {
        console.log('');
        if (!found.length) {
          console.log('  No AI provider found. `align ask` lists matching decisions without one.');
        } else {
          console.log('  AI providers `align ask` can use:');
          for (const d of found) {
            console.log(`    ${d.id.padEnd(11)} ${PROVIDER_LABEL[d.id]} (${sourceHint(d)})${d.id === current ? '  - current' : ''}`);
          }
        }
        console.log('');
        console.log(`  Choose one: ${chalk.bold('align ai --provider <id>')}`);
        console.log('');
        return;
      }

      const options: Array<{ value: LlmProviderId | 'add' | 'auto'; label: string; hint?: string }> = found.map((d) => ({
        value: d.id,
        label: PROVIDER_LABEL[d.id],
        hint: `${sourceHint(d)}${d.id === current ? ' - current' : ''}`,
      }));
      options.push({ value: 'add', label: 'Add another key...' });
      if (current) options.push({ value: 'auto', label: 'Automatic', hint: 'first available, in the default order' });

      const choice = await guardedPrompt('AI provider', () => p.select({
        message: `Which AI model should ${chalk.bold('align ask')} write terminal answers with?`,
        options,
        initialValue: current && found.some((d) => d.id === current) ? current : options[0]!.value,
      }));
      if (choice === null || p.isCancel(choice)) return;

      if (choice === 'auto') {
        config.clearLlmPreference();
        p.log.success('Back to the default order.');
        return;
      }
      if (choice === 'add') {
        const added = await promptForProviderKey(config);
        if (!added) return;
        config.setLlmPreference({ provider: added });
        // A key now exists, so the first-ask offer's remembered "Not now" has nothing left to guard.
        config.setAskKeyOfferDismissed(false);
        return;
      }
      config.setLlmPreference({ provider: choice });
      p.log.success(`${chalk.bold('align ask')} now tries ${PROVIDER_LABEL[choice]} first.`);
    });
}
