/**
 * ALI-808 Codex CLI adapter, backed by a real `codex exec` session fixture (see
 * fixtures/sessions/README.md).
 *
 * Test List:
 * 1. parseSession reads the real fixture: right agent/sessionId/cwd, from session_meta
 * 2. developer-role messages (Codex's own system-prompt boilerplate) are not turns
 * 3. user/assistant turns carry the real text (input_text / output_text content)
 * 4. the custom_tool_call is captured as a toolCall keyed by its call_id (the id that
 *    actually links call to output - the tool call's own `id` field does not)
 * 5. the custom_tool_call_output text is findable by that same call_id
 * 6. a file with no parseable JSON lines returns null
 * 7. locateSessionFilesUnder matches by session_meta's cwd, across a date-partitioned tree
 *    (codex has no per-project directory at all - every session sorts under YYYY/MM/DD)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexAdapter, locateSessionFilesUnder } from '../../lib/sessions/adapters/codex.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'sessions', 'codex', 'retry-policy-decision.jsonl');

describe('codexAdapter.parseSession', () => {
  it('reads the real fixture into the canonical shape', () => {
    const session = codexAdapter.parseSession(FIXTURE);
    expect(session).not.toBeNull();
    expect(session!.agent).toBe('codex');
    expect(session!.sessionId).toBe('01a06786-784e-7481-88cf-111de4ca04e3');
    expect(session!.cwd).toBe('/home/user/webhook-service');
  });

  it("skips developer-role messages (Codex's own system prompt) - only user/assistant remain", () => {
    const session = codexAdapter.parseSession(FIXTURE)!;
    expect(session.turns.every(t => t.role === 'user' || t.role === 'assistant')).toBe(true);
    expect(session.turns.some(t => t.text.includes('Read NOTES.md'))).toBe(true);
  });

  it('captures real user/assistant text from input_text/output_text content blocks', () => {
    const session = codexAdapter.parseSession(FIXTURE)!;
    const finalAnswer = session.turns.find(t => t.text.includes('Decision:'));
    expect(finalAnswer?.text).toMatch(/3 retries/);
  });

  it("captures the custom_tool_call, keyed by its call_id (not its own 'id' field)", () => {
    const session = codexAdapter.parseSession(FIXTURE)!;
    const withTool = session.turns.find(t => t.toolCalls.length > 0);
    expect(withTool).toBeDefined();
    expect(withTool!.toolCalls[0].id).toBe('call_Kn1O49yzP5pOwmqCKPeyh8eE');
    expect(withTool!.toolCalls[0].name).toBe('exec');
  });

  it('the tool_call_output text is findable by the same call_id', () => {
    const session = codexAdapter.parseSession(FIXTURE)!;
    const callId = session.turns.flatMap(t => t.toolCalls)[0].id;
    const withResult = session.turns.find(t => callId in t.toolResults);
    expect(withResult).toBeDefined();
    expect(withResult!.toolResults[callId]).toMatch(/Retry policy notes/);
  });

  it('returns null for a file with no parseable JSON lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'align-codex-bad-'));
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, 'nope\n');
    expect(codexAdapter.parseSession(bad)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('locateSessionFilesUnder (codex)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'align-codex-root-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('matches by session_meta cwd across a date-partitioned tree (no per-project directory)', () => {
    const day1 = join(root, '2026', '09', '01');
    mkdirSync(day1, { recursive: true });
    writeFileSync(join(day1, 'rollout-a.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'a', cwd: '/home/user/my-project' } })}\n`);
    const day2 = join(root, '2026', '09', '02');
    mkdirSync(day2, { recursive: true });
    writeFileSync(join(day2, 'rollout-b.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'b', cwd: '/home/user/other' } })}\n`);
    expect(locateSessionFilesUnder(root, '/home/user/my-project')).toEqual([join(day1, 'rollout-a.jsonl')]);
  });
});
