import { homedir } from 'node:os';
import { join } from 'node:path';
import { findFilesRecursive } from '../fs-scan.js';
import { type CanonicalSession, type SessionAdapter, SessionFormatUnverifiedError } from '../types.js';

/**
 * No fixture-verified content parser - see fixtures/sessions/README.md (blocked on a
 * missing GEMINI_API_KEY / GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_GENAI_USE_GCA, and this
 * session cannot complete gemini-cli's interactive OAuth login).
 *
 * The documented storage path (`~/.gemini/tmp/<project_hash>/chats/`, JSON) hashes the
 * project path into an opaque directory name this session never observed being computed -
 * so unlike the four verified adapters, this cannot filter by cwd. It finds every chat file
 * under the root instead of guessing at a hash, which is the honest version of "found
 * gemini-cli data, cannot yet say which project it belongs to".
 */
export function locateSessionFilesUnder(geminiTmpRoot: string): string[] {
  return findFilesRecursive(geminiTmpRoot, /[/\\]chats[/\\].*\.json$/);
}

export const geminiCliAdapter: SessionAdapter = {
  agent: 'gemini-cli',
  fixtureVerified: false,
  locateSessionFiles(_cwd: string): string[] {
    return locateSessionFilesUnder(join(homedir(), '.gemini', 'tmp'));
  },
  parseSession(_filePath: string): CanonicalSession | null {
    throw new SessionFormatUnverifiedError('gemini-cli');
  },
};
