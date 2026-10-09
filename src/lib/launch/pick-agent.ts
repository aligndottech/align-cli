import type { LaunchAgentId } from './registry/types.js';
import { agentByName, byPriority, type LaunchAgent, PRE_WAVE_A, resolveAgentBin, supportedAgents } from './agents.js';
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
  select(candidates: LaunchAgent[]): Promise<LaunchAgentId | null>;
  say(line: string): void;
}

/** The user cancelled the picker: the wizard stops, like any other cancelled prompt. */
export const PICK_CANCELLED = 'cancelled' as const;

export interface AgentConfig {
  getAgent(): string | undefined;
  setAgent(agent: string): void;
  isLaunchOff?(): boolean;
}

async function clackSelect(candidates: LaunchAgent[]): Promise<LaunchAgentId | null> {
  const clack = await import('@clack/prompts');
  const answer = await clack.select({
    message: 'Which coding agent should `align` open?',
    options: candidates.map((a) => ({ value: a.name, label: a.label })),
  });
  return clack.isCancel(answer) ? null : (answer as LaunchAgentId);
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
): Promise<LaunchAgentId | null | typeof PICK_CANCELLED> {
  const d = { ...defaultDeps(), ...overrides };

  const installed = d.agents.filter((a) => resolveAgentBin(a, d.findOnPath, d.env, d.platform) !== null);

  // A re-run keeps the choice, provided it can still be launched; `align use` changes it. A
  // stored agent that has left PATH is treated as no choice at all.
  const stored = agentByName(config.getAgent());
  if (stored && installed.some((a) => a.name === stored.name)) return stored.name;

  if (installed.length === 0) {
    d.say('No coding agent that Align can open was found on your PATH. Align works with:');
    for (const a of d.agents) d.say(`  ${a.label}: ${a.install}`);
    d.say('Install one, then run `align` again.');
    return null;
  }

  // Without a terminal and without --approve, only the agents launchable before wave A are
  // weighed when any is installed: a machine with Claude Code plus Codex picks Claude Code, as it
  // did before Codex could be launched, and two older agents still are not guessed between.
  const preWaveA = installed.filter((a) => PRE_WAVE_A.has(a.name));
  const unattended = !opts.interactive && !opts.approve && preWaveA.length > 0 ? preWaveA : installed;

  let chosen: LaunchAgent | undefined;
  if (opts.approve) {
    chosen = byPriority(installed)[0];
  } else if (unattended.length === 1) {
    chosen = unattended[0];
  } else if (opts.interactive) {
    const name = await d.select(installed);
    if (name === null) return PICK_CANCELLED;
    chosen = installed.find((a) => a.name === name);
  } else {
    d.say(`More than one coding agent is installed (${installed.map((a) => a.label).join(', ')}) and there is no terminal to ask in.`);
    d.say(`Choose one: align use <agent>   (${installed.map((a) => a.name).join(' | ')})`);
    return null;
  }
  if (!chosen) return null;

  const wasOff = config.isLaunchOff?.() === true;
  config.setAgent(chosen.name);
  if (wasOff) d.say('Launching is on again: `align use --undo` had turned it off.');
  if (installed.length === 1 || unattended.length === 1) d.say(`Using ${chosen.label}. Switch any time with \`align use\`.`);
  return chosen.name;
}
