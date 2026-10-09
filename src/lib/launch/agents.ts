import type { AgentName } from '../sessions/types.js';

export interface LaunchAgent {
  name: AgentName;
  label: string;
  bin: string;
  /** per-session: nothing written to the user's config. written-once: later phases. */
  injection: 'per-session' | 'written-once';
  /** A launch target today. Later phases flip more entries to true; nothing else changes. */
  supported: boolean;
  install: string;
}

export const LAUNCH_AGENTS: readonly LaunchAgent[] = [
  { name: 'claude-code', label: 'Claude Code', bin: 'claude', injection: 'per-session', supported: true, install: 'npm i -g @anthropic-ai/claude-code' },
  { name: 'codex', label: 'Codex', bin: 'codex', injection: 'per-session', supported: false, install: 'npm i -g @openai/codex' },
  { name: 'cursor', label: 'Cursor', bin: 'cursor-agent', injection: 'written-once', supported: false, install: 'https://cursor.com/cli' },
  { name: 'gemini-cli', label: 'Gemini CLI', bin: 'gemini', injection: 'per-session', supported: false, install: 'npm i -g @google/gemini-cli' },
  { name: 'opencode', label: 'OpenCode', bin: 'opencode', injection: 'per-session', supported: true, install: 'npm i -g opencode-ai' },
  { name: 'pi', label: 'pi', bin: 'pi', injection: 'per-session', supported: false, install: 'https://pi.dev' },
];

export function agentByName(name: string | undefined): LaunchAgent | undefined {
  return LAUNCH_AGENTS.find((a) => a.name === name);
}

export const supportedAgents = (): LaunchAgent[] => LAUNCH_AGENTS.filter((a) => a.supported);
