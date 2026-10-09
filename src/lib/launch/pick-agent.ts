import { spawn as nodeSpawn } from 'node:child_process';
import type { LaunchAgentId } from './registry/types.js';
import { agentByName, byPriority, type LaunchAgent, PRE_WAVE_A, resolveAgentBin, supportedAgents } from './agents.js';
import { findOnPath } from './detect.js';
import { type InstallOfferDeps, offerInstall } from './install.js';
import { chooseAgent, type PickerOption } from './picker-options.js';
import { confirmDefaultNo, selectAgent } from './prompts.js';
import { specByName } from './registry/index.js';

/**
 * The wizard's "which coding agent?" step (C5). It reads the same table and the same PATH scan
 * the launcher does and stores through the same config key, so what the wizard picks is exactly
 * what bare `align` opens afterwards. On a terminal the picker lists every supported agent,
 * installed ones first; picking a missing one offers its install (plan Decision 4).
 */
export interface PickAgentDeps {
  env: Record<string, string | undefined>;
  platform: string;
  agents: readonly LaunchAgent[];
  findOnPath(bin: string, env: Record<string, string | undefined>, platform: string): string | null;
  /** Resolves null when the user cancels. Only called on a terminal. `initial` is preselected. */
  select(options: PickerOption[], initial?: LaunchAgentId): Promise<LaunchAgentId | null>;
  /** Default-No question: true on yes, false on no, null on Ctrl-C (install-on-pick). */
  confirm(message: string): Promise<boolean | null>;
  /** Runs an install argv the user approved. */
  spawn: InstallOfferDeps['spawn'];
  say(line: string): void;
}

/** The user cancelled the picker: the wizard stops, like any other cancelled prompt. */
export const PICK_CANCELLED = 'cancelled' as const;

export interface AgentConfig {
  getAgent(): string | undefined;
  setAgent(agent: string): void;
  isLaunchOff?(): boolean;
}

function defaultDeps(): PickAgentDeps {
  return {
    env: process.env,
    platform: process.platform,
    agents: supportedAgents(),
    findOnPath,
    select: (options, initial) => selectAgent(options, initial),
    confirm: (message) => confirmDefaultNo(message),
    spawn: (command, args, options) => nodeSpawn(command, args, options),
    say: (l) => console.log(l),
  };
}

export async function pickAgent(
  config: AgentConfig,
  opts: { interactive: boolean; approve?: boolean },
  overrides: Partial<PickAgentDeps> = {},
): Promise<LaunchAgentId | null | typeof PICK_CANCELLED> {
  const d = { ...defaultDeps(), ...overrides };

  const isInstalled = (a: LaunchAgent): boolean => resolveAgentBin(a, d.findOnPath, d.env, d.platform) !== null;
  const installed = d.agents.filter(isInstalled);

  // A re-run keeps the choice, provided it can still be launched; `align use` changes it. A
  // stored agent that has left PATH is treated as no choice at all.
  const stored = agentByName(config.getAgent());
  if (stored && installed.some((a) => a.name === stored.name)) return stored.name;

  if (installed.length === 0 && (!opts.interactive || opts.approve)) {
    d.say('No coding agent that Align can open was found on your PATH. Align works with:');
    for (const a of d.agents) d.say(`  ${a.label}: ${a.install}`);
    d.say('Install one, then run `align` again. `align agents` lists them all.');
    return null;
  }

  // Without a terminal and without --approve, only the agents launchable before wave A are
  // weighed when any is installed: a machine with Claude Code plus Codex picks Claude Code, as it
  // did before Codex could be launched, and two older agents still are not guessed between.
  const preWaveA = installed.filter((a) => PRE_WAVE_A.has(a.name));
  const unattended = !opts.interactive && !opts.approve && preWaveA.length > 0 ? preWaveA : installed;

  let chosen: LaunchAgent | null | undefined;
  if (opts.approve) {
    chosen = byPriority(installed)[0];
  } else if (opts.interactive) {
    // Always asked on a terminal: with one installed it is preselected, so Enter keeps it.
    chosen = await chooseAgent(d.agents, {
      isInstalled,
      select: (options, initial) => d.select(options, initial),
      offer: (a) => offerInstall(specByName(a.name)!, {
        isTTY: true,
        platform: d.platform,
        confirm: (m) => d.confirm(m),
        spawn: d.spawn,
        onPath: (bin) => d.findOnPath(bin, d.env, d.platform),
        say: d.say,
      }),
      say: d.say,
    });
    if (chosen === null) {
      // With nothing installed, leaving the picker is not cancelling setup: it carries on with no
      // agent chosen, as it did before the picker listed missing agents.
      if (installed.length === 0) {
        d.say('No agent chosen. Install one, then run `align` again. `align agents` lists them all.');
        return null;
      }
      return PICK_CANCELLED;
    }
  } else if (unattended.length === 1) {
    chosen = unattended[0];
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
