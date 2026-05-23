import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { execa } from 'execa';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfigStore } from '../../lib/config.js';
import { resolveOAuthRedirectUri, resolveWebhookUrl } from '../../lib/env-resolver.js';
import {
  getNgrokTunnelUrl,
  isDockerRunning,
  isK3dRunning,
  isNgrokInstalled,
} from '../../lib/process.js';
import { SLACK_REQUIRED_SCOPES } from '../../types.js';

const REQUIRED_SLACK_ENV_VARS = [
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_SIGNING_SECRET',
];

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, 'utf-8').split('\n');
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return env;
}

function updateEnvVar(envPath: string, key: string, value: string): void {
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  writeFileSync(envPath, content);
}

export function registerDevCommands(program: Command): void {
  const dev = program
    .command('dev')
    .description('Local development commands');

  dev
    .command('setup')
    .description('Interactive wizard to set up local Slack development')
    .action(async () => {
      p.intro(chalk.bgBlue.white(' align dev setup '));

      const config = createConfigStore();
      const repoRoot = process.cwd();
      const envPath = join(repoRoot, '.env');

      // 1. Check runtime environment
      const [k3d, docker] = await Promise.all([isK3dRunning(), isDockerRunning()]);

      p.log.info(`Runtime: k3d ${k3d ? chalk.green('running') : chalk.dim('not running')}, docker ${docker ? chalk.green('running') : chalk.dim('not running')}`);

      if (!k3d && !docker) {
        const choice = await p.select({
          message: 'No local stack running. Start with:',
          options: [
            { value: 'k3d', label: 'k3d + Tilt (recommended)' },
            { value: 'docker', label: 'Docker Compose (simpler)' },
            { value: 'skip', label: 'Skip - I will start it manually' },
          ],
        });
        if (p.isCancel(choice)) { p.cancel('Cancelled.'); process.exit(0); }
        if (choice === 'k3d') {
          p.log.step('Run: make k3d-start && tilt up');
        } else if (choice === 'docker') {
          p.log.step('Run: make docker-up');
        }
      }

      // 2. Check .env file
      const envExists = existsSync(envPath);
      if (!envExists) {
        p.log.warn('.env not found. Creating from .env.example...');
        const examplePath = join(repoRoot, '.env.example');
        if (existsSync(examplePath)) {
          const example = readFileSync(examplePath, 'utf-8');
          writeFileSync(envPath, example);
          p.log.success('.env created from .env.example');
        } else {
          p.log.warn('.env.example not found. Create .env manually.');
        }
      }

      const currentEnv = loadEnvFile(envPath);
      const missingVars = REQUIRED_SLACK_ENV_VARS.filter(v => !currentEnv[v] || currentEnv[v] === `your_${  v.toLowerCase()}`);

      if (missingVars.length) {
        p.log.warn(`Missing Slack credentials: ${missingVars.join(', ')}`);
        p.note(
          'Get these from https://api.slack.com/apps\nCreate a new app or use an existing one.',
          'Slack App Credentials',
        );

        for (const varName of missingVars) {
          const value = await p.text({
            message: `${varName}:`,
            validate: (v) => !v.trim() ? 'Required' : undefined,
          });
          if (p.isCancel(value)) { p.cancel('Cancelled.'); process.exit(0); }
          updateEnvVar(envPath, varName, value as string);
        }
        p.log.success('Credentials saved to .env');
      } else {
        p.log.success('Slack credentials already configured');
      }

      // 3. ngrok setup
      const wantNgrok = await p.confirm({ message: 'Set up ngrok tunnel for OAuth callbacks and webhooks?' });
      if (p.isCancel(wantNgrok)) { p.cancel('Cancelled.'); process.exit(0); }

      let ngrokUrl: string | null = null;

      if (wantNgrok) {
        const ngrokInstalled = await isNgrokInstalled();
        if (!ngrokInstalled) {
          p.log.warn('ngrok is not installed. Install: https://ngrok.com/download');
          p.note('After installing ngrok, run: align dev setup again', 'Next step');
          process.exit(0);
        }

        // Check if ngrok is already running
        ngrokUrl = await getNgrokTunnelUrl();
        if (ngrokUrl) {
          p.log.success(`ngrok already running: ${ngrokUrl}`);
        } else {
          p.log.step('Starting ngrok tunnel on port 8080...');
          // Start ngrok in background
          const ngrokProc = execa('ngrok', ['http', '8080'], { detached: true, stdio: 'ignore' });
          ngrokProc.unref();

          const spinner = p.spinner();
          spinner.start('Waiting for ngrok tunnel...');
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            ngrokUrl = await getNgrokTunnelUrl();
            if (ngrokUrl) break;
          }
          spinner.stop(ngrokUrl ? `Tunnel started: ${ngrokUrl}` : 'Could not get ngrok URL');
        }

        if (ngrokUrl) {
          config.setNgrokUrl(ngrokUrl);
          updateEnvVar(envPath, 'SLACK_REDIRECT_URI', `${ngrokUrl}/oauth/callback/slack`);
          p.log.success('.env updated with ngrok URL');
        }
      }

      const localEnv = config.getEnvironment('local');
      if (ngrokUrl) localEnv.ngrokUrl = ngrokUrl;

      // 4. Print Slack app configuration instructions
      const redirectUri = resolveOAuthRedirectUri('slack', localEnv);
      const webhookUrl = resolveWebhookUrl('slack', localEnv);

      p.note(
        [
          `${chalk.bold('OAuth Redirect URL')} (add to Slack app):`,
          `  ${chalk.cyan(redirectUri)}`,
          '',
          `${chalk.bold('Events API Request URL')} (add to Slack app):`,
          `  ${chalk.cyan(webhookUrl)}`,
          '',
          `${chalk.bold('Required Bot Token Scopes')} (add in Slack app OAuth & Permissions):`,
          SLACK_REQUIRED_SCOPES.map(s => `  ${s}`).join('\n'),
        ].join('\n'),
        'Configure your Slack app',
      );

      p.outro(chalk.green('Setup complete. Run: tilt up (or make docker-up)'));
    });

  dev
    .command('start')
    .description('Start the local development stack')
    .option('--mode <mode>', 'Stack mode: k3d or docker', 'k3d')
    .option('--minimal', 'Start gateway only (no tilt)')
    .action(async (opts: { mode: string; minimal: boolean }) => {
      if (opts.mode === 'docker') {
        console.log(chalk.dim('Starting Docker Compose stack...'));
        await execa('make', ['docker-up'], { stdout: process.stdout, stderr: process.stderr });
      } else {
        if (!opts.minimal) {
          console.log(chalk.dim('Starting k3d cluster...'));
          await execa('make', ['k3d-start'], { stdout: process.stdout, stderr: process.stderr });
        }
        console.log(chalk.dim('Starting Tilt...'));
        await execa('tilt', ['up'], { stdout: process.stdout, stderr: process.stderr });
      }
    });

  dev
    .command('stop')
    .description('Stop the local development stack')
    .option('--mode <mode>', 'Stack mode: k3d or docker', 'k3d')
    .action(async (opts: { mode: string }) => {
      if (opts.mode === 'docker') {
        await execa('make', ['docker-down'], { stdout: process.stdout, stderr: process.stderr });
      } else {
        await execa('tilt', ['down'], { stdout: process.stdout, stderr: process.stderr });
      }
    });

  dev
    .command('status')
    .description('Show health of local services')
    .action(async () => {
      const endpoints = [
        { name: 'Gateway', url: 'http://localhost:8080/health' },
        { name: 'Brain', url: 'http://localhost:8090/health' },
        { name: 'Slack connector', url: 'http://localhost:8081/health' },
        { name: 'Jira connector', url: 'http://localhost:8083/health' },
        { name: 'GitHub connector', url: 'http://localhost:8085/health' },
      ];

      console.log(chalk.bold('\nLocal service health:\n'));

      await Promise.all(endpoints.map(async (ep) => {
        try {
          const res = await fetch(ep.url, { signal: AbortSignal.timeout(2000) });
          const ok = res.ok;
          console.log(`  ${ok ? chalk.green('UP') : chalk.red('DOWN')}  ${ep.name.padEnd(20)} ${chalk.dim(ep.url)}`);
        } catch {
          console.log(`  ${chalk.dim('N/A')}  ${ep.name.padEnd(20)} ${chalk.dim(ep.url)}`);
        }
      }));

      console.log('');
    });
}
