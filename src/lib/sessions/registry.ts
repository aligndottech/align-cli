import { claudeCodeAdapter } from './adapters/claude-code.js';
import { codexAdapter } from './adapters/codex.js';
import { cursorAdapter } from './adapters/cursor.js';
import { geminiCliAdapter } from './adapters/gemini-cli.js';
import { opencodeAdapter } from './adapters/opencode.js';
import { piAdapter } from './adapters/pi.js';
import type { SessionAdapter } from './types.js';

export const ADAPTERS: SessionAdapter[] = [
  claudeCodeAdapter, codexAdapter, cursorAdapter, geminiCliAdapter, opencodeAdapter, piAdapter,
];

export interface DetectedAgent {
  adapter: SessionAdapter;
  files: string[];
}

/** `align import sessions`' auto-detect: every agent that has actually left session data
 *  for this project. An agent with zero files is "never run here" - the normal case for
 *  five of six adapters on any one machine - so it is silently excluded, not reported. */
export function detectAgents(cwd: string, adapters: SessionAdapter[] = ADAPTERS): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const adapter of adapters) {
    const files = adapter.locateSessionFiles(cwd);
    if (files.length > 0) found.push({ adapter, files });
  }
  return found;
}
