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
import { IMPORT_LIMITS } from '../../lib/import-defaults.js';

interface DocsImportOpts {
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportDocsCommand(importCmd: Command): void {
  importCmd
    .command('docs')
    .description('Import ADRs and your CLAUDE.md/AGENTS.md content (no auth required)')
    .option('--limit <n>', 'Max items to import', String(IMPORT_LIMITS.docs))
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: DocsImportOpts, cmd: Command) => {
      const opts = subcommandOpts<DocsImportOpts>(cmd);

      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro(commandIntro('align import docs'));

      const spinner = p.spinner();
      spinner.start('Reading ADRs and CLAUDE.md/AGENTS.md...');
      const fetched = await fetchDocsItems({ limit: parseInt(opts.limit, 10) });
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
