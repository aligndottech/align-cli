import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { AgentSpec } from './registry/types.js';
import { winShimCommand } from './run-agent.js';

/**
 * How an agent is installed (plan Decision 4). `npm`: one package-manager argv, which Align may
 * run after the user says yes. `docs`: a script or URL installer; piping a remote script into a
 * shell is the user's decision, so Align only ever prints it.
 */
export type AgentInstall = { kind: 'npm'; argv: readonly string[] } | { kind: 'docs'; url: string; text?: string };
export type InstallOutcome = 'installed' | 'declined' | 'manual' | 'failed';

export interface InstallOfferDeps {
  isTTY: boolean;
  platform: string;
  /** Resolves true only on an explicit yes. The prompt's default must be No. */
  confirm(message: string): Promise<boolean>;
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
  onPath(bin: string): string | null;
  say(line: string): void;
}

export function installText(i: AgentInstall): string {
  return i.kind === 'npm' ? i.argv.join(' ') : (i.text ?? i.url);
}

/**
 * Offer to install an agent the user picked. Never runs anything without a TTY and a yes, and
 * never runs a script or URL installer. The argv runs with no shell, output visible.
 */
export async function offerInstall(spec: Pick<AgentSpec, 'label' | 'install'>, d: InstallOfferDeps): Promise<InstallOutcome> {
  const text = installText(spec.install);
  const manager = spec.install.kind === 'npm' ? d.onPath(spec.install.argv[0]!) : null;
  if (spec.install.kind !== 'npm' || !d.isTTY || !manager) {
    d.say(`${spec.label} is not installed. Install it with: ${text}`);
    return 'manual';
  }
  if (!(await d.confirm(`Install ${spec.label} now? (runs: ${text})`))) return 'declined';

  const [bin, ...args] = spec.install.argv as [string, ...string[]];
  // npm on Windows is npm.cmd, which cannot be spawned without a shell: go through the same
  // quoted cmd.exe line the agent launch uses, rather than handing the argv to a shell.
  const shim = d.platform === 'win32' && /\.(cmd|bat)$/i.test(manager);
  const cmd = shim ? winShimCommand({ bin: manager, args }) : { command: bin, args };
  const options: SpawnOptions = { shell: false, stdio: 'inherit' };
  if (shim) options.windowsVerbatimArguments = true;
  let code: number;
  try {
    code = await new Promise<number>((resolve, reject) => {
      const child = d.spawn(cmd.command, cmd.args, options);
      child.on('error', reject);
      child.on('exit', (c: number | null) => resolve(c ?? 1));
    });
  } catch (e) {
    d.say(`Could not run ${text} (${(e as Error).message}). ${spec.label} is not installed.`);
    return 'failed';
  }
  if (code !== 0) {
    d.say(`${bin} exited ${code}. ${spec.label} is not installed.`);
    return 'failed';
  }
  return 'installed';
}
