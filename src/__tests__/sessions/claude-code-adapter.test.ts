/**
 * ALI-808 Claude Code adapter, backed by a real trimmed session fixture (see
 * fixtures/sessions/README.md).
 *
 * Test List:
 * 1. parseSession reads the real fixture: right agent/sessionId/cwd, turns in order
 * 2. the user turn's text is the turn's own words, not a tool result
 * 3. the AskUserQuestion tool call is captured on its assistant turn
 * 4. the matching tool_result text is captured, keyed by the tool call's id
 * 5. a file with no parseable JSON lines returns null, not a throw
 * 6. locateSessionFilesUnder finds a file whose embedded cwd matches, ignores one that doesn't
 * 7. a sessions root that does not exist yields no files
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter, locateSessionFilesUnder } from '../../lib/sessions/adapters/claude-code.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'sessions', 'claude-code', 'main-red-fix-decision.jsonl');

describe('claudeCodeAdapter.parseSession', () => {
  it('reads the real fixture into the canonical shape', () => {
    const session = claudeCodeAdapter.parseSession(FIXTURE);
    expect(session).not.toBeNull();
    expect(session!.agent).toBe('claude-code');
    expect(session!.sessionId).toBe('e492e4bb-afa3-4f4d-b33b-d6a0fe2aa87c');
    expect(session!.cwd).toBe('/home/thomas/aligndottech/align-stack');
    expect(session!.turns).toHaveLength(4);
    expect(session!.turns.map(t => t.role)).toEqual(['user', 'assistant', 'assistant', 'user']);
  });

  it("a plain user turn's text is its own words, not a tool result", () => {
    const session = claudeCodeAdapter.parseSession(FIXTURE)!;
    expect(session.turns[0].text).toMatch(/main is broken by ALI-734/);
    expect(session.turns[0].toolCalls).toEqual([]);
  });

  it('captures the AskUserQuestion tool call on its assistant turn', () => {
    const session = claudeCodeAdapter.parseSession(FIXTURE)!;
    const turn = session.turns[2];
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].name).toBe('AskUserQuestion');
    const input = turn.toolCalls[0].arguments as { questions: Array<{ question: string }> };
    expect(input.questions[0].question).toMatch(/main is broken by ALI-734/);
  });

  it('captures the matching tool_result text, keyed by the tool call id', () => {
    const session = claudeCodeAdapter.parseSession(FIXTURE)!;
    const askTurn = session.turns[2];
    const resultTurn = session.turns[3];
    const id = askTurn.toolCalls[0].id;
    expect(resultTurn.toolResults[id]).toMatch(/Fold the one-line fix into my PR/);
  });

  it('returns null for a file with no parseable JSON lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'align-cc-bad-'));
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, 'not json\nalso not json\n');
    expect(claudeCodeAdapter.parseSession(bad)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('locateSessionFilesUnder', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'align-cc-root-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('finds a session file whose embedded cwd matches, and ignores one that does not', () => {
    const projDir = join(root, '-home-thomas-my-project');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'sess1.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: '/home/thomas/my-project', sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })}\n`,
    );
    const otherDir = join(root, '-home-thomas-other-project');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      join(otherDir, 'sess2.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: '/home/thomas/other-project', sessionId: 's2', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })}\n`,
    );
    const found = locateSessionFilesUnder(root, '/home/thomas/my-project');
    expect(found).toEqual([join(projDir, 'sess1.jsonl')]);
  });

  it('a sessions root that does not exist yields no files', () => {
    expect(locateSessionFilesUnder(join(root, 'nope'), '/anything')).toEqual([]);
  });
});
