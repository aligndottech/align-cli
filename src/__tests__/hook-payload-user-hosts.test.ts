import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHookPayload } from '../lib/hook-payload.js';

/**
 * ALI-952: the three user-level hook hosts. Every payload below is the DOCUMENTED shape
 * from the host's hook reference (cited in docs/agent-hooks.md), not a capture - no session
 * of these agents was available on the machine this was written on (`which codex
 * cursor-agent copilot` all empty; Codex installed via npx ran apply_patch but never fired
 * a hooks.json, five attempts, see the PR). tdd.md: a hand-built fixture for a producer you
 * do not control is the wrong repair, so these pin the normaliser against the vendor's
 * published contract and say so. A real capture goes in fixtures/hook-payloads/ and the
 * data-driven suite at the bottom gates on it the moment it lands.
 */
describe('normalizeHookPayload - Codex (documented shape; real capture pending)', () => {
  // Codex speaks Claude Code's field names. Its file edits go through apply_patch, whose
  // tool_input carries the whole patch under `command` (hooks reference: "tool_input.command
  // applies to Bash and apply_patch") - so the patch IS the proposed change and maps to
  // `content`, the field proposedChangeText() reads first, exactly like OpenCode's patchText.
  it('maps an apply_patch PreToolUse to content = the patch text', () => {
    const got = normalizeHookPayload({
      session_id: 's', cwd: '/repo', hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch', tool_use_id: 't1',
      tool_input: { command: '*** Begin Patch\n*** Update File: db.ts\n+use mongo\n*** End Patch' },
    });
    expect(got?.hook_event_name).toBe('PreToolUse');
    expect(got?.tool_name).toBe('apply_patch');
    expect(got?.tool_input?.content).toContain('use mongo');
  });

  // A shell command is not a proposed edit. The matcher keeps Bash out of the hook, and if
  // one arrives anyway its command must NOT be read as file content.
  it('does not treat a Bash command as content', () => {
    const got = normalizeHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    expect(got?.tool_input?.content).toBeUndefined();
  });
});

describe('normalizeHookPayload - Cursor (documented shape; real capture pending)', () => {
  // Cursor's preToolUse/postToolUse carry tool_name + tool_input like Claude Code, but the
  // event name is camelCase. Passed through verbatim it would never equal 'PreToolUse', so
  // runAdvisory would check the landed diff instead of the proposed edit - silently.
  it('maps preToolUse to PreToolUse and keeps tool_name/tool_input', () => {
    const got = normalizeHookPayload({
      conversation_id: 'c', hook_event_name: 'preToolUse', cursor_version: '1.7',
      tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: 'const x = 1' }, tool_use_id: 'u', cwd: '/repo',
    });
    expect(got?.hook_event_name).toBe('PreToolUse');
    expect(got?.tool_name).toBe('Write');
    expect(got?.tool_input).toEqual({ file_path: 'src/a.ts', content: 'const x = 1' });
  });

  it('maps postToolUse to PostToolUse', () => {
    const got = normalizeHookPayload({ hook_event_name: 'postToolUse', tool_name: 'Write', tool_input: {}, tool_output: 'ok' });
    expect(got?.hook_event_name).toBe('PostToolUse');
  });

  it('still lifts afterFileEdit (unchanged from before)', () => {
    const got = normalizeHookPayload({ hook_event_name: 'afterFileEdit', file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }] });
    expect(got?.hook_event_name).toBe('PostToolUse');
  });
});

describe('normalizeHookPayload - Copilot CLI (documented shape; real capture pending)', () => {
  // Copilot's camelCase payload has no event name at all: {sessionId, timestamp, cwd,
  // toolName, toolArgs}. postToolUse is the one carrying toolResult - that is the
  // discriminator, the same way Gemini's tool_response is.
  it('maps a toolName/toolArgs payload with no toolResult to PreToolUse', () => {
    const got = normalizeHookPayload({
      sessionId: 's', timestamp: 1725000000000, cwd: '/repo',
      toolName: 'create', toolArgs: { path: 'src/a.ts', content: 'const x = 1' },
    });
    expect(got?.hook_event_name).toBe('PreToolUse');
    expect(got?.tool_name).toBe('create');
    expect(got?.tool_input).toMatchObject({ content: 'const x = 1' });
  });

  it('maps a payload carrying toolResult to PostToolUse', () => {
    const got = normalizeHookPayload({
      sessionId: 's', timestamp: 1, cwd: '/repo', toolName: 'edit', toolArgs: {},
      toolResult: { resultType: 'success', textResultForLlm: 'edited' },
    });
    expect(got?.hook_event_name).toBe('PostToolUse');
  });

  // Copilot also documents a "VS Code compatible" snake_case variant that IS the Claude
  // Code shape; it must keep working through the existing branch.
  it('accepts the VS Code-compatible snake_case variant unchanged', () => {
    const got = normalizeHookPayload({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'create', tool_input: { content: 'x' } });
    expect(got).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'create', tool_input: { content: 'x' } });
  });
});

// A user-level hook does not run from the project. Cursor documents that user-level hook
// scripts run from ~/.cursor/, and the post-edit path reads `git diff` in process.cwd(), so
// without the payload's cwd the check would run against the wrong directory - or exit 0 in
// silence because ~/.cursor is not a git repo. Every host puts the workspace under `cwd`.
describe('normalizeHookPayload carries the payload cwd', () => {
  it.each([
    ['Claude Code', { hook_event_name: 'PreToolUse', cwd: '/w/claude', tool_name: 'Write', tool_input: {} }],
    ['Codex', { hook_event_name: 'PreToolUse', cwd: '/w/codex', tool_name: 'apply_patch', tool_input: { command: 'p' } }],
    ['Cursor', { hook_event_name: 'preToolUse', cwd: '/w/cursor', tool_name: 'Write', tool_input: {} }],
    ['Copilot CLI', { cwd: '/w/copilot', toolName: 'edit', toolArgs: {} }],
    ['Gemini CLI', { cwd: '/w/gemini', tool_name: 'write_file', tool_input: {} }],
  ])('%s', (_host, raw) => {
    expect(normalizeHookPayload(raw)?.cwd).toBe((raw as { cwd: string }).cwd);
  });

  it('leaves cwd undefined when the host sent none', () => {
    expect(normalizeHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} })?.cwd).toBeUndefined();
  });
});

/**
 * REAL captures. Drop a payload captured from an actual session into
 * src/__tests__/fixtures/hook-payloads/<host>-<event>.json (the README there says how) and
 * this suite gates the normaliser on it: every real pre-edit payload must yield a
 * non-empty proposed change. Skips LOUDLY while the directory holds nothing, so an empty
 * directory cannot read as coverage.
 */
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hook-payloads');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
if (!fixtures.length) console.warn('\n[hook-payload-user-hosts] no real hook captures in fixtures/hook-payloads/ - every host normaliser above runs on its documented shape only\n');

describe.skipIf(!fixtures.length)('real captured hook payloads normalise to a checkable change', () => {
  it.each(fixtures)('%s', (file) => {
    const raw = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
    const got = normalizeHookPayload(raw);
    expect(got).not.toBeNull();
    expect(got?.hook_event_name).toMatch(/^(Pre|Post)ToolUse$/);
    if (got?.hook_event_name === 'PreToolUse') {
      const input = got.tool_input ?? {};
      const text = input.content ?? input.new_string ?? input.edits?.map((e) => e.new_string ?? '').join('\n') ?? '';
      expect(text.trim().length, `${file}: no proposed change extracted`).toBeGreaterThan(0);
    }
  });
});
