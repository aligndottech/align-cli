import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { readHookPayload } from '../lib/hook-payload.js';

function streamOf(text: string): Readable {
  return Readable.from([text]);
}

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
