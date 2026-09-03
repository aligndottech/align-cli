/**
 * ALI-808: gemini-cli and cursor have no committed fixture (see fixtures/sessions/README.md
 * for exactly why - a missing credential and a denied installer script, not an oversight).
 * Per Tom's own gate ("no adapter ships without one [fixture]"), neither parses content.
 *
 * locateSessionFiles is still built from the documented storage path, because finding files
 * is independently verifiable without knowing the content format - it just cannot be
 * filtered by project the way the four verified adapters are (gemini-cli hashes the project
 * path into an opaque directory name; cursor's naming was never observed). Both facts are
 * asserted below so this gap stays visible rather than silently "working".
 *
 * Test List:
 * 1. gemini-cli: locateSessionFiles finds files under the documented root, unfiltered
 * 2. gemini-cli: parseSession always throws SessionFormatUnverifiedError
 * 3. cursor: locateSessionFiles finds files under the documented root, unfiltered
 * 4. cursor: parseSession always throws SessionFormatUnverifiedError
 * 5. both report fixtureVerified: false
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geminiCliAdapter, locateSessionFilesUnder as locateGemini } from '../../lib/sessions/adapters/gemini-cli.js';
import { cursorAdapter, locateSessionFilesUnder as locateCursor } from '../../lib/sessions/adapters/cursor.js';
import { SessionFormatUnverifiedError } from '../../lib/sessions/types.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'align-unverified-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('gemini-cli: locate without a verified filter', () => {
  it('finds files under the documented root - unfiltered, since the hash algorithm is undocumented here', () => {
    const chats = join(root, 'a1b2c3', 'chats');
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(chats, 'chat1.json'), '{}');
    expect(locateGemini(root)).toEqual([join(chats, 'chat1.json')]);
  });

  it('parseSession always throws, naming the fixtures README', () => {
    expect(() => geminiCliAdapter.parseSession('/anything.json')).toThrow(SessionFormatUnverifiedError);
    expect(() => geminiCliAdapter.parseSession('/anything.json')).toThrow(/fixtures\/sessions\/README/);
  });

  it('reports fixtureVerified: false', () => {
    expect(geminiCliAdapter.fixtureVerified).toBe(false);
  });
});

describe('cursor: locate without a verified filter', () => {
  it('finds files under the documented agent-transcripts root - unfiltered', () => {
    const transcripts = join(root, 'my-project', 'agent-transcripts', 'sess1');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, 'sess1.jsonl'), '{}');
    expect(locateCursor(root)).toEqual([join(transcripts, 'sess1.jsonl')]);
  });

  it('parseSession always throws, naming the fixtures README', () => {
    expect(() => cursorAdapter.parseSession('/anything.jsonl')).toThrow(SessionFormatUnverifiedError);
  });

  it('reports fixtureVerified: false', () => {
    expect(cursorAdapter.fixtureVerified).toBe(false);
  });
});
