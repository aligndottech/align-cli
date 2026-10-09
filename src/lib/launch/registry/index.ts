import { amp } from './agents/amp.js';
import { claudeCode } from './agents/claude-code.js';
import { codex } from './agents/codex.js';
import { copilot } from './agents/copilot.js';
import { cursor } from './agents/cursor.js';
import { droid } from './agents/droid.js';
import { geminiCli } from './agents/gemini-cli.js';
import { grokBuild } from './agents/grok-build.js';
import { kiro } from './agents/kiro.js';
import { opencode } from './agents/opencode.js';
import { pi } from './agents/pi.js';
import { qwen } from './agents/qwen.js';
import type { AgentSpec } from './types.js';

/**
 * Table order: the order `LAUNCH_AGENTS` always had, with Copilot in its alphabetical place, then
 * wave B by id. The picker sorts by label itself; this order is what `align agents` prints.
 */
export const AGENT_REGISTRY: readonly AgentSpec[] = [claudeCode, codex, copilot, cursor, geminiCli, opencode, pi, amp, droid, grokBuild, kiro, qwen];

export function specByName(name: string | undefined): AgentSpec | undefined {
  return AGENT_REGISTRY.find((a) => a.name === name);
}
