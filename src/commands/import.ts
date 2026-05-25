import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { EventSource } from 'eventsource';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveAppUrl } from '../lib/env-resolver.js';
import { renderTable } from '../lib/table.js';
import { registerImportGitCommand } from './import/git.js';
import { registerImportGitHubCommand } from './import/github.js';
import { registerImportGitLabCommand } from './import/gitlab.js';
import { registerImportLinearCommand } from './import/linear.js';
import { registerImportJiraCommand } from './import/jira.js';
import { registerImportConfluenceCommand } from './import/confluence.js';
import { registerImportSlackCommand } from './import/slack.js';
import { registerImportTeamsCommand } from './import/teams.js';
import { registerImportZoomCommand } from './import/zoom.js';
import { registerImportNotionCommand } from './import/notion.js';

interface ProgressState {
  connector: string;
  jobId: string;
  processed: number;
  suggestions: number;
  status: 'running' | 'completed' | 'failed';
}

function renderProgress(jobs: ProgressState[]): void {
  process.stdout.write('\x1b[2K\r');
  const running = jobs.filter(j => j.status === 'running');
  const done = jobs.filter(j => j.status === 'completed');
  const totalSuggestions = jobs.reduce((s, j) => s + j.suggestions, 0);

  if (running.length) {
    const parts = running.map(j => `${chalk.cyan(j.connector)}: ${j.processed} processed`);
    process.stdout.write(
      `  ${parts.join('  |  ')}  [${chalk.green(String(done.length))}/${jobs.length} done, ${chalk.bold(String(totalSuggestions))} suggestions]`,
    );
  }
}

function registerImportListCommands(importCmd: Command): void {
  importCmd
    .command('list')
    .description('List import jobs')
    .option('--env <env>', 'Environment')
    .option('--status <status>', 'Filter by status (running, completed, failed, pending)')
    .option('--connector <key>', 'Filter by connector key')
    .action(async (opts: { env: EnvName; status?: string; connector?: string }) => {
      const client = createGatewayClient(createConfigStore().getEnvironment(resolveEnv(opts.env)));
      const spinner = p.spinner();
      spinner.start('Fetching import jobs...');
      try {
        const jobs = await client.listImportJobs({ status: opts.status, connector: opts.connector });
        spinner.stop('');
        if (!jobs.length) { console.log(chalk.dim('\nNo import jobs found.\n')); return; }
        console.log(chalk.bold(`\nImport Jobs (${opts.env})\n`));
        renderTable(
          [
            { header: 'ID', width: 38 },
            { header: 'CONNECTOR', width: 16 },
            {
              header: 'STATUS', width: 12,
              color: (v) => {
                const t = v.trim();
                if (t === 'completed') return chalk.green(v);
                if (t === 'failed') return chalk.red(v);
                return chalk.yellow(v);
              },
            },
            { header: 'PROCESSED', width: 12 },
            { header: 'SUGGESTIONS', width: 14 },
            { header: 'CREATED', width: 24 },
          ],
          jobs.map(j => [
            j.id,
            j.connector_key,
            j.status,
            String(j.progress?.items_processed ?? 0),
            String(j.progress?.suggestions_created ?? 0),
            new Date(j.created_at).toLocaleString(),
          ]),
        );
      } catch (err) {
        spinner.stop('');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  importCmd
    .command('suggestions')
    .description('List pending import suggestions')
    .option('--env <env>', 'Environment')
    .option('--job <id>', 'Filter by import job ID')
    .option('--status <s>', 'Filter by status', 'pending')
    .action(async (opts: { env: EnvName; job?: string; status: string }) => {
      const client = createGatewayClient(createConfigStore().getEnvironment(resolveEnv(opts.env)));
      const spinner = p.spinner();
      spinner.start('Fetching suggestions...');
      try {
        const suggestions = await client.listSuggestions(opts.job, opts.status);
        spinner.stop('');
        if (!suggestions.length) { console.log(chalk.dim('\nNo suggestions found.\n')); return; }
        console.log(chalk.bold(`\nSuggestions (${opts.status})\n`));
        renderTable(
          [
            { header: 'ID', width: 38 },
            { header: 'TITLE', width: 52 },
            { header: 'CONFIDENCE', width: 12 },
            { header: 'STATUS', width: 12 },
          ],
          suggestions.map(s => [s.id, s.suggested_title, (s.confidence ?? 0).toFixed(2), s.status]),
        );
        console.log(chalk.dim('Approve all: align import --all --approve'));
        console.log('');
      } catch (err) {
        spinner.stop('');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  importCmd
    .command('scan-runs')
    .description('List historical scan runs')
    .option('--env <env>', 'Environment')
    .action(async (opts: { env: EnvName }) => {
      const client = createGatewayClient(createConfigStore().getEnvironment(resolveEnv(opts.env)));
      const spinner = p.spinner();
      spinner.start('Fetching scan runs...');
      try {
        const runs = await client.listScanRuns();
        spinner.stop('');
        if (!runs.length) { console.log(chalk.dim('\nNo scan runs yet.\n')); return; }
        console.log(chalk.bold('\nScan Runs\n'));
        renderTable(
          [
            { header: 'ID', width: 38 },
            { header: 'CONNECTORS', width: 36 },
            { header: 'STATUS', width: 12 },
            { header: 'JOBS', width: 8 },
            { header: 'SUGGESTIONS', width: 14 },
            { header: 'CREATED', width: 24 },
          ],
          runs.map(r => [
            r.id,
            r.connectors.join(', '),
            r.status,
            `${r.progress?.jobs_completed ?? 0}/${r.progress?.jobs_total ?? 0}`,
            String(r.progress?.total_suggestions ?? 0),
            new Date(r.created_at).toLocaleString(),
          ]),
        );
      } catch (err) {
        spinner.stop('');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}

export function registerImportCommand(program: Command): void {
  const importCmd = program
    .command('import [connectors...]')
    .description('Scan connected tools historically and import decisions for review')
    .option('--env <env>', 'Environment')
    .option('--all', 'Scan all connected connectors')
    .option('--channel <id>', 'Slack channel ID (single-connector only)')
    .option('--project <key>', 'Project key (Jira prefix or GitHub org/repo)')
    .option('--from <date>', 'Start date ISO e.g. 2025-01-01')
    .option('--to <date>', 'End date ISO')
    .option('--approve', 'Auto-approve all suggestions when scan completes')
    .action(async (connectors: string[], opts: {
      env: EnvName; all: boolean; channel?: string; project?: string;
      from?: string; to?: string; approve: boolean;
    }) => {
      const config = createConfigStore();
      const env = config.getEnvironment(resolveEnv(opts.env));
      const client = createGatewayClient(env);

      let targets: string[] = connectors;
      if (opts.all || !connectors.length) {
        const spinner = p.spinner();
        spinner.start('Fetching connected connectors...');
        const all = await client.listConnectors();
        targets = all.filter(c => c.status === 'active').map(c => c.key);
        spinner.stop(`Found ${targets.length} connected connector(s): ${targets.join(', ')}`);
        if (!targets.length) {
          p.log.warn('No connectors are active. Connect one first: align connector enable slack');
          process.exit(1);
        }
      }

      const hasSpecificConfig = opts.channel || opts.project;
      const jobStates: ProgressState[] = [];

      if (targets.length === 1 && hasSpecificConfig) {
        const jobConfig: Record<string, unknown> = {};
        if (opts.channel) jobConfig['channel_id'] = opts.channel;
        if (opts.project) jobConfig['project_key'] = opts.project;
        if (opts.from) jobConfig['date_from'] = opts.from;
        if (opts.to) jobConfig['date_to'] = opts.to;

        const spinner = p.spinner();
        spinner.start(`Starting ${targets[0]} import...`);
        const job = await client.startImportJob(targets[0], jobConfig);
        spinner.stop(`Job started: ${job.id}`);
        jobStates.push({ connector: targets[0], jobId: job.id, processed: 0, suggestions: 0, status: 'running' });
      } else {
        const bulkConfig: Record<string, unknown> = {};
        if (opts.from) bulkConfig['date_from'] = opts.from;
        if (opts.to) bulkConfig['date_to'] = opts.to;

        const spinner = p.spinner();
        spinner.start(`Starting scan for: ${targets.join(', ')}...`);
        const result = await client.bulkStartImport(
          targets,
          Object.keys(bulkConfig).length ? bulkConfig : undefined,
        );
        for (const job of result.jobs) {
          jobStates.push({ connector: job.connector_key, jobId: job.id, processed: 0, suggestions: 0, status: 'running' });
        }
        spinner.stop(`Scan run started (${result.jobs.length} jobs)`);
      }

      console.log(chalk.dim('\nStreaming progress - Ctrl+C stops watching (jobs keep running)\n'));

      await Promise.all(jobStates.map(state =>
        new Promise<void>((resolve) => {
          const url = client.getStreamUrl(state.jobId);
          const authHeader = env.authToken ? `Bearer ${env.authToken}` : null;

          // eventsource v3 requires custom fetch to pass auth headers
          const customFetch: typeof globalThis.fetch = (input, init) => {
            const hdrs = new Headers(init?.headers);
            if (authHeader) hdrs.set('Authorization', authHeader);
            if (env.tenantId) hdrs.set('x-tenant-id', env.tenantId);
            return fetch(input, { ...init, headers: hdrs });
          };

          const es = new EventSource(url, { fetch: customFetch });

          es.addEventListener('progress', (e: MessageEvent) => {
            const data = JSON.parse(e.data);
            state.processed = data.itemsProcessed ?? 0;
            state.suggestions = data.suggestionsCreated ?? 0;
            renderProgress(jobStates);
          });

          es.addEventListener('completed', () => {
            state.status = 'completed';
            es.close();
            renderProgress(jobStates);
            resolve();
          });

          es.addEventListener('failed', () => {
            state.status = 'failed';
            es.close();
            resolve();
          });

          es.onerror = () => { es.close(); resolve(); };
        }),
      ));

      console.log('\n');

      const totalSuggestions = jobStates.reduce((s, j) => s + j.suggestions, 0);
      const failed = jobStates.filter(j => j.status === 'failed');

      if (failed.length) {
        console.log(chalk.yellow(`${failed.length} job(s) failed: ${failed.map(j => j.connector).join(', ')}`));
      }

      console.log(chalk.green(`Scan complete. ${totalSuggestions} decision(s) ready to review.`));

      if (!totalSuggestions) {
        console.log(chalk.dim('Nothing new found.\n'));
        return;
      }

      if (opts.approve) {
        const s = p.spinner();
        s.start('Fetching suggestion IDs...');
        const allSuggestions = await Promise.all(jobStates.map(j => client.listSuggestions(j.jobId)));
        const ids = allSuggestions.flat().map(s => s.id);
        s.stop(`Approving ${ids.length} suggestion(s)...`);

        const result = await client.bulkApproveSuggestions(ids);
        if (result.async) {
          console.log(chalk.green(`Approval queued as background job: ${result.job_id}`));
          if (result.stream_url) console.log(chalk.dim(`Stream: ${result.stream_url}`));
          console.log(chalk.dim('Run `align import list` to check progress.\n'));
        } else {
          console.log(chalk.green(`Done. ${result.created_decisions} decision(s) added to the graph.\n`));
        }
      } else {
        console.log(chalk.dim(`Review at: ${resolveAppUrl(env)}/discover`));
        console.log(chalk.dim(`Or approve all: align import --all --approve\n`));
      }
    });

  registerImportListCommands(importCmd);
  registerImportGitCommand(importCmd);
  registerImportGitHubCommand(importCmd);
  registerImportGitLabCommand(importCmd);
  registerImportLinearCommand(importCmd);
  registerImportJiraCommand(importCmd);
  registerImportConfluenceCommand(importCmd);
  registerImportSlackCommand(importCmd);
  registerImportTeamsCommand(importCmd);
  registerImportZoomCommand(importCmd);
  registerImportNotionCommand(importCmd);
}
