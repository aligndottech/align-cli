import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchGitLabItems } from '../../lib/fetchers/gitlab.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { personalCredsForImport } from '../../lib/personal-oauth.js';
import { commandIntro } from '../../lib/brand.js';

interface GitLabImportOpts {
  token?: string;
  personal?: boolean;
  domain?: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportGitLabCommand(importCmd: Command): void {
  importCmd
    .command('gitlab')
    .description('Import your GitLab merge requests')
    .option('--token <token>', 'GitLab personal access token (glpat-...)')
    .option('--personal', 'Connect your own GitLab via browser OAuth (gitlab.com only)')
    .option('--domain <domain>', 'GitLab domain for self-hosted (default: gitlab.com)')
    .option('--limit <n>', 'Max items to import', '100')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: GitLabImportOpts, cmd: Command) => {
      const opts = subcommandOpts<GitLabImportOpts>(cmd);
      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      // The Align GitLab OAuth app authorizes against gitlab.com only; a self-managed host
      // needs the PAT path (mirrors the hostGatedOAuth rule in align setup).
      if (opts.personal && opts.domain) {
        p.log.error('--personal uses the Align GitLab OAuth app, which is gitlab.com-only. For self-managed GitLab pass --token (and --domain).');
        process.exit(1);
      }

      let token = opts.token;
      if (!token && opts.personal) {
        try {
          ({ token } = await personalCredsForImport('gitlab', 'GitLab', { config, envName, env, client }));
        } catch (err) {
          p.log.error((err as Error).message);
          process.exit(1);
        }
      }
      if (!token) {
        p.log.error('No GitLab credentials. Pass --token <glpat-...>, or use --personal to connect via browser OAuth.');
        process.exit(1);
      }

      p.intro(commandIntro('align import gitlab'));
      const spinner = p.spinner();
      spinner.start('Fetching your GitLab merge requests...');
      try {
        const items = await fetchGitLabItems({ token, domain: opts.domain, limit: parseInt(opts.limit, 10) });
        spinner.stop(`Found ${items.length} items`);
        await runPersonalImport(items, client, { label: 'GitLab', approve: opts.approve, appUrl: resolveAppUrl(env) });
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
