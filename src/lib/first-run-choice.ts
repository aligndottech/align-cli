import { agentByName, type LaunchAgent, resolveAgentBin } from './launch/agents.js';
import type { LaunchAgentId } from './launch/registry/types.js';

/*
 * The first bare `align` in a repo asks how to use Align: keep the agent already on the machine
 * (Align wires itself into it, as `align mcp --setup` does), or use Align's own coding agent.
 * The answer is remembered per repo. This module is the decision and the words; the wiring, the
 * prompt and the store are injected, so each is replaced in a test.
 */

export type RunMode = 'keep' | 'own';

/** Which of the three agents Align names, in the order it names them. */
const KEEP_ORDER: readonly LaunchAgentId[] = ['claude-code', 'codex', 'cursor'];

export interface Suggestion {
  mode: RunMode;
  /** The detected agents, in KEEP_ORDER. The first is the one named. Empty when none was found. */
  keep: LaunchAgent[];
}

/** Detect, then suggest: keep a detected agent, or Align's own when none of the three is here. */
export function suggestRunMode(
  find: (bin: string, env: Record<string, string | undefined>, platform: string) => string | null,
  env: Record<string, string | undefined>,
  platform: string,
): Suggestion {
  const keep = KEEP_ORDER.map((n) => agentByName(n)).filter((a): a is LaunchAgent => a !== undefined && resolveAgentBin(a, find, env, platform) !== null);
  return { mode: keep.length > 0 ? 'keep' : 'own', keep };
}

export interface ChoiceCopy {
  message: string;
  keepLabel: string;
  ownLabel: string;
  footer: string;
}

export function choiceCopy(s: Suggestion): ChoiceCopy {
  const first = s.keep[0];
  const others = s.keep.slice(1).map((a) => a.label);
  const message = first
    ? `Align found ${first.label} on this machine${others.length > 0 ? `, and also ${others.join(', ')}` : ''}. How do you want to use Align?`
    : 'How do you want to use Align?';
  const keepLabel = first
    ? `1. Keep ${first.label}. Align checks each edit and answers questions inside it.`
    : '1. Keep your existing agent (Claude Code, Codex, Cursor, ...). Align checks each edit and answers questions inside it.';
  return { message, keepLabel, ownLabel: "2. Use Align's own coding agent.", footer: 'Change this later: align --switch' };
}

export interface ChoiceDeps {
  tty: boolean;
  /** `align --switch`: ask again whatever is stored. */
  switching: boolean;
  suggestion: Suggestion;
  /** The first-run wizard already wired the agent, so choosing 1 must not write a second time. */
  alreadyWired?: boolean;
  getStored(): RunMode | undefined;
  setStored(mode: RunMode): void;
  /** The question. null on Ctrl-C. Only called on a terminal. */
  ask(s: Suggestion): Promise<RunMode | null>;
  /** The existing setup wiring (MCP server, edit hook, editor rules). false when nothing was written. */
  wire(): Promise<boolean>;
  say(line: string): void;
}

export type ChoiceResult = { action: 'own' } | { action: 'keep'; wired: boolean } | { action: 'cancelled' };

export async function resolveRunChoice(d: ChoiceDeps): Promise<ChoiceResult> {
  const stored = d.getStored();
  if (stored && !d.switching) return stored === 'own' ? { action: 'own' } : { action: 'keep', wired: false };

  const label = d.suggestion.keep[0]?.label ?? 'your agent';
  if (!d.tty) {
    // Nobody to ask, and changing an agent's config needs a yes: take the suggestion, write and remember nothing.
    if (d.suggestion.mode === 'own') return { action: 'own' };
    d.say(`No terminal to ask in, so Align suggests keeping ${label}. Run align in a terminal to set it up.`);
    return { action: 'keep', wired: false };
  }

  const mode = await d.ask(d.suggestion);
  if (mode === null) return { action: 'cancelled' };
  if (mode === 'own') {
    d.setStored('own');
    return { action: 'own' };
  }
  const wired = d.alreadyWired === true || (await d.wire());
  if (wired) {
    d.setStored('keep');
    d.say(`Open ${label} in this repo. Align is connected to it.`);
  }
  return { action: 'keep', wired };
}

/** The question, as a clack select with the suggestion preselected. Loaded on use: the launch path pays nothing for it. */
export async function askRunMode(s: Suggestion): Promise<RunMode | null> {
  const clack = await import('@clack/prompts');
  const c = choiceCopy(s);
  const answer = await clack.select<RunMode>({
    message: c.message,
    options: [
      { value: 'keep', label: c.keepLabel },
      { value: 'own', label: c.ownLabel },
    ],
    initialValue: s.mode,
  });
  if (clack.isCancel(answer)) return null;
  clack.log.info(c.footer);
  return answer;
}
