import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchGitLabItems } from '../../lib/fetchers/gitlab.js';
import { runPersonalImport } from '../../lib/personal-import.js';

interface GitLabImportOpts {
  token: string;
  domain?: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportGitLabCommand(importCmd: Command): void {
  importCmd
    .command('gitlab')
    .description('Import your GitLab merge requests (personal access token)')
    .requiredOption('--token <token>', 'GitLab personal access token (glpat-...)')
    .option('--domain <domain>', 'GitLab domain for self-hosted (default: gitlab.com)')
    .option('--limit <n>', 'Max items to import', '100')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (opts: GitLabImportOpts) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro('align import gitlab');
      const spinner = p.spinner();
      spinner.start('Fetching your GitLab merge requests...');
      try {
        const items = await fetchGitLabItems({ token: opts.token, domain: opts.domain, limit: parseInt(opts.limit, 10) });
        spinner.stop(`Found ${items.length} items`);
        await runPersonalImport(items, client, { label: 'GitLab', approve: opts.approve, appUrl: resolveAppUrl(env) });
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
