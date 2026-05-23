import { resolveEnv } from '../../lib/resolve-env.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { renderTable } from '../../lib/table.js';
import { streamDockerLogs, streamKubectlLogs } from '../../lib/process.js';

export function registerConnectorCommands(program: Command): void {
  const connector = program
    .command('connector')
    .description('Manage connectors (Slack, Jira, GitHub, etc.)');

  connector
    .command('list')
    .description('List all connectors and their status')
    .option('--env <env>', 'Environment')
    .action(async (opts: { env: EnvName }) => {
      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(resolveEnv(opts.env)));
      const spinner = ora('Fetching connectors...').start();

      try {
        const connectors = await client.listConnectors();
        spinner.stop();

        if (!connectors.length) {
          console.log(chalk.dim('\nNo connectors configured.\n'));
          return;
        }

        console.log(chalk.bold(`\nConnectors (${opts.env})\n`));
        renderTable(
          [
            { header: 'KEY', width: 20 },
            { header: 'NAME', width: 24 },
            {
              header: 'STATUS', width: 12,
              color: (v) => {
                const t = v.trim();
                if (t === 'active') return chalk.green(v);
                if (t === 'error') return chalk.red(v);
                return chalk.dim(v);
              },
            },
            { header: 'CONFIGURED', width: 12 },
          ],
          connectors.map(c => [c.key, c.name, c.status, c.configured ? 'yes' : 'no']),
        );
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  connector
    .command('enable <name>')
    .description('Enable a connector by initiating OAuth')
    .option('--env <env>', 'Environment')
    .action(async (name: string, opts: { env: EnvName }) => {
      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(resolveEnv(opts.env)));

      const spinner = ora(`Starting OAuth for ${name}...`).start();
      try {
        const { authUrl } = await client.startOAuth(name);
        spinner.stop();
        console.log(chalk.dim(`\nOpening browser to authorize ${name}...\n`));
        console.log(chalk.bold('Authorization URL:'));
        console.log(authUrl);
        console.log('');
        await open(authUrl).catch(() => {
          console.log(chalk.dim('(Could not open browser - copy the URL above)'));
        });
        p.log.info(`After authorizing, run: align connector status ${name} --env ${opts.env}`);
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  connector
    .command('disable <name>')
    .description('Disable a connector')
    .option('--env <env>', 'Environment')
    .action(async (name: string, opts: { env: EnvName }) => {
      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(resolveEnv(opts.env)));

      const confirmed = await p.confirm({
        message: `Disable ${name} connector in ${opts.env}?`,
      });
      if (!confirmed || p.isCancel(confirmed)) { p.cancel('Cancelled.'); return; }

      const spinner = ora(`Disabling ${name}...`).start();
      try {
        await client.disableConnector(name);
        spinner.succeed(chalk.green(`${name} disabled`));
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  connector
    .command('status <name>')
    .description('Show health and OAuth status for a connector')
    .option('--env <env>', 'Environment')
    .action(async (name: string, opts: { env: EnvName }) => {
      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(resolveEnv(opts.env)));
      const spinner = ora(`Checking ${name}...`).start();

      try {
        const health = await client.getConnectorHealth(name);
        spinner.stop();

        const statusColor = health.status === 'healthy' ? chalk.green : chalk.red;
        console.log(`\n  ${chalk.bold('Connector:')} ${name}`);
        console.log(`  ${chalk.bold('Status:')}    ${statusColor(health.status)}`);
        console.log(`  ${chalk.bold('Env:')}       ${opts.env}`);
        console.log('');
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  connector
    .command('logs <name>')
    .description('Stream logs for a connector (requires kubectl or docker)')
    .option('--env <env>', 'Environment')
    .option('--namespace <ns>', 'Kubernetes namespace', 'align-local')
    .option('--docker', 'Use docker logs instead of kubectl')
    .action(async (name: string, opts: { env: EnvName; namespace: string; docker: boolean }) => {
      console.log(chalk.dim(`Streaming logs for ${name} (Ctrl+C to stop)...\n`));
      try {
        if (opts.docker) {
          await streamDockerLogs(`mcp-${name}`);
        } else {
          await streamKubectlLogs(name, opts.namespace);
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
