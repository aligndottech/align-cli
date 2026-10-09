import type { AgentName } from '../../sessions/types.js';
import type { LaunchSpec } from '../adapters/claude-code.js';
import type { AgentInstall } from '../install.js';
import type { BuildInput, LaunchDeps } from '../launch.js'; // type-only: no runtime cycle

/**
 * Every agent the launcher knows. Wider than the session parsers' AgentName: an agent can be a
 * launch target before align reads its session history (Copilot), and widening AgentName would
 * reach every parser's exhaustive switch for nothing.
 */
export type LaunchAgentId = AgentName | 'copilot';

/**
 * One launchable (or planned) coding agent. R1 carries today's `LaunchAgent` fields plus the
 * adapter that builds its launch; later phases replace adapters with data.
 */
export interface AgentSpec {
  name: LaunchAgentId;
  label: string;
  bin: string;
  /** per-session: nothing written to the user's config. written-once: later phases. */
  injection: 'per-session' | 'written-once';
  /** A launch target today. Later phases flip more entries to true; nothing else changes. */
  supported: boolean;
  /**
   * How a user installs it. `npm`: one argv the picker may offer to run after an explicit yes.
   * `docs`: a script or URL installer, which Align only ever prints (plan Decision 4).
   */
  install: AgentInstall;
  /** The adapter. Absent for agents that are not launch targets yet. */
  build?: (d: LaunchDeps, base: BuildInput) => LaunchSpec;
}
