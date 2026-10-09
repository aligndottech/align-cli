import type { AgentName } from '../../sessions/types.js';
import type { LaunchSpec } from '../adapters/claude-code.js';
import type { BuildInput, LaunchDeps } from '../launch.js'; // type-only: no runtime cycle

/**
 * One launchable (or planned) coding agent. R1 carries today's `LaunchAgent` fields plus the
 * adapter that builds its launch; later phases replace adapters with data.
 */
export interface AgentSpec {
  name: AgentName;
  label: string;
  bin: string;
  /** per-session: nothing written to the user's config. written-once: later phases. */
  injection: 'per-session' | 'written-once';
  /** A launch target today. Later phases flip more entries to true; nothing else changes. */
  supported: boolean;
  install: string;
  /** The adapter. Absent for agents that are not launch targets yet. */
  build?: (d: LaunchDeps, base: BuildInput) => LaunchSpec;
}
