import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchGitHubItems } from '../../lib/fetchers/github.js';
import { runPersonalImport } from '../../lib/personal-import.js';

interface GitHubImportOpts {
  token: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportGitHubCommand(importCmd: Command): void {
  importCmd
    .command('github')
    .description('Import your GitHub PRs and issues (personal access token)')
    .requiredOption('--token <token>', 'GitHub personal access token (ghp_...)')
    .option('--limit <n>', 'Max items to import', '100')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (opts: GitHubImportOpts) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro('align import github');
      const spinner = p.spinner();
      spinner.start('Fetching your GitHub PRs and issues...');
      try {
        const items = await fetchGitHubItems({ token: opts.token, limit: parseInt(opts.limit, 10) });
        spinner.stop(`Found ${items.length} items`);
        await runPersonalImport(items, client, { label: 'GitHub', approve: opts.approve, appUrl: resolveAppUrl(env) });
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
