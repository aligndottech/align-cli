import type { Command } from 'commander';
import { agentByName, LAUNCH_AGENTS } from '../lib/launch/agents.js';
import { findOnPath } from '../lib/launch/detect.js';

export interface UseDeps {
  config: { getAgent(): string | undefined; setAgent(agent: string): void };
  findOnPath(bin: string, env: Record<string, string | undefined>, platform: string): string | null;
  env: Record<string, string | undefined>;
  platform: string;
  log(line: string): void;
  err(line: string): void;
}

/**
 * `align use [agent]`: switch which coding agent bare `align` opens. Nobody has to run it
 * first - bare `align` picks the one agent it finds - so this is only for changing later.
 * Returns the exit code.
 */
export async function runUse(name: string | undefined, d: UseDeps): Promise<number> {
  if (name === undefined) {
    const current = agentByName(d.config.getAgent());
    d.log(current ? `Agent: ${current.name} (${current.label})` : 'No agent chosen yet. Bare `align` picks one automatically when it finds a supported agent on your PATH.');
    return 0;
  }
  const agent = agentByName(name);
  if (!agent) {
    d.err(`error: unknown agent '${name}'. Choose one of: ${LAUNCH_AGENTS.map((a) => a.name).join(', ')}`);
    return 1;
  }
  if (!agent.supported) {
    d.err(`${agent.label} launching is coming soon. Nothing changed.`);
    return 1;
  }
  if (!d.findOnPath(agent.bin, d.env, d.platform)) {
    d.err(`${agent.bin} is not on your PATH. Install it (${agent.install}), then run this again. Nothing changed.`);
    return 1;
  }
  d.config.setAgent(agent.name);
  d.log(`Bare \`align\` now opens ${agent.label}.`);
  return 0;
}

export function registerUseCommand(program: Command): void {
  program
    .command('use [agent]')
    .description('Choose the coding agent bare `align` opens (no argument shows the current one)')
    .action(async (agent: string | undefined) => {
      const { createConfigStore } = await import('../lib/config.js');
      const code = await runUse(agent, {
        config: createConfigStore(),
        findOnPath,
        env: process.env,
        platform: process.platform,
        log: (l) => console.log(l),
        err: (l) => console.error(l),
      });
      if (code !== 0) process.exit(code);
    });
}
