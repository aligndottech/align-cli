import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import os from 'node:os';
import type { LaunchSpec } from './adapters/claude-code.js';

export interface RunDeps {
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  platform: string;
  /** The process whose signals are forwarded. A parameter so tests need not signal themselves. */
  proc: Pick<typeof process, 'on' | 'off'>;
}

// cmd.exe re-parses the whole line, so these would run a second command or expand a variable.
const WIN_SHELL_CHARS = /[&|<>^%"]/;

function winShimCommand(spec: LaunchSpec): { command: string; args: string[] } {
  for (const arg of spec.args) {
    const hit = WIN_SHELL_CHARS.exec(arg);
    if (hit) throw new Error(`refusing argument "${arg}": it holds the shell character ${hit[0]}, which cmd.exe would interpret. Run the agent directly for this one.`);
  }
  const line = [spec.bin, ...spec.args].map((a) => `"${a}"`).join(' ');
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`] };
}

/**
 * Run the agent with the terminal handed to it and resolve with the exit code align should
 * leave with. align stays alive until the child is gone:
 *  - SIGINT: the tty already delivered Ctrl-C to the child's process group, so align only
 *    has to not die first (a handler that does nothing keeps it alive).
 *  - SIGTERM / SIGHUP: nobody else will tell the child, so forward them.
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
  const forward = (sig: 'SIGTERM' | 'SIGHUP') => () => { child.kill(sig); };
  const onTerm = forward('SIGTERM');
  const onHup = forward('SIGHUP');
  const onInt = (): void => {};
  proc.on('SIGTERM', onTerm);
  proc.on('SIGHUP', onHup);
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
    proc.off('SIGINT', onInt);
  }
}
