import { claudeCode } from './agents/claude-code.js';
import { codex } from './agents/codex.js';
import { copilot } from './agents/copilot.js';
import { cursor } from './agents/cursor.js';
import { geminiCli } from './agents/gemini-cli.js';
import { opencode } from './agents/opencode.js';
import { pi } from './agents/pi.js';
import type { AgentSpec } from './types.js';

/** Picker order: the order `LAUNCH_AGENTS` always had, with Copilot in its alphabetical place. */
export const AGENT_REGISTRY: readonly AgentSpec[] = [claudeCode, codex, copilot, cursor, geminiCli, opencode, pi];

export function specByName(name: string | undefined): AgentSpec | undefined {
  return AGENT_REGISTRY.find((a) => a.name === name);
}
