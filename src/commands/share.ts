/**
 * `align share` - promote ratified local decisions, with the judgements you made about them, to your
 * team graph. `align push` is the old name and stays as an alias. The flow lives in lib/share/command.ts.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import os from 'node:os';
import { createConfigStore, defaultGatewayUrlFor, type EnvName } from '../lib/config.js';
import { resolveAppUrl } from '../lib/env-resolver.js';
import { tryOpenUrl } from '../lib/open-url.js';
import { abortableSleep } from '../lib/share/approval.js';
import { defaultJudge } from '../lib/curation/judge.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveLocalIdentity } from '../lib/git.js';
import { UnknownEnvError } from '../lib/resolve-env.js';
import { sinceFromFlag } from '../lib/since-flag.js';
import { runShare, type ShareDeps } from '../lib/share/command.js';
import type { ShareClient } from '../lib/share/run.js';
import { shareSalt } from '../lib/share/salt.js';
import { resolveShareEnv, ShareTargetError } from '../lib/share/target.js';
import { ttyConfirm } from '../lib/share/tty.js';

export function registerShareCommand(program: Command): void {
  program
    .command('share [ids...]')
    .alias('push')
    .description('Share ratified local decisions, and your judgements on them, with your team (previewed first; never without a yes)')
    .option('--env <env>', 'Which environment to share to: prod, preview, or a team destination from align join')
    .option('--to <name>', 'Share to this destination instead of your share destination (prod, preview, or a name from align join)')
    .option('--all-ratified', 'Share every decision you ratified')
    .option('--since <window>', 'With --all-ratified or alone: only decisions ratified in this window (30d, 2w, 6m)')
    .option('--yes', 'Not accepted: a share always needs your own answer at a terminal')
    .option('--confirm <code>', 'Finish a share your agent previewed (needs your own terminal; not used when shares are approved in the browser)')
    .option('--no-open', 'Print the approval link without opening a browser')
    .option('--typed', 'Answer at this terminal instead of approving in the browser (not accepted where the workspace requires browser approval)')
    .option('--retract <id>', 'Archive what you shared for this decision on your team graph (a share stays with the team after you leave)')
    .action(async (ids: string[], opts: { env?: EnvName; to?: string; allRatified?: boolean; since?: string; yes?: boolean; confirm?: string; retract?: string; typed?: boolean; open?: boolean }) => {
      if (opts.yes) {
        console.error(chalk.red('align share has no --yes: a share always needs your own answer, typed at a terminal. Nothing was sent.'));
        process.exit(2);
        return;
      }
      if (process.argv[2] === 'push') console.error(chalk.dim('align push is now align share.'));
      const config = createConfigStore();
      // A mistyped --env or --to must not fall back to the default: the destination is the one thing a share must get right.
      let envName: EnvName;
      try {
        envName = resolveShareEnv({ ...(opts.to === undefined ? {} : { to: opts.to }), ...(opts.env === undefined ? {} : { env: opts.env }) }, config, {
          wrapped: (process.env['ALIGN_WRAPPED'] ?? '') !== '',
          tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        });
      } catch (e) {
        if (e instanceof UnknownEnvError || e instanceof ShareTargetError) {
          console.error(chalk.red(e instanceof UnknownEnvError ? `${e.message} Nothing was sent.` : e.message));
          process.exit(2);
          return;
        }
        throw e;
      }
      const local = config.getEnvironment('local');
      const cloudEnv = config.getEnvironment(envName);
      const code = await runShare({
        ids, allRatified: opts.allRatified, confirm: opts.confirm, retract: opts.retract, typed: opts.typed, envName,
        sinceIso: opts.since === undefined ? undefined : sinceFromFlag(opts.since).since,
      }, {
        cloudEnv,
        ...(cloudEnv.kind === 'team' && cloudEnv.appUrl ? { teamAppUrl: cloudEnv.appUrl } : {}),
        salt: shareSalt(),
        defaultGatewayUrl: defaultGatewayUrlFor(envName),
        localDbPath: local.mode === 'local-embedded' ? local.localDbPath ?? null : null,
        client: () => createGatewayClient(cloudEnv) as unknown as ShareClient,
        judge: defaultJudge,
        owner: resolveLocalIdentity,
        ttyConfirm,
        wrapped: (process.env['ALIGN_WRAPPED'] ?? '') !== '',
        approval: {
          appUrl: resolveAppUrl(cloudEnv),
          label: os.hostname(),
          ...(opts.open === false ? {} : { openUrl: (url: string) => tryOpenUrl(url) }),
          sleep: abortableSleep,
          now: () => Date.now(),
          guard: async (run) => {
            const ac = new AbortController();
            const onSigint = (): void => ac.abort();
            process.once('SIGINT', onSigint);
            try { return await run(ac.signal); } finally { process.removeListener('SIGINT', onSigint); }
          },
        },
        out: (l) => console.log(l),
        err: (l) => console.error(chalk.red(l)),
      } satisfies ShareDeps);
      if (code !== 0) process.exit(code);
    });
}
