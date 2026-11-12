import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveAppUrl } from '../lib/env-resolver.js';
import { recordFunnelStage } from '../lib/usage-telemetry.js';
import { backlogOffer } from '../lib/backlog/offer.js';
import { backlogPaths, backlogRepoKey, connectedTrackers } from '../lib/backlog/deps.js';
import { getSavedTarget } from '../lib/backlog/targets.js';
import { inHookContext } from '../lib/hook-context.js';
import { inCi } from '../lib/telemetry-ci.js';

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

/** One line, after a capture, never an error: the offer is a courtesy and a capture that worked must not fail on it. */
async function offerBacklog(config: ReturnType<typeof createConfigStore>, envName: EnvName, decision: Parameters<typeof backlogOffer>[0]['decision']): Promise<void> {
  try {
    const envNames: EnvName[] = envName === 'local' ? ['local'] : [envName, 'local'];
    const saved = getSavedTarget(backlogPaths().targetsPath, await backlogRepoKey())?.tracker;
    const offer = backlogOffer({
      env: process.env, tty: Boolean(process.stdin.isTTY && process.stdout.isTTY), inCi: inCi(), inHook: inHookContext(),
      enabled: config.getBacklogOffer(), count: 1, decision, trackers: connectedTrackers(config, envNames), saved,
    });
    if ('line' in offer) { console.log(chalk.dim(offer.line)); console.log(''); }
  } catch {
    // Nothing to say: the capture itself has already been reported.
  }
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
      // preferLocalEmbedded: the local client serves capture, so a no-account
      // user's `align capture` must land in their local graph, not 401 against
      // the unauthenticated cloud default.
      const envName = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);
      const platform = labelFromUrl(input);

      const spinner = ora(`Fetching from ${platform} and extracting decisions...`).start();

      try {
        const decision = await client.captureDecision(input, platform);
        spinner.succeed(chalk.green('Decision captured'));
        // The first capture on this install is a funnel stage. Once-per-install is guarded in the
        // emitter; not awaited, so a slow gateway never delays the command's output.
        void recordFunnelStage(env, 'first_capture', 'capture');

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
        await offerBacklog(config, envName, decision);
      } catch (err) {
        const msg = (err as Error).message;
        // The gateway answers 422 unsupported_source for a link it cannot read (no
        // connector for it, or no way to fetch it). Say so plainly and exit non-zero; nothing
        // was saved, so there is no decision to show.
        if ((err as { statusCode?: number }).statusCode === 422 && /unsupported_source/.test(msg)) {
          spinner.fail(chalk.red(`Align cannot read ${input} (${platform} links are not supported for capture).`));
          console.log(chalk.dim('Nothing was saved. Supported: Slack, Jira, Confluence, GitHub, Teams, Zoom. Capture other text with the MCP capture tool.'));
          process.exit(1);
        }
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
