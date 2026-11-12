/**
 * `align backlog <decision>` - turn one decision into a backlog of issues, created straight away.
 *
 * A write path to the user's own tracker, so the shape of it matters: a PERSON runs this command, naming the
 * tracker and target (or answering one question, or relying on the target a first run saved for this repo), and the
 * output states exactly what was created and where. An agent reaches the same logic through the `align_backlog` MCP tool.
 * Credentials are the ones the person already holds (`align connect`, or --token / LINEAR_API_KEY / GITHUB_TOKEN);
 * Align's own read-only sign-ins are never upgraded. `--dry-run` shows the plan and creates nothing.
 */
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { DEFAULT_MAX_TASKS, runBacklog } from '../lib/backlog/run.js';
import { backlogRepoKey, createBacklogDeps } from '../lib/backlog/deps.js';

interface BacklogCliOpts {
  tracker?: string; team?: string; repo?: string; project?: string; token?: string;
  dryRun?: boolean; force?: boolean; max?: string; env?: EnvName;
}

export function registerBacklogCommand(program: Command): void {
  program
    .command('backlog <decision>')
    .description('Turn a decision into one issue per task, created straight away in Linear, GitHub Issues or Jira (the first run asks where; later runs reuse it)')
    .option('--tracker <tracker>', 'linear, github or jira (needed when more than one is connected)')
    .option('--team <key>', 'Linear team key')
    .option('--repo <owner/repo>', 'GitHub repository')
    .option('--project <key>', 'Jira project key')
    .option('--token <token>', 'A token that can create issues (default: the one from align connect, LINEAR_API_KEY or GITHUB_TOKEN)')
    .option('--dry-run', 'Show the issues that would be created and where; create nothing')
    .option('--force', 'Create the issues again even if this decision already has them here')
    .option('--max <n>', `Most tasks to create (1-25, default ${DEFAULT_MAX_TASKS})`)
    .option('--env <env>', 'Environment')
    .action(async (decisionArg: string, opts: BacklogCliOpts) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const deps = createBacklogDeps({
        client, config,
        // Connector tokens are saved under the env they were connected in; local mode is where token paste lives.
        envNames: envName === 'local' ? ['local'] : [envName, 'local'],
        appUrlEnv: env, repoKey: await backlogRepoKey(), interactive,
        choose: async (question, options) => {
          const v = options.length === 0
            ? await p.text({ message: question })
            : await p.select<string>({ message: question, options });
          return p.isCancel(v) || typeof v !== 'string' || v === '' ? null : v;
        },
        out: (l) => console.log(l),
        err: (l) => console.error(l),
      });
      const code = await runBacklog({
        decision: decisionArg, tracker: opts.tracker, team: opts.team, repo: opts.repo, project: opts.project, token: opts.token,
        dryRun: opts.dryRun, force: opts.force, max: opts.max === undefined ? undefined : Number(opts.max),
      }, deps);
      process.exit(code);
    });
}
