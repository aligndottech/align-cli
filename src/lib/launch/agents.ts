import { installText } from './install.js';
import { AGENT_REGISTRY, specByName } from './registry/index.js';
import type { LaunchAgentId } from './registry/types.js';

export interface LaunchAgent {
  name: LaunchAgentId;
  label: string;
  bin: string;
  /** per-session: nothing written to the user's config. written-once: later phases. */
  injection: 'per-session' | 'written-once';
  /** A launch target today. Later phases flip more entries to true; nothing else changes. */
  supported: boolean;
  /** The install command or URL, as text. The structured form is on the registry spec. */
  install: string;
}

export const LAUNCH_AGENTS: readonly LaunchAgent[] = AGENT_REGISTRY.map(
  ({ name, label, bin, injection, supported, install }) => ({ name, label, bin, injection, supported, install: installText(install) }),
);

export function agentByName(name: string | undefined): LaunchAgent | undefined {
  return LAUNCH_AGENTS.find((a) => a.name === name);
}

export const supportedAgents = (): LaunchAgent[] => LAUNCH_AGENTS.filter((a) => a.supported);

/**
 * Which agent to take when several are installed and nobody can be asked (no terminal, or
 * --approve). The agents launchable before wave A keep their old order, Claude Code first, so a
 * scripted first run picks what it picked before; the wave A agents come after them.
 */
export const PICK_PRIORITY: readonly LaunchAgentId[] = ['claude-code', 'cursor', 'opencode', 'pi', 'codex', 'copilot', 'gemini-cli', 'amp', 'droid', 'grok-build', 'kiro', 'qwen', 'goose', 'auggie', 'continue', 'cline', 'aider'];
/** The agents launchable before wave A. */
export const PRE_WAVE_A: ReadonlySet<LaunchAgentId> = new Set(['claude-code', 'cursor', 'opencode', 'pi']);
/** The agents launchable before wave B (wave A included). */
export const PRE_WAVE_B: ReadonlySet<LaunchAgentId> = new Set([...PRE_WAVE_A, 'codex', 'copilot', 'gemini-cli']);
/** The agents launchable before wave C (waves A and B included). */
export const PRE_WAVE_C: ReadonlySet<LaunchAgentId> = new Set([...PRE_WAVE_B, 'amp', 'droid', 'grok-build', 'kiro', 'qwen']);

export function byPriority(agents: LaunchAgent[]): LaunchAgent[] {
  const rank = (a: LaunchAgent): number => {
    const i = PICK_PRIORITY.indexOf(a.name);
    return i < 0 ? PICK_PRIORITY.length : i;
  };
  return [...agents].sort((a, b) => rank(a) - rank(b));
}

/**
 * The agent's binary on PATH, and where. Only `bin` is accepted: for Cursor that is `cursor-agent`,
 * which its installer always creates. Cursor's docs also call the command `agent`, but that name
 * is too generic to run on a guess, so a bare `agent` on PATH is not Cursor. A spec whose `bin` is
 * generic (Grok Build's `grok`) also names `acceptsBin`, and a `bin` it refuses is not installed.
 */
export function resolveAgentBin(
  a: LaunchAgent,
  find: (bin: string, env: Record<string, string | undefined>, platform: string) => string | null,
  env: Record<string, string | undefined>,
  platform: string,
): { bin: string; path: string } | null {
  const found = find(a.bin, env, platform);
  if (!found) return null;
  const accepts = specByName(a.name)?.acceptsBin;
  return accepts && !accepts(found, env, platform) ? null : { bin: a.bin, path: found };
}
