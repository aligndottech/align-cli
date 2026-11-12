/**
 * `align backlog <decision>` - turn one decision into a backlog of issues, created straight away.
 *
 * A write path to the user's own tracker, so the shape of it matters: a PERSON runs this command, naming the
 * tracker and target (or answering one question), and the output states exactly what was created and where.
 * Credentials are the ones the person already holds (`align connect`, or --token / LINEAR_API_KEY / GITHUB_TOKEN);
 * Align's own read-only sign-ins are never upgraded. `--dry-run` shows the plan and sends nothing.
 */
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { resolveAppUrl } from '../lib/env-resolver.js';
import { alignStateDir } from '../lib/backfill-state.js';
import { type BacklogDeps, type DecisionInput, DEFAULT_MAX_TASKS, runBacklog } from '../lib/backlog/run.js';
import { shapeWithModel } from '../lib/backlog/shape.js';
import type { TrackerId } from '../lib/backlog/trackers.js';
import path from 'node:path';
import os from 'node:os';

interface BacklogCliOpts {
  tracker?: string; team?: string; repo?: string; project?: string; token?: string;
  dryRun?: boolean; force?: boolean; max?: string; env?: EnvName;
}

const TOKEN_ENV: Partial<Record<TrackerId, string>> = { linear: 'LINEAR_API_KEY', github: 'GITHUB_TOKEN' };

export function registerBacklogCommand(program: Command): void {
  program
    .command('backlog <decision>')
    .description('Turn a decision into one issue per task, created straight away in Linear, GitHub Issues or Jira')
    .option('--tracker <tracker>', 'linear, github or jira (needed when more than one is connected)')
    .option('--team <key>', 'Linear team key')
    .option('--repo <owner/repo>', 'GitHub repository')
    .option('--project <key>', 'Jira project key')
    .option('--token <token>', 'A token that can create issues (default: the one from align connect, LINEAR_API_KEY or GITHUB_TOKEN)')
    .option('--dry-run', 'Show the issues that would be created and where; send nothing')
    .option('--force', 'Create the issues again even if this decision already has them here')
    .option('--max <n>', `Most tasks to create (1-25, default ${DEFAULT_MAX_TASKS})`)
    .option('--env <env>', 'Environment')
    .action(async (decisionArg: string, opts: BacklogCliOpts) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const toInput = (d: { id: string; title: string; summary: string; source_url?: string | null; ai?: { actions?: Array<{ text: string }> } }): DecisionInput =>
        ({ id: d.id, title: d.title, summary: d.summary, sourceUrl: d.source_url ?? null, actions: (d.ai?.actions ?? []).map((a) => a.text) });
      const stateDir = alignStateDir() ?? path.join(os.homedir(), '.align-cli-state');
      const deps: BacklogDeps = {
        getDecision: async (id) => toInput(await client.getDecision(id)),
        search: async (q) => (await client.searchDecisions(q, 8)).results.map((r) => toInput(r as Parameters<typeof toInput>[0])),
        shape: shapeWithModel,
        credentials: (t) => {
          const fromEnv = TOKEN_ENV[t] ? process.env[TOKEN_ENV[t]!] : undefined;
          // Connector tokens are saved under the env they were connected in; local mode is where token paste lives.
          const saved = config.getConnectorFields(envName, t) ?? config.getConnectorFields('local', t);
          if (fromEnv) return { ...(saved ?? {}), token: fromEnv };
          return saved;
        },
        fetch,
        ledgerPath: path.join(stateDir, 'backlog-ledger.json'),
        interactive,
        choose: async (question, options) => {
          const v = options.length === 0
            ? await p.text({ message: question })
            : await p.select<string>({ message: question, options });
          return p.isCancel(v) || typeof v !== 'string' || v === '' ? null : v;
        },
        decisionUrl: (id) => (envName === 'local' ? null : `${resolveAppUrl(env)}/decisions/${id}`),
        out: (l) => console.log(l),
        err: (l) => console.error(l),
      };
      const code = await runBacklog({
        decision: decisionArg, tracker: opts.tracker, team: opts.team, repo: opts.repo, project: opts.project, token: opts.token,
        dryRun: opts.dryRun, force: opts.force, max: opts.max === undefined ? undefined : Number(opts.max),
      }, deps);
      process.exit(code);
    });
}
