/**
 * `align share` - promote ratified local decisions, with the judgements you made about them, to your
 * team graph. `align push` is the old name and stays as an alias. The flow lives in lib/share/command.ts.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { createConfigStore, defaultGatewayUrlFor, type EnvName } from '../lib/config.js';
import { defaultJudge } from '../lib/curation/judge.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveLocalIdentity } from '../lib/git.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { sinceFromFlag } from '../lib/since-flag.js';
import { runShare, type ShareDeps } from '../lib/share/command.js';
import type { ShareClient } from '../lib/share/run.js';
import { ttyConfirm } from '../lib/share/tty.js';

export function registerShareCommand(program: Command): void {
  program
    .command('share [ids...]')
    .alias('push')
    .description('Share ratified local decisions, and your judgements on them, with your team (previewed first; never without a yes)')
    .option('--env <env>', 'Which team environment to share to (prod, preview)')
    .option('--all-ratified', 'Share every decision you ratified')
    .option('--since <window>', 'With --all-ratified or alone: only decisions ratified in this window (30d, 2w, 6m)')
    .option('--yes', 'Not accepted: a share always needs your own answer at a terminal')
    .option('--confirm <code>', 'Finish a share your agent previewed (needs your own terminal)')
    .option('--retract <id>', 'Archive what you shared for this decision on your team graph')
    .action(async (ids: string[], opts: { env?: EnvName; allRatified?: boolean; since?: string; yes?: boolean; confirm?: string; retract?: string }) => {
      if (opts.yes) {
        console.error(chalk.red('align share has no --yes: a share always needs your own answer, typed at a terminal. Nothing was sent.'));
        process.exit(2);
        return;
      }
      if (process.argv[2] === 'push') console.error(chalk.dim('align push is now align share.'));
      // A mistyped --env must not fall back to the default: the destination is the one thing a share must get right.
      if (opts.env !== undefined && opts.env !== 'prod' && opts.env !== 'preview') {
        console.error(chalk.red(`Unknown environment "${String(opts.env).slice(0, 20)}". Use --env prod or --env preview. Nothing was sent.`));
        process.exit(2);
        return;
      }
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const local = config.getEnvironment('local');
      const cloudEnv = config.getEnvironment(envName);
      const code = await runShare({
        ids, allRatified: opts.allRatified, confirm: opts.confirm, retract: opts.retract, envName,
        sinceIso: opts.since === undefined ? undefined : sinceFromFlag(opts.since).since,
      }, {
        cloudEnv,
        salt: config.getInstallId(),
        defaultGatewayUrl: defaultGatewayUrlFor(envName),
        localDbPath: local.mode === 'local-embedded' ? local.localDbPath ?? null : null,
        client: () => createGatewayClient(cloudEnv) as unknown as ShareClient,
        judge: defaultJudge,
        owner: resolveLocalIdentity,
        ttyConfirm,
        wrapped: (process.env['ALIGN_WRAPPED'] ?? '') !== '',
        out: (l) => console.log(l),
        err: (l) => console.error(chalk.red(l)),
      } satisfies ShareDeps);
      if (code !== 0) process.exit(code);
    });
}
