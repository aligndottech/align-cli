import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { buildCommitUrl, formatCommitAsText, getCommitHistory, getRemoteUrl, isGitRepo } from '../../lib/git.js';
import { runPersonalImport } from '../../lib/personal-import.js';

interface GitImportOpts {
  limit: string;
  from?: string;
  to?: string;
  branch?: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportGitCommand(importCmd: Command): void {
  importCmd
    .command('git')
    .description('Import local git commit history (no auth required)')
    .option('--limit <n>', 'Max commits to import', '100')
    .option('--from <date>', 'Start date (ISO e.g. 2025-01-01)')
    .option('--to <date>', 'End date (ISO)')
    .option('--branch <name>', 'Branch to scan (default: current)')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (opts: GitImportOpts) => {
      if (!(await isGitRepo())) {
        p.log.error('Not in a git repository. Run from inside your project directory.');
        process.exit(1);
      }

      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro('align import git');

      const spinner = p.spinner();
      spinner.start('Reading git history...');
      const commits = await getCommitHistory({
        limit: parseInt(opts.limit, 10),
        from: opts.from,
        to: opts.to,
        branch: opts.branch,
      });
      const remoteUrl = await getRemoteUrl();
      spinner.stop(`Found ${commits.length} commits worth importing`);

      if (remoteUrl) {
        const remote = remoteUrl.includes('github.com') ? 'GitHub'
          : remoteUrl.includes('gitlab.com') ? 'GitLab' : 'remote';
        p.log.info(`Detected ${remote} remote - commits will have clickable links`);
      }

      const items = commits.map(c => {
        const url = buildCommitUrl(remoteUrl, c.sha);
        return {
          source_url: url,
          platform: 'git',
          raw_text: formatCommitAsText(c, url),
          title: c.subject,
        };
      });

      await runPersonalImport(items, client, {
        label: 'git history',
        approve: opts.approve,
        appUrl: resolveAppUrl(env),
      });
    });
}
