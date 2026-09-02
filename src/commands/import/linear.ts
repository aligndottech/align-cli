import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchLinearItems } from '../../lib/fetchers/linear.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { renderCaptureReport, toCaptureSource } from '../../lib/capture-report.js';
import { CAPTURE_SOURCES } from '../../lib/capture-sources.js';
import { personalCredsForImport } from '../../lib/personal-oauth.js';
import { commandIntro } from '../../lib/brand.js';

interface LinearImportOpts {
  token?: string;
  personal?: boolean;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportLinearCommand(importCmd: Command): void {
  importCmd
    .command('linear')
    .description('Import your Linear issues (personal API token)')
    .option('--token <token>', 'Linear personal API token (lin_api_...)')
    .option('--personal', 'Connect your own Linear via browser OAuth (Align personal app) instead of a token')
    .option('--limit <n>', 'Max items to import', '100')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: LinearImportOpts, cmd: Command) => {
      const opts = subcommandOpts<LinearImportOpts>(cmd);
      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      let token = opts.token;
      if (!token && opts.personal) {
        try {
          ({ token } = await personalCredsForImport('linear', 'Linear', { config, envName, env, client }));
        } catch (err) {
          p.log.error((err as Error).message);
          process.exit(1);
        }
      }
      if (!token) {
        p.log.error('No Linear credentials. Pass --token, or use --personal to connect via browser OAuth.');
        process.exit(1);
      }

      p.intro(commandIntro('align import linear'));
      const spinner = p.spinner();
      spinner.start('Fetching your Linear issues...');
      try {
        const fetched = await fetchLinearItems({ token, limit: parseInt(opts.limit, 10) });
        const { items } = fetched;
        spinner.stop(`Found ${items.length} items`);
        await runPersonalImport(items, client, { label: 'Linear', approve: opts.approve, appUrl: resolveAppUrl(env), funnel: { env, source: 'linear' } });
        console.log(`${renderCaptureReport([toCaptureSource(CAPTURE_SOURCES.linear, fetched)])}\n`);
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
