import { describe, expect, it } from 'vitest';
import { buildArgs, controlResponse, initializeLine, interruptLine, parseLine, userMessageLine } from '../lib/agent/engines/claude-code-protocol.js';

const j = (o: unknown) => JSON.stringify(o);
const perm = (tool_name: string, input: Record<string, unknown>) =>
  parseLine(j({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name, input, tool_use_id: 't1' } }));

describe('buildArgs', () => {
  it('asks for host-handled permissions over stream-json and never bypasses them', () => {
    const a = buildArgs();
    expect(a).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-mode', 'manual', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
      '--setting-sources', 'user']);
    expect(a.join(' ')).not.toContain('bypassPermissions');
  });
  it('appends extra args last', () => {
    expect(buildArgs(['--model', 'haiku']).slice(-2)).toEqual(['--model', 'haiku']);
  });
});

describe('stdin lines', () => {
  it('initialize is a control request with the given id, newline terminated', () => {
    const l = initializeLine('init-9');
    expect(l.endsWith('\n')).toBe(true);
    expect(JSON.parse(l)).toEqual({ type: 'control_request', request_id: 'init-9', request: { subtype: 'initialize' } });
  });
  it('a user message carries the text; interrupt carries its own id', () => {
    expect(JSON.parse(userMessageLine('hi there'))).toEqual({ type: 'user', message: { role: 'user', content: 'hi there' } });
    expect(JSON.parse(interruptLine('i-2'))).toEqual({ type: 'control_request', request_id: 'i-2', request: { subtype: 'interrupt' } });
  });
});

describe('parseLine events', () => {
  it('maps text_delta stream events to text events', () => {
    const l = (t: string) => j({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
    expect(parseLine(l('Hel')).events).toEqual([{ type: 'text', delta: 'Hel' }]);
    expect(parseLine(l('lo')).events).toEqual([{ type: 'text', delta: 'lo' }]);
  });
  it('maps a result line to turn-end and system/init to init', () => {
    expect(parseLine(j({ type: 'result', subtype: 'success' })).events).toEqual([{ type: 'turn-end' }]);
    expect(parseLine(j({ type: 'system', subtype: 'init' })).init).toBe(true);
  });
  it('ignores types it does not map, non-JSON and non-text deltas', () => {
    for (const l of [j({ type: 'rate_limit_event' }), j({ type: 'system', subtype: 'status' }), j({ type: 'control_response' }), 'not json',
      j({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } })]) {
      expect(parseLine(l)).toEqual({ events: [] });
    }
  });
  it('maps assistant tool_use blocks to tool-start, summarised by kind', () => {
    const msg = (block: object) => j({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, block] } });
    expect(parseLine(msg({ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } })).events)
      .toEqual([{ type: 'tool-start', id: 'a', tool: 'Bash', summary: 'npm test' }]);
    expect(parseLine(msg({ type: 'tool_use', id: 'b', name: 'Write', input: { file_path: '/p/a.ts', content: 'c' } })).events)
      .toEqual([{ type: 'tool-start', id: 'b', tool: 'Write', summary: '/p/a.ts' }]);
    expect(parseLine(msg({ type: 'tool_use', id: 'c', name: 'WebFetch', input: { url: 'u' } })).events)
      .toEqual([{ type: 'tool-start', id: 'c', tool: 'WebFetch', summary: 'WebFetch' }]);
  });
  it('maps user tool_result blocks to tool-end with ok from is_error', () => {
    const msg = (is_error: boolean) => j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', is_error }] } });
    expect(parseLine(msg(false)).events).toEqual([{ type: 'tool-end', id: 't9', ok: true }]);
    expect(parseLine(msg(true)).events).toEqual([{ type: 'tool-end', id: 't9', ok: false }]);
  });
});

describe('parseLine can_use_tool', () => {
  it('classifies edit tools and normalises the input to the hook shape', () => {
    const w = perm('Write', { file_path: '/a', content: 'c', extra: 1 }).permission!;
    expect(w.requestId).toBe('r1');
    expect(w.ask).toEqual({ id: 't1', tool: 'Write', kind: 'edit', edit: { file_path: '/a', content: 'c' } });
    expect(w.input).toEqual({ file_path: '/a', content: 'c', extra: 1 });
    expect(perm('Edit', { file_path: '/a', old_string: 'o', new_string: 'n' }).permission!.ask.edit).toEqual({ file_path: '/a', old_string: 'o', new_string: 'n' });
    const edits = [{ old_string: 'o', new_string: 'n' }];
    expect(perm('MultiEdit', { file_path: '/a', edits }).permission!.ask.edit).toEqual({ file_path: '/a', edits });
    expect(perm('NotebookEdit', { file_path: '/a' }).permission!.ask.kind).toBe('edit');
  });
  it('classifies commands, reads and everything else', () => {
    expect(perm('Bash', { command: 'ls' }).permission!.ask).toEqual({ id: 't1', tool: 'Bash', kind: 'command', command: 'ls' });
    expect(perm('PowerShell', { command: 'dir' }).permission!.ask.kind).toBe('command');
    for (const t of ['Read', 'Glob', 'Grep', 'LS']) expect(perm(t, {}).permission!.ask.kind).toBe('read');
    expect(perm('WebFetch', {}).permission!.ask.kind).toBe('other');
  });
  it('produces no events for a permission request', () => {
    expect(perm('Bash', { command: 'ls' }).events).toEqual([]);
  });
});

describe('controlResponse', () => {
  const body = (s: string) => JSON.parse(s).response;
  it('allow echoes the request id and the original input', () => {
    const s = controlResponse('r7', { allow: true }, { file_path: '/a' });
    expect(s.endsWith('\n')).toBe(true);
    expect(JSON.parse(s).type).toBe('control_response');
    expect(body(s)).toEqual({ subtype: 'success', request_id: 'r7', response: { behavior: 'allow', updatedInput: { file_path: '/a' } } });
  });
  it('deny carries the broker message', () => {
    expect(body(controlResponse('r8', { allow: false, message: 'no' }, {})))
      .toEqual({ subtype: 'success', request_id: 'r8', response: { behavior: 'deny', message: 'no' } });
  });
});

describe('security and error fixes', () => {
  it('loads only the user\'s own settings, never the repo\'s (no repo hooks or allow rules without a trust prompt)', () => {
    const a = buildArgs();
    expect(a.slice(a.indexOf('--setting-sources'), a.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'user']);
  });
  it('reads NotebookEdit\'s own fields, so the gate sees its path and text', () => {
    expect(perm('NotebookEdit', { notebook_path: '/r/a.ipynb', new_source: 'x = 1' }).permission?.ask.edit).toEqual({ file_path: '/r/a.ipynb', new_string: 'x = 1' });
  });
  it('treats TodoWrite as harmless, so it never interrupts the person', () => {
    expect(perm('TodoWrite', { todos: [] }).permission?.ask.kind).toBe('read');
  });
  it('turns an error result into an error, not a silent empty turn', () => {
    expect(parseLine(j({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in. Run claude to sign in.' })).events)
      .toEqual([{ type: 'error', message: 'Not logged in. Run claude to sign in.' }, { type: 'turn-end' }]);
    expect(parseLine(j({ type: 'result', subtype: 'success', is_error: false, result: 'done' })).events).toEqual([{ type: 'turn-end' }]);
  });
});

describe('unknown tools carry their input', () => {
  it('puts the input on the ask, so a person approves what will run', () => {
    expect(perm('WebFetch', { url: 'https://a.example' }).permission?.ask).toMatchObject({ kind: 'other', detail: '{"url":"https://a.example"}' });
  });
});
