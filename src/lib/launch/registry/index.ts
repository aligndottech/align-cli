import { claudeCode } from './agents/claude-code.js';
import { codex } from './agents/codex.js';
import { cursor } from './agents/cursor.js';
import { geminiCli } from './agents/gemini-cli.js';
import { opencode } from './agents/opencode.js';
import { pi } from './agents/pi.js';
import type { AgentSpec } from './types.js';

/** Picker order. Same order `LAUNCH_AGENTS` always had. */
export const AGENT_REGISTRY: readonly AgentSpec[] = [claudeCode, codex, cursor, geminiCli, opencode, pi];

export function specByName(name: string | undefined): AgentSpec | undefined {
  return AGENT_REGISTRY.find((a) => a.name === name);
}
