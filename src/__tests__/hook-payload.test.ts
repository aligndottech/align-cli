import { describe, expect, it } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { readHookPayload } from '../lib/hook-payload.js';

function streamOf(text: string): Readable {
  return Readable.from([text]);
}

/** A pipe that stays open and receives its payload after `delayMs`, like a real agent's spawn. */
function delayedStreamOf(text: string, delayMs: number): PassThrough {
  const s = new PassThrough();
  setTimeout(() => {
    s.write(text);
    s.end();
  }, delayMs);
  return s;
}

/**
 * The reader used to race a fixed 200ms timer from the moment it attached, resolving with
 * whatever had arrived. A host that spawns the process and then writes loses that race, and the
 * failure is silent: an empty payload reads as "invoked manually with no payload", so check.ts
 * falls back to the staged diff, finds nothing in a clean tree, and exits 0 having said nothing.
 * The agent gets no context and no error.
 *
 * Measured against the shipped build before this fix: 0ms -> output, 150ms -> silence. That is
 * well inside normal spawn latency, and it is why `install-smoke (windows-2022)` failed while
 * Linux and macOS passed - Windows loses the same race more often, it does not own it.
 */
describe('readHookPayload with a payload that arrives after the reader attaches', () => {
  it('waits for a payload written 500ms after attaching', async () => {
    const payload = await readHookPayload(
      delayedStreamOf(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: 'a.ts', content: 'x' },
        }),
        500,
      ),
    );
    expect(payload?.tool_input?.file_path).toBe('a.ts');
  });

  // Second example for the same rule, further out, so the fix cannot be a slightly bigger
  // constant that this suite happens to sit under.
  it('waits for a payload written 1200ms after attaching', async () => {
    const payload = await readHookPayload(
      delayedStreamOf(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: 'late.ts', content: 'x' },
        }),
        1200,
      ),
    );
    expect(payload?.tool_input?.file_path).toBe('late.ts');
  });

  // The property the old 200ms timer was protecting, which must survive: a manual
  // `align check --advisory` where stdin is a pipe nobody writes to and nobody closes must not
  // hang the command. It gives up and returns null, bounded, rather than waiting forever.
  it('gives up on a pipe that is never written to and never closed', async () => {
    const silent = new PassThrough();
    const started = Date.now();

    const payload = await readHookPayload(silent);

    expect(payload).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe('readHookPayload', () => {
  it('parses a PreToolUse Write payload', async () => {
    const payload = await readHookPayload(streamOf(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'src/db.ts', content: '// use mongodb' },
    })));
    expect(payload?.hook_event_name).toBe('PreToolUse');
    expect(payload?.tool_input?.content).toBe('// use mongodb');
  });

  it('parses a PreToolUse Edit payload (old_string/new_string)', async () => {
    const payload = await readHookPayload(streamOf(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'a.ts', old_string: 'postgres', new_string: 'mongodb' },
    })));
    expect(payload?.tool_input?.new_string).toBe('mongodb');
  });

  it('returns null for a TTY stream (manual run, no piped payload)', async () => {
    const tty = Object.assign(Readable.from([]), { isTTY: true });
    expect(await readHookPayload(tty)).toBeNull();
  });

  it('returns null for empty stdin', async () => {
    expect(await readHookPayload(streamOf(''))).toBeNull();
  });

  it('returns null for invalid JSON rather than throwing', async () => {
    expect(await readHookPayload(streamOf('{ not json'))).toBeNull();
  });
});
