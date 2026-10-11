import type { Command } from 'commander';
import readline from 'node:readline';
import { CLI_CALLBACK_PORTS, waitForCallback } from '../lib/cli-oauth.js';
import { createConfigStore } from '../lib/config.js';
import { type JoinDeps, runJoin } from '../lib/join-flow.js';
import { tryOpenUrl } from '../lib/open-url.js';

const ASK_TIMEOUT_MS = 5 * 60_000;

function ask(question: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Resolve FIRST: close() emits 'close' synchronously, and that handler resolves null. Closing first made every answer null.
    const done = (v: string | null) => { resolve(v); rl.close(); };
    rl.once('close', () => resolve(null));
    rl.question(question, (a) => done(a));
  });
}

export function realJoinDeps(): JoinDeps {
  return {
    config: createConfigStore(),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    wrapped: (process.env['ALIGN_WRAPPED'] ?? '') !== '',
    out: (l) => console.log(l),
    openUrl: (u) => tryOpenUrl(u),
    promptLine: ask,
    confirm: async (q) => /^y(es)?$/i.test((await ask(`${q} [y/N] `))?.trim() ?? ''),
    waitForCallback,
    now: () => new Date(),
    callbackPorts: CLI_CALLBACK_PORTS,
    timeoutMs: ASK_TIMEOUT_MS,
  };
}

export function registerJoinCommand(program: Command): void {
  program
    .command('join <link>')
    .description("Join your team's graph from an invite link, as a named destination (a terminal only; additive: nothing you already have is moved)")
    .option('--name <name>', 'What to call this destination (default: made from the org name)')
    .option('--gateway <url>', 'The server address, for a link that does not carry one')
    .option('--replace', 'Replace an existing destination of the same name (asks you to type the new host)')
    .action(async (link: string, opts: { name?: string; gateway?: string; replace?: boolean }) => {
      const result = await runJoin(realJoinDeps(), {
        link,
        ...(opts.name === undefined ? {} : { name: opts.name }),
        ...(opts.gateway === undefined ? {} : { gateway: opts.gateway }),
        ...(opts.replace === undefined ? {} : { replace: opts.replace }),
      });
      if (!result.ok) process.exitCode = 1;
    });
}
