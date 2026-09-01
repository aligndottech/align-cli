import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { buildCommitUrl, formatCommitAsText, getCommitHistoryDetailed, getRemoteUrl, isGitRepo } from '../../lib/git.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { commandIntro } from '../../lib/brand.js';

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
    .option('--limit <n>', 'Max commits to import', '500')
    .option('--from <date>', 'Start date (ISO e.g. 2025-01-01)')
    .option('--to <date>', 'End date (ISO)')
    .option('--branch <name>', 'Branch to scan (default: current)')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: GitImportOpts, cmd: Command) => {
      const opts = subcommandOpts<GitImportOpts>(cmd);
      if (!(await isGitRepo())) {
        p.log.error('Not in a git repository. Run from inside your project directory.');
        process.exit(1);
      }

      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro(commandIntro('align import git'));

      const spinner = p.spinner();
      spinner.start('Reading git history...');
      const { commits, scanned, rejectedByRationale } = await getCommitHistoryDetailed({
        limit: parseInt(opts.limit, 10),
        from: opts.from,
        to: opts.to,
        branch: opts.branch,
      });
      const remoteUrl = await getRemoteUrl();
      // ALI-804: report both directions - "N commits worth importing" alone reads as "this
      // is everything found", not as a kept fraction, which is the exact perception problem
      // the ticket is about. Only say so when the rationale gate actually dropped something,
      // so a small scan (nothing filtered) still gets the plain, uncluttered message. Uses
      // rejectedByRationale specifically, not scanned - commits.length: that difference also
      // includes the PRE-EXISTING subject-shape rejections (chore/wip/merge/too-short), which
      // never reached this gate at all and are not "no stated reason" (Copilot review, PR #223).
      spinner.stop(rejectedByRationale > 0
        ? `Scanned ${scanned} commits, kept ${commits.length} as likely decisions (${rejectedByRationale} skipped for stating no reason)`
        : `Found ${commits.length} commits worth importing`);

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
        funnel: { env, source: 'git' },
      });
    });
}
