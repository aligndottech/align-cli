import { homedir } from 'node:os';
import { join } from 'node:path';
import { findFilesRecursive } from '../fs-scan.js';
import { type CanonicalSession, type SessionAdapter, SessionFormatUnverifiedError } from '../types.js';

/**
 * No fixture-verified content parser - see fixtures/sessions/README.md. Cursor's real
 * product is a GUI IDE with no headless CLI reachable from this environment; its own
 * installer script was refused by this session's own pipe-to-bash guard (the right call
 * for an unreviewed remote script, independent of credentials).
 *
 * The documented JSONL path (`~/.cursor/projects/<project>/agent-transcripts/<session>/
 * <session>.jsonl`) names its project directory literally, unlike gemini-cli's hash - but
 * this session never observed a real one being created, so the exact naming (slug? raw
 * path?) is unverified too. Finds every transcript file under the root rather than guessing
 * at that naming. Cursor's second storage mode (SQLite at `~/.cursor/chats/<hash>/...`) is
 * not scanned here at all - two unverified formats is not a reason to guess at both.
 */
export function locateSessionFilesUnder(cursorProjectsRoot: string): string[] {
  return findFilesRecursive(cursorProjectsRoot, /[/\\]agent-transcripts[/\\].*\.jsonl$/);
}

export const cursorAdapter: SessionAdapter = {
  agent: 'cursor',
  fixtureVerified: false,
  locateSessionFiles(_cwd: string): string[] {
    return locateSessionFilesUnder(join(homedir(), '.cursor', 'projects'));
  },
  parseSession(_filePath: string): CanonicalSession | null {
    throw new SessionFormatUnverifiedError('cursor');
  },
};
