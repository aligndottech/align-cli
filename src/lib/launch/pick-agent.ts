import type { AgentName } from '../sessions/types.js';
import { agentByName, type LaunchAgent, supportedAgents } from './agents.js';
import { findOnPath } from './detect.js';

/**
 * The wizard's "which coding agent?" step (C5). It reads the same table and the same PATH scan
 * the launcher does and stores through the same config key, so what the wizard picks is exactly
 * what bare `align` opens afterwards. Only supported agents that are installed are ever offered.
 */
export interface PickAgentDeps {
  env: Record<string, string | undefined>;
  platform: string;
  agents: readonly LaunchAgent[];
  findOnPath(bin: string, env: Record<string, string | undefined>, platform: string): string | null;
  /** Resolves null when the user cancels. Only called on a terminal with several candidates. */
  select(candidates: LaunchAgent[]): Promise<AgentName | null>;
  say(line: string): void;
}

export interface AgentConfig {
  getAgent(): string | undefined;
  setAgent(agent: string): void;
}

async function clackSelect(candidates: LaunchAgent[]): Promise<AgentName | null> {
  const clack = await import('@clack/prompts');
  const answer = await clack.select({
    message: 'Which coding agent should `align` open?',
    options: candidates.map((a) => ({ value: a.name, label: a.label })),
  });
  return clack.isCancel(answer) ? null : (answer as AgentName);
}

function defaultDeps(): PickAgentDeps {
  return {
    env: process.env,
    platform: process.platform,
    agents: supportedAgents(),
    findOnPath,
    select: clackSelect,
    say: (l) => console.log(l),
  };
}

export async function pickAgent(
  config: AgentConfig,
  opts: { interactive: boolean; approve?: boolean },
  overrides: Partial<PickAgentDeps> = {},
): Promise<AgentName | null> {
  const d = { ...defaultDeps(), ...overrides };

  // A re-run keeps the choice; `align use` is the way to change it.
  const stored = agentByName(config.getAgent());
  if (stored && d.agents.some((a) => a.name === stored.name)) return stored.name;

  const installed = d.agents.filter((a) => d.findOnPath(a.bin, d.env, d.platform) !== null);

  if (installed.length === 0) {
    d.say('No coding agent that Align can open was found on your PATH. Align works with:');
    for (const a of d.agents) d.say(`  ${a.label}: ${a.install}`);
    d.say('Install one, then run `align` again.');
    return null;
  }

  let chosen: LaunchAgent | undefined;
  if (installed.length === 1 || opts.approve) {
    chosen = installed[0];
  } else if (opts.interactive) {
    const name = await d.select(installed);
    chosen = installed.find((a) => a.name === name);
  } else {
    d.say(`More than one coding agent is installed (${installed.map((a) => a.label).join(', ')}) and there is no terminal to ask in.`);
    d.say(`Choose one: align use <agent>   (${installed.map((a) => a.name).join(' | ')})`);
    return null;
  }
  if (!chosen) return null;

  config.setAgent(chosen.name);
  if (installed.length === 1) d.say(`Using ${chosen.label}. Switch any time with \`align use\`.`);
  return chosen.name;
}
