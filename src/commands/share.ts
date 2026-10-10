/**
 * `align share` - promote ratified local decisions, with the judgements you made about them, to your
 * team graph. `align push` is the old name and stays as an alias. The flow lives in lib/share/command.ts.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { defaultJudge } from '../lib/curation/judge.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveLocalIdentity } from '../lib/git.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { sinceFromFlag } from '../lib/since-flag.js';
import { runShare, type ShareDeps } from '../lib/share/command.js';
import type { ShareClient } from '../lib/share/run.js';

/** Ask on the controlling terminal, not stdin: an agent's shell tool has none. Null when there is none. */
export async function ttyConfirm(question: string): Promise<boolean | null> {
  const dev = process.platform === 'win32' ? ['CONIN$', 'CONOUT$'] : ['/dev/tty', '/dev/tty'];
  let inFd: number; let outFd: number;
  try { inFd = fs.openSync(dev[0]!, 'r'); outFd = fs.openSync(dev[1]!, 'w'); } catch { return null; }
  try {
    const rl = readline.createInterface({ input: fs.createReadStream('', { fd: inFd, autoClose: false }), output: fs.createWriteStream('', { fd: outFd, autoClose: false }) });
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
  } finally { fs.closeSync(inFd); fs.closeSync(outFd); }
}

export function registerShareCommand(program: Command): void {
  program
    .command('share [ids...]')
    .alias('push')
    .description('Share ratified local decisions, and your judgements on them, with your team (previewed first; never without a yes)')
    .option('--env <env>', 'Which team environment to share to (prod, preview)')
    .option('--all-ratified', 'Share every decision you ratified')
    .option('--since <window>', 'With --all-ratified or alone: only decisions ratified in this window (30d, 2w, 6m)')
    .option('--yes', 'Skip the question (needed when there is no terminal)')
    .option('--confirm <code>', 'Finish a share your agent previewed (needs your own terminal)')
    .option('--retract <id>', 'Archive what you shared for this decision on your team graph')
    .action(async (ids: string[], opts: { env?: EnvName; allRatified?: boolean; since?: string; yes?: boolean; confirm?: string; retract?: string }) => {
      if (process.argv[2] === 'push') console.error(chalk.dim('align push is now align share.'));
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const local = config.getEnvironment('local');
      const cloudEnv = config.getEnvironment(envName);
      const code = await runShare({
        ids, allRatified: opts.allRatified, yes: opts.yes, confirm: opts.confirm, retract: opts.retract, envName,
        sinceIso: opts.since === undefined ? undefined : sinceFromFlag(opts.since).since,
      }, {
        cloudEnv,
        localDbPath: local.mode === 'local-embedded' ? local.localDbPath ?? null : null,
        client: () => createGatewayClient(cloudEnv) as unknown as ShareClient,
        judge: defaultJudge,
        owner: resolveLocalIdentity,
        stdinIsTty: process.stdin.isTTY === true,
        ttyConfirm,
        ask: async (q) => { const a = await p.confirm({ message: q, initialValue: false }); return a === true; },
        out: (l) => console.log(l),
        err: (l) => console.error(chalk.red(l)),
      } satisfies ShareDeps);
      if (code !== 0) process.exit(code);
    });
}
