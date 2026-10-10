import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchGitHubItems, resolveGitHubRepoScope } from '../../lib/fetchers/github.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { renderCaptureReport, toCaptureSource } from '../../lib/capture-report.js';
import { CAPTURE_SOURCES } from '../../lib/capture-sources.js';
import { personalCredsForImport } from '../../lib/personal-oauth.js';
import { commandIntro } from '../../lib/brand.js';
import { SYNC_CEILINGS } from '../../lib/import-defaults.js';
import { fetchWindow, windowLabel } from '../../lib/since.js';
import { SINCE_HELP, sinceFromFlag } from '../../lib/since-flag.js';
import { discloseTeamScope } from '../../lib/scope-values.js';
import { activeStoredScope } from '../../lib/scope-real.js';

interface GitHubImportOpts {
  token?: string;
  personal?: boolean;
  limit: string;
  since?: string;
  approve?: boolean;
  env?: EnvName;
  repo?: string;
  all?: boolean;
}

export function registerImportGitHubCommand(importCmd: Command): void {
  importCmd
    .command('github')
    .description('Import your GitHub PRs and issues')
    .option('--token <token>', 'GitHub personal access token (ghp_...)')
    .option('--personal', 'Connect your own GitHub via browser OAuth (Align personal app) instead of a token')
    .option('--limit <n>', 'Max items to import', String(SYNC_CEILINGS.github))
    .option('--since <when>', SINCE_HELP)
    .option('--repo <owner/repo>', 'Scope to one GitHub repo - the literal owner/repo (not the fuzzy short name `search`/`why` accept; default: the repo you are in, if it is a GitHub remote)')
    .option('--all', 'Every repo your token can see, not just the current one')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: GitHubImportOpts, cmd: Command) => {
      const opts = subcommandOpts<GitHubImportOpts>(cmd);
      const window = sinceFromFlag(opts.since);
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

      p.intro(commandIntro('align connect github'));
      const spinner = p.spinner();
      try {
        // Inside the try, not before it: currentRepoIdentity() shells out to git, and
        // every failure mode it can hit today happens to be caught internally (git.ts's
        // execa calls each swallow their own error) - but that is an invariant of THAT
        // file, not this one, and this call must not be the one thing standing outside
        // the safety net if it ever changes.
        const flagged = await resolveGitHubRepoScope(opts);
        // L4: on the local graph the choice already made (`align connect --source github --scope ...`, or `align_scope`) is honoured here too,
        // unless --repo/--all says otherwise: a stored "yours" is not widened by the folder, and a stored repo is read wherever this runs.
        const chosen = env.mode === 'local-embedded' && opts.repo === undefined && !opts.all ? activeStoredScope('github', config) : null;
        const repo = chosen?.kind === 'team' ? chosen.values[0] : chosen?.kind === 'yours' ? undefined : flagged;
        // Team scope only on the LOCAL graph, and only inside a repo; a hosted env keeps `yours`.
        // The status text says what is read, because it is not "your" items.
        const team = Boolean(repo) && env.mode === 'local-embedded';
        // L4: the person is told what a team read covers before it happens, once. A hosted env never reads team scope.
        if (team) discloseTeamScope(config, 'github', [repo!], (line) => p.log.info(line));
        spinner.start(
          repo
            ? team
              ? `Fetching everyone's PRs and issues in ${repo}, as far as your token can see...`
              : `Fetching your GitHub PRs and issues in ${repo}...`
            : 'Fetching your GitHub PRs and issues everywhere your token can see (pass --repo to narrow)...',
        );
        // L3: items first, then discussion inline up to a request budget (fetchGitHubItems); inside a repo, everyone's items in it.
        const fetched = await fetchGitHubItems({
          token, ...fetchWindow('github', window), limit: parseInt(opts.limit, 10),
          ...(repo ? { repo, ...(team ? { scope: 'team' as const } : {}) } : {}),
        });
        const { items } = fetched;
        spinner.stop(`Found ${items.length} items`);
        const importResult: { stored?: number; failedBatches?: number } = {};
        await runPersonalImport(items, client, { result: importResult, label: 'GitHub', approve: opts.approve, appUrl: resolveAppUrl(env), funnel: { env, source: 'github' } });
        console.log(`${renderCaptureReport([toCaptureSource(CAPTURE_SOURCES.github, fetched, windowLabel(window.days), importResult)])}\n`);
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
