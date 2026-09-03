/**
 * ALI-808 pi adapter, backed by a real captured session fixture (see
 * fixtures/sessions/README.md) - confirms empirically what the ticket's research already
 * found: pi's real tool vocabulary here is `bash` only, no question/choice tool.
 *
 * Test List:
 * 1. parseSession reads the real fixture: right agent/sessionId/cwd
 * 2. the session/model_change/thinking_level_change/custom_message lines are not turns
 * 3. the assistant turn's bash toolCall is captured
 * 4. the toolResult text is findable by the tool call's id, somewhere in the turns
 * 5. a file with no parseable JSON lines returns null
 * 6. locateSessionFilesUnder matches by the session line's cwd, ignores a non-matching one
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateSessionFilesUnder, piAdapter } from '../../lib/sessions/adapters/pi.js';
import { extractStructuredDecisions } from '../../lib/sessions/extract-structured.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'sessions', 'pi', 'kubectl-guard-check.jsonl');

describe('piAdapter.parseSession', () => {
  it('reads the real fixture into the canonical shape', () => {
    const session = piAdapter.parseSession(FIXTURE);
    expect(session).not.toBeNull();
    expect(session!.agent).toBe('pi');
    expect(session!.sessionId).toBe('01a052fb-1473-7bd8-a4a1-221145a61b71');
    expect(session!.cwd).toBe('/home/thomas/aligndottech/wt-agent-adapters');
  });

  it('skips session/model_change/thinking_level_change/custom_message lines - only real turns remain', () => {
    const session = piAdapter.parseSession(FIXTURE)!;
    expect(session.turns.map(t => t.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(session.turns[0].text).toMatch(/kubectl app'ly/);
  });

  it("captures the assistant turn's bash toolCall", () => {
    const session = piAdapter.parseSession(FIXTURE)!;
    const withTool = session.turns.find(t => t.toolCalls.length > 0);
    expect(withTool).toBeDefined();
    expect(withTool!.toolCalls[0]).toMatchObject({ name: 'bash' });
    expect((withTool!.toolCalls[0].arguments as { command: string }).command).toMatch(/kubectl apply/);
  });

  it('the toolResult text is findable by the tool call id somewhere in the turns', () => {
    const session = piAdapter.parseSession(FIXTURE)!;
    const callId = session.turns.flatMap(t => t.toolCalls).find(c => c.name === 'bash')!.id;
    const withResult = session.turns.find(t => callId in t.toolResults);
    expect(withResult).toBeDefined();
    expect(withResult!.toolResults[callId]).toMatch(/BLOCKED by guard-destructive-apply/);
  });

  it('has no AskUserQuestion-shaped candidates - pi has no structured question tool', () => {
    const session = piAdapter.parseSession(FIXTURE)!;
    expect(extractStructuredDecisions(session)).toEqual([]);
  });

  it('returns null for a file with no parseable JSON lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'align-pi-bad-'));
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, 'nope\n');
    expect(piAdapter.parseSession(bad)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('locateSessionFilesUnder (pi)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'align-pi-root-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('finds a session file whose header cwd matches, ignores one that does not', () => {
    const projDir = join(root, '--home-thomas-my-project--');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 's1.jsonl'), `${JSON.stringify({ type: 'session', id: 's1', cwd: '/home/thomas/my-project' })}\n`);
    const otherDir = join(root, '--home-thomas-other--');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 's2.jsonl'), `${JSON.stringify({ type: 'session', id: 's2', cwd: '/home/thomas/other' })}\n`);
    expect(locateSessionFilesUnder(root, '/home/thomas/my-project')).toEqual([join(projDir, 's1.jsonl')]);
  });
});
