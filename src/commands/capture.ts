import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveAppUrl } from '../lib/env-resolver.js';

// Display label only - gateway's registry.resolveUrl() handles real detection
function labelFromUrl(input: string): string {
  if (/slack\.com/.test(input)) return 'slack';
  if (/atlassian\.net\/browse/.test(input)) return 'jira';
  if (/atlassian\.net\/wiki/.test(input)) return 'confluence';
  if (/github\.com/.test(input)) return 'github';
  if (/teams\.microsoft\.com/.test(input)) return 'teams';
  if (/zoom\.us/.test(input)) return 'zoom';
  if (/linear\.app/.test(input)) return 'linear';
  return 'web';
}

function isUrl(input: string): boolean {
  try { new URL(input); return true; } catch { return false; }
}

export function registerCaptureCommand(program: Command): void {
  program
    .command('capture <url>')
    .description('Capture a decision from a URL (Slack/Jira/GitHub/Confluence/etc.)')
    .option('--env <env>', 'Environment')
    .action(async (input: string, opts: { env: EnvName }) => {
      if (!isUrl(input)) {
        console.error(chalk.red('capture requires a URL. Raw text capture is not yet supported.'));
        process.exit(1);
      }

      const config = createConfigStore();
      const env = config.getEnvironment(resolveEnv(opts.env));
      const client = createGatewayClient(env);
      const platform = labelFromUrl(input);

      const spinner = ora(`Fetching from ${platform} and extracting decisions...`).start();

      try {
        const decision = await client.captureDecision(input, platform);
        spinner.succeed(chalk.green('Decision captured'));

        console.log('');
        console.log(`  ${chalk.bold('ID:')}       ${decision.id}`);
        console.log(`  ${chalk.bold('Title:')}    ${decision.title}`);
        console.log(`  ${chalk.bold('Summary:')}  ${decision.summary}`);
        console.log(`  ${chalk.bold('Platform:')} ${decision.platform}`);
        if (decision.ai?.risks?.length) {
          console.log(`  ${chalk.bold('Risks:')}    ${decision.ai.risks.slice(0, 2).join('; ')}`);
        }
        console.log('');
        console.log(chalk.dim(`View: ${resolveAppUrl(env)}/decisions/${decision.id}`));
        console.log('');
      } catch (err) {
        const msg = (err as Error).message;
        spinner.fail(chalk.red(msg));
        if (msg.includes('503') || msg.includes('connector') || msg.includes('token')) {
          console.log(
            chalk.dim(
              `\nMake sure the ${platform} connector is enabled: ${chalk.bold(`align connector enable ${platform} --env ${opts.env}`)}`,
            ),
          );
        }
        process.exit(1);
      }
    });
}
