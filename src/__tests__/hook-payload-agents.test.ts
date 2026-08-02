import { describe, expect, it } from 'vitest';
import { normalizeHookPayload } from '../lib/hook-payload.js';

// One advisory engine, N hosts. Each host pipes its own payload shape on stdin;
// this normalizes them to the canonical HookPayload so runAdvisory never learns
// which agent it is serving. Field names below are taken from each host's own
// published schema, not guessed - see the table in agent-hooks.md.
describe('normalizeHookPayload - Claude Code (canonical)', () => {
  it('passes a PreToolUse payload through unchanged', () => {
    const raw = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'x' } };
    expect(normalizeHookPayload(raw)).toEqual(raw);
  });

  it('passes a PostToolUse payload through unchanged', () => {
    const raw = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts', new_string: 'x' } };
    expect(normalizeHookPayload(raw)?.hook_event_name).toBe('PostToolUse');
  });
});

describe('normalizeHookPayload - pi', () => {
  it('maps a write tool_call to PreToolUse with file_path and content', () => {
    const got = normalizeHookPayload({
      type: 'tool_call',
      toolCallId: 'c1',
      toolName: 'write',
      input: { path: 'src/a.ts', content: 'const x = 1' },
    });
    expect(got).toEqual({
      hook_event_name: 'PreToolUse',
      tool_name: 'write',
      tool_input: { file_path: 'src/a.ts', content: 'const x = 1' },
    });
  });

  // pi's edit tool takes edits[{oldText,newText}]; align's canonical shape is
  // edits[{old_string,new_string}], which is what proposedChangeText() reads.
  it('maps an edit tool_call, renaming oldText/newText per edit', () => {
    const got = normalizeHookPayload({
      type: 'tool_call',
      toolName: 'edit',
      input: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] },
    });
    expect(got?.tool_input?.edits).toEqual([
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' },
    ]);
  });

  // pi's own edit tool still accepts the legacy top-level form (see prepareEditArguments
  // in pi's core/tools/edit.ts), so a payload can arrive in either shape.
  it('maps the legacy top-level oldText/newText edit form', () => {
    const got = normalizeHookPayload({
      type: 'tool_call',
      toolName: 'edit',
      input: { path: 'src/a.ts', oldText: 'a', newText: 'b' },
    });
    expect(got?.tool_input).toEqual({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' });
  });

  it('maps tool_result to PostToolUse', () => {
    const got = normalizeHookPayload({
      type: 'tool_result',
      toolName: 'write',
      input: { path: 'a.ts', content: 'x' },
    });
    expect(got?.hook_event_name).toBe('PostToolUse');
  });
});

describe('normalizeHookPayload - Gemini CLI', () => {
  // Gemini uses tool_name/tool_input verbatim, so only the event needs deriving.
  // AfterTool is the one that carries tool_response - that is the discriminator.
  it('treats a payload with no tool_response as BeforeTool -> PreToolUse', () => {
    const got = normalizeHookPayload({ tool_name: 'write_file', tool_input: { file_path: 'a.ts', content: 'x' } });
    expect(got?.hook_event_name).toBe('PreToolUse');
    expect(got?.tool_input).toEqual({ file_path: 'a.ts', content: 'x' });
  });

  it('treats a payload carrying tool_response as AfterTool -> PostToolUse', () => {
    const got = normalizeHookPayload({
      tool_name: 'write_file',
      tool_input: { file_path: 'a.ts', content: 'x' },
      tool_response: { llmContent: 'wrote a.ts' },
    });
    expect(got?.hook_event_name).toBe('PostToolUse');
  });
});

describe('normalizeHookPayload - Cursor', () => {
  // Cursor's afterFileEdit puts file_path and edits[{old_string,new_string}] at the
  // TOP level, not under tool_input - and its field names already match ours.
  it('lifts afterFileEdit top-level fields into tool_input as PostToolUse', () => {
    const got = normalizeHookPayload({
      hook_event_name: 'afterFileEdit',
      file_path: '/repo/src/a.ts',
      edits: [{ old_string: 'a', new_string: 'b' }],
      conversation_id: 'x',
    });
    expect(got).toEqual({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
    });
  });
});

describe('normalizeHookPayload - rejects what it cannot read', () => {
  it('returns null for a payload with no recognisable tool fields', () => {
    expect(normalizeHookPayload({ conversation_id: 'x', model: 'y' })).toBeNull();
  });

  it('returns null for a non-object', () => {
    expect(normalizeHookPayload('nope')).toBeNull();
    expect(normalizeHookPayload(null)).toBeNull();
  });
});

// OpenCode plugins receive the tool's own argument names. Every field below is from
// its source: edit{filePath,oldString,newString}, write{content,filePath},
// apply_patch{patchText} (packages/opencode/src/tool/*.ts).
describe('normalizeHookPayload - OpenCode', () => {
  it('maps a write tool.execute.before to PreToolUse', () => {
    const got = normalizeHookPayload({
      type: 'tool.execute.before',
      tool: 'write',
      args: { filePath: '/repo/src/a.ts', content: 'const x = 1' },
    });
    expect(got).toEqual({
      hook_event_name: 'PreToolUse',
      tool_name: 'write',
      tool_input: { file_path: '/repo/src/a.ts', content: 'const x = 1' },
    });
  });

  it('renames editoldString/newString into the canonical shape', () => {
    const got = normalizeHookPayload({
      type: 'tool.execute.before',
      tool: 'edit',
      args: { filePath: '/repo/a.ts', oldString: 'pg', newString: 'mongo' },
    });
    expect(got?.tool_input).toEqual({ file_path: '/repo/a.ts', old_string: 'pg', new_string: 'mongo' });
  });

  // apply_patch carries the whole change as one blob, which IS the proposed change -
  // so it maps to `content`, the field proposedChangeText() reads first.
  it('maps apply_patch patchText to content', () => {
    const got = normalizeHookPayload({
      type: 'tool.execute.before',
      tool: 'apply_patch',
      args: { patchText: '*** Update File: a.ts\n+use mongo' },
    });
    expect(got?.tool_input?.content).toContain('use mongo');
  });

  it('maps tool.execute.after to PostToolUse', () => {
    const got = normalizeHookPayload({
      type: 'tool.execute.after',
      tool: 'write',
      args: { filePath: '/repo/a.ts', content: 'x' },
    });
    expect(got?.hook_event_name).toBe('PostToolUse');
  });
});
