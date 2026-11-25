import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchDocsItems } from '../../lib/fetchers/docs.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { renderCaptureReport, toCaptureSource } from '../../lib/capture-report.js';
import { CAPTURE_SOURCES } from '../../lib/capture-sources.js';
import { commandIntro } from '../../lib/brand.js';
import { SYNC_CEILINGS } from '../../lib/import-defaults.js';

interface DocsImportOpts {
  limit: string;
  approve?: boolean;
  env?: EnvName;
  docsPath?: string[];
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export function registerImportDocsCommand(importCmd: Command): void {
  importCmd
    .command('docs')
    .description('Import ADRs and RFCs, decision logs, CLAUDE.md/AGENTS.md, tenets and architecture docs, and the rules in README, CONTRIBUTING and the changelog (no auth required)')
    .option('--limit <n>', 'Max items to import', String(SYNC_CEILINGS.docs))
    .option('--approve', 'Skip confirmation prompt')
    .option('--docs-path <dir>', 'Also read every markdown file in this folder of the repo, numbered or not (repeat for more folders)', collect, [] as string[])
    .option('--env <env>', 'Environment')
    .action(async (_opts: DocsImportOpts, cmd: Command) => {
      const opts = subcommandOpts<DocsImportOpts>(cmd);

      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro(commandIntro('align connect docs'));

      const spinner = p.spinner();
      spinner.start('Reading ADRs, CLAUDE.md/AGENTS.md, README and CONTRIBUTING rules...');
      let fetched: Awaited<ReturnType<typeof fetchDocsItems>>;
      try {
        fetched = await fetchDocsItems({ limit: parseInt(opts.limit, 10), extraDocsPaths: opts.docsPath ?? [] });
      } catch (err) {
        // A folder the user named that cannot be read is an error to fix, not an empty import.
        spinner.stop('Could not read the docs');
        p.log.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
      const { items } = fetched;
      spinner.stop(`Found ${items.length} item(s) worth importing`);

      await runPersonalImport(items, client, {
        label: 'repo docs',
        approve: opts.approve,
        appUrl: resolveAppUrl(env),
        funnel: { env, source: 'docs' },
      });
      console.log(`${renderCaptureReport([toCaptureSource(CAPTURE_SOURCES.docs, fetched)])}\n`);
    });
}
