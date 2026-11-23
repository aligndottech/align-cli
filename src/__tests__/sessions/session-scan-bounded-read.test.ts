/**
 * Locating a project's sessions must cost what the answer needs, not what the transcripts weigh.
 * Every adapter learns a file's project from its opening lines, and a real transcript is megabytes
 * of tool output and pasted images after them, so a scan that reads each file whole reads the
 * entire session store to answer "which of these are mine".
 *
 * node:fs is wrapped, not replaced: the files are real, and the wrapper only counts what was read.
 *
 * Test List:
 * 1. pi: a session with megabytes after its header is located without a whole-file read
 * 2. codex: same, from its session_meta line
 * 3. claude-code: same, and the cwd may sit a few lines in (the first lines carry none)
 * 4. a file whose opening line carries no cwd is not this project's, and still is not read whole
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readSync: vi.fn(actual.readSync) };
});

const { locateSessionFilesUnder: locatePi } = await import('../../lib/sessions/adapters/pi.js');
const { locateSessionFilesUnder: locateCodex } = await import('../../lib/sessions/adapters/codex.js');
const { locateSessionFilesUnder: locateClaudeCode } = await import('../../lib/sessions/adapters/claude-code.js');

const CWD = '/home/dev/acme-api';
const TRANSCRIPT_BYTES = 4 * 1024 * 1024;
// One line of tool output, the size a pasted screenshot or a build log really is.
const BULK = `${JSON.stringify({ type: 'message', message: { role: 'toolResult', content: 'x'.repeat(TRANSCRIPT_BYTES) } })}\n`;
// Generous on purpose: the claim is "a bounded prefix", not one particular chunk size.
const PREFIX_BUDGET = 256 * 1024;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'align-scan-bounded-'));
  vi.mocked(fs.readFileSync).mockClear();
  vi.mocked(fs.readSync).mockClear();
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function writeSession(name: string, openingLines: unknown[]): string {
  const file = join(root, name);
  fs.writeFileSync(file, openingLines.map(l => `${JSON.stringify(l)}\n`).join('') + BULK);
  return file;
}

function bytesReadByChunks(): number {
  return vi.mocked(fs.readSync).mock.results.reduce((sum, r) => sum + (r.type === 'return' ? Number(r.value) : 0), 0);
}

function expectBoundedRead(file: string): void {
  expect(vi.mocked(fs.readFileSync).mock.calls.map(c => c[0])).not.toContain(file);
  expect(bytesReadByChunks()).toBeLessThan(PREFIX_BUDGET);
}

describe('locating sessions reads a bounded prefix of each transcript', () => {
  it('pi: the session header line is enough', () => {
    const file = writeSession('pi.jsonl', [{ type: 'session', version: 3, id: 's1', cwd: CWD }]);
    expect(locatePi(root, CWD)).toEqual([file]);
    expectBoundedRead(file);
  });

  it('codex: the session_meta line is enough', () => {
    const file = writeSession('codex.jsonl', [{ type: 'session_meta', payload: { session_id: 's1', cwd: CWD } }]);
    expect(locateCodex(root, CWD)).toEqual([file]);
    expectBoundedRead(file);
  });

  it('claude-code: stops at the first line that carries a cwd, even when it is not the first line', () => {
    const file = writeSession('claude.jsonl', [
      { type: 'summary', summary: 'earlier work' },
      { type: 'file-history-snapshot', messageId: 'm0' },
      { type: 'user', cwd: CWD, sessionId: 's1', message: { role: 'user', content: 'hi' } },
    ]);
    expect(locateClaudeCode(root, CWD)).toEqual([file]);
    expectBoundedRead(file);
  });

  it('pi: a header with no cwd is not matched, and the megabytes after it are still not read', () => {
    const file = writeSession('pi-no-cwd.jsonl', [{ type: 'session', version: 3, id: 's1' }]);
    expect(locatePi(root, CWD)).toEqual([]);
    expectBoundedRead(file);
  });
});
