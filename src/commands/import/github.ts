import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchGitHubItems } from '../../lib/fetchers/github.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { renderCaptureReport, toCaptureSource } from '../../lib/capture-report.js';
import { CAPTURE_SOURCES } from '../../lib/capture-sources.js';
import { personalCredsForImport } from '../../lib/personal-oauth.js';
import { commandIntro } from '../../lib/brand.js';
import { IMPORT_LIMITS } from '../../lib/import-defaults.js';

interface GitHubImportOpts {
  token?: string;
  personal?: boolean;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportGitHubCommand(importCmd: Command): void {
  importCmd
    .command('github')
    .description('Import your GitHub PRs and issues')
    .option('--token <token>', 'GitHub personal access token (ghp_...)')
    .option('--personal', 'Connect your own GitHub via browser OAuth (Align personal app) instead of a token')
    .option('--limit <n>', 'Max items to import', String(IMPORT_LIMITS.github))
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: GitHubImportOpts, cmd: Command) => {
      const opts = subcommandOpts<GitHubImportOpts>(cmd);
      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      let token = opts.token;
      if (!token && opts.personal) {
        try {
          ({ token } = await personalCredsForImport('github', 'GitHub', { config, envName, env, client }));
        } catch (err) {
          p.log.error((err as Error).message);
          process.exit(1);
        }
      }
      if (!token) {
        p.log.error('No GitHub credentials. Pass --token <ghp_...>, or use --personal to connect via browser OAuth.');
        process.exit(1);
      }

      p.intro(commandIntro('align import github'));
      const spinner = p.spinner();
      spinner.start('Fetching your GitHub PRs and issues...');
      try {
        const fetched = await fetchGitHubItems({ token, limit: parseInt(opts.limit, 10) });
        const { items } = fetched;
        spinner.stop(`Found ${items.length} items`);
        await runPersonalImport(items, client, { label: 'GitHub', approve: opts.approve, appUrl: resolveAppUrl(env), funnel: { env, source: 'github' } });
        console.log(`${renderCaptureReport([toCaptureSource(CAPTURE_SOURCES.github, fetched)])}\n`);
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
