import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { LaunchSpec } from './adapters/claude-code.js';

export interface RunDeps {
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  platform: string;
  /** The process whose signals are forwarded. A parameter so tests need not signal themselves. */
  proc: Pick<typeof process, 'on' | 'off'>;
}

// cmd.exe re-parses the whole line, so these would run a second command or expand a variable.
const WIN_SHELL_CHARS = /[&|<>^%"]/;

/** One CRT-quoted argument: trailing backslashes are doubled so they cannot escape the closing quote. */
const winQuote = (a: string): string => `"${a.replace(/(\\+)$/, '$1$1')}"`;

export function winShimCommand(spec: Pick<LaunchSpec, 'bin' | 'args'>): { command: string; args: string[] } {
  const binHit = WIN_SHELL_CHARS.exec(spec.bin);
  if (binHit) throw new Error(`the path to ${path.win32.basename(spec.bin)} (${spec.bin}) holds the shell character ${binHit[0]}, which cmd.exe would interpret. Move or reinstall the agent to a path without it.`);
  spec.args.forEach((arg, i) => {
    const hit = WIN_SHELL_CHARS.exec(arg);
    if (hit) {
      throw new Error(`refusing argument ${i + 1} ("${arg}"): it holds the shell character ${hit[0]}, which cmd.exe would interpret. Passing arguments after \`align --\` has this limit on Windows; run the agent directly for this one.`);
    }
  });
  const line = [spec.bin, ...spec.args].map(winQuote).join(' ');
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`] };
}

/**
 * Run the agent with the terminal handed to it and resolve with the exit code align should
 * leave with. align stays alive until the child is gone:
 *  - SIGINT: the tty already delivered Ctrl-C to the child's process group, so align only
 *    has to not die first (a handler that does nothing keeps it alive). A SIGINT sent to align
 *    ALONE (kill -INT <pid>) is deliberately not forwarded: forwarding would double-deliver the
 *    far more common tty Ctrl-C, which reaches both processes, and the agent would see two.
 *  - SIGTERM / SIGHUP / SIGQUIT: nobody else will tell the child, so forward them rather than
 *    orphan it.
 * A child that dies by signal maps to 128+signal, the shell convention.
 */
export async function runAgent(spec: LaunchSpec, deps: Partial<RunDeps> = {}): Promise<number> {
  const spawn = deps.spawn ?? nodeSpawn;
  const platform = deps.platform ?? process.platform;
  const proc = deps.proc ?? process;
  const isShim = platform === 'win32' && /\.(cmd|bat)$/i.test(spec.bin);
  const { command, args } = isShim ? winShimCommand(spec) : { command: spec.bin, args: spec.args };
  const options: SpawnOptions = { stdio: 'inherit', env: { ...process.env, ...spec.env } };
  if (isShim) options.windowsVerbatimArguments = true;

  const child = spawn(command, args, options);
  const forward = (sig: 'SIGTERM' | 'SIGHUP' | 'SIGQUIT') => () => { child.kill(sig); };
  const onTerm = forward('SIGTERM');
  const onHup = forward('SIGHUP');
  const onQuit = forward('SIGQUIT');
  const onInt = (): void => {};
  proc.on('SIGTERM', onTerm);
  proc.on('SIGHUP', onHup);
  proc.on('SIGQUIT', onQuit);
  proc.on('SIGINT', onInt);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal) resolve(128 + (os.constants.signals[signal] ?? 0));
        else resolve(code ?? 1);
      });
    });
  } finally {
    proc.off('SIGTERM', onTerm);
    proc.off('SIGHUP', onHup);
    proc.off('SIGQUIT', onQuit);
    proc.off('SIGINT', onInt);
  }
}
