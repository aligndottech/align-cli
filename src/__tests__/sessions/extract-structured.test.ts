/**
 * ALI-808 Pass A: a decision-shaped tool call, matched with its answer. Today only
 * Claude Code's AskUserQuestion fires - built as a per-agent producer list so a second
 * agent's structured signal slots in without a rewrite (per the ticket's own design note).
 *
 * The answer-parsing regex below is calibrated against three REAL tool_result strings
 * pulled from local Claude Code session files during this session's own research (not
 * invented): "The user answered: \"Q\"=\"A\". Read the answers carefully...",
 * "Your questions have been answered: \"Q\"=\"A\". You can now continue...", and the
 * rejection message "The user doesn't want to proceed with this tool use...".
 *
 * Test List:
 * 1. an answered AskUserQuestion (single question) yields one candidate, chosen label set
 * 2. the "Your questions have been answered" phrasing parses the same way
 * 3. a REJECTED AskUserQuestion (no answer) yields no candidate - nothing was decided
 * 4. an AskUserQuestion with no tool_result at all (session still open) yields no candidate
 * 5. a free-text answer that matches no listed option's label is still captured verbatim
 *    (Claude Code's "Other" - a real answer, not a parse failure)
 * 6. two AskUserQuestion calls in one session yield two candidates, not one
 * 7. an agent with no structured producer (pi, codex, opencode canonical shape) yields []
 */
import { describe, expect, it } from 'vitest';
import { extractStructuredDecisions } from '../../lib/sessions/extract-structured.js';
import type { CanonicalSession } from '../../lib/sessions/types.js';

function askTurn(id: string, question: string, options: Array<{ label: string; description?: string }>): CanonicalSession['turns'][number] {
  return {
    role: 'assistant',
    text: '',
    toolCalls: [{ id, name: 'AskUserQuestion', arguments: { questions: [{ question, header: 'h', options }] } }],
    toolResults: {},
    timestamp: '2026-09-03T00:00:00.000Z',
  };
}

function resultTurn(id: string, text: string): CanonicalSession['turns'][number] {
  return { role: 'user', text: '', toolCalls: [], toolResults: { [id]: text }, timestamp: '2026-09-03T00:00:05.000Z' };
}

const OPTIONS = [{ label: 'Fold the one-line fix into my PR', description: 'd1' }, { label: 'Put it on its own PR', description: 'd2' }];

describe('extractStructuredDecisions: Claude Code AskUserQuestion', () => {
  it('an answered question yields one candidate with the chosen label', () => {
    const session: CanonicalSession = {
      agent: 'claude-code', sessionId: 's1', cwd: null,
      turns: [
        askTurn('t1', 'How do you want the fix handled?', OPTIONS),
        resultTurn('t1', 'The user answered: "How do you want the fix handled?"="Fold the one-line fix into my PR". Read the answers carefully - they may request clarification.'),
      ],
    };
    const candidates = extractStructuredDecisions(session);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      agent: 'claude-code', sessionId: 's1', messageId: 't1',
      question: 'How do you want the fix handled?',
      chosenLabel: 'Fold the one-line fix into my PR',
    });
    expect(candidates[0].options).toEqual(OPTIONS.map(o => ({ label: o.label, description: o.description })));
  });

  it('the "Your questions have been answered" phrasing parses the same way', () => {
    const session: CanonicalSession = {
      agent: 'claude-code', sessionId: 's1', cwd: null,
      turns: [
        askTurn('t1', 'How do you want the fix handled?', OPTIONS),
        resultTurn('t1', 'Your questions have been answered: "How do you want the fix handled?"="Put it on its own PR". You can now continue with these answers in mind.'),
      ],
    };
    expect(extractStructuredDecisions(session)[0].chosenLabel).toBe('Put it on its own PR');
  });

  it('a rejected question (declined, not answered) yields no candidate', () => {
    const session: CanonicalSession = {
      agent: 'claude-code', sessionId: 's1', cwd: null,
      turns: [
        askTurn('t1', 'How do you want the fix handled?', OPTIONS),
        resultTurn('t1', "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP what you are doing and wait for the user to tell you how to proceed."),
      ],
    };
    expect(extractStructuredDecisions(session)).toEqual([]);
  });

  it('a question with no recorded tool_result (session still open) yields no candidate', () => {
    const session: CanonicalSession = { agent: 'claude-code', sessionId: 's1', cwd: null, turns: [askTurn('t1', 'Q?', OPTIONS)] };
    expect(extractStructuredDecisions(session)).toEqual([]);
  });

  it('a free-text answer matching no listed option (the "Other" case) is captured verbatim', () => {
    const session: CanonicalSession = {
      agent: 'claude-code', sessionId: 's1', cwd: null,
      turns: [
        askTurn('t1', 'Which did you mean?', [{ label: 'pi.dev' }, { label: 'raspberry pi' }]),
        resultTurn('t1', 'The user answered: "Which did you mean?"="i meant https://pi.dev/ but not the raspberry kind". Read the answers carefully.'),
      ],
    };
    expect(extractStructuredDecisions(session)[0].chosenLabel).toBe('i meant https://pi.dev/ but not the raspberry kind');
  });

  it('two AskUserQuestion calls in one session yield two candidates', () => {
    const session: CanonicalSession = {
      agent: 'claude-code', sessionId: 's1', cwd: null,
      turns: [
        askTurn('t1', 'Q1?', OPTIONS),
        resultTurn('t1', 'The user answered: "Q1?"="Fold the one-line fix into my PR". Read the answers carefully.'),
        askTurn('t2', 'Q2?', OPTIONS),
        resultTurn('t2', 'The user answered: "Q2?"="Put it on its own PR". Read the answers carefully.'),
      ],
    };
    const candidates = extractStructuredDecisions(session);
    expect(candidates).toHaveLength(2);
    expect(candidates.map(c => c.messageId)).toEqual(['t1', 't2']);
  });
});

describe('extractStructuredDecisions: agents with no structured producer yet', () => {
  it.each(['pi', 'codex', 'opencode', 'gemini-cli', 'cursor'] as const)('%s yields no candidates, by design', (agent) => {
    const session: CanonicalSession = {
      agent, sessionId: 's1', cwd: null,
      turns: [{ role: 'assistant', text: '', toolCalls: [{ id: 'x', name: 'bash', arguments: { command: 'ls' } }], toolResults: {}, timestamp: null }],
    };
    expect(extractStructuredDecisions(session)).toEqual([]);
  });
});

describe('extractStructuredDecisions: end-to-end against the real fixture', () => {
  it('the real claude-code fixture (parsed by the real adapter) yields the real chosen answer', async () => {
    const { claudeCodeAdapter } = await import('../../lib/sessions/adapters/claude-code.js');
    const { join } = await import('node:path');
    const fixture = join(__dirname, '..', 'fixtures', 'sessions', 'claude-code', 'main-red-fix-decision.jsonl');
    const session = claudeCodeAdapter.parseSession(fixture)!;
    const candidates = extractStructuredDecisions(session);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].chosenLabel).toBe('Fold the one-line fix into my PR');
    expect(candidates[0].options.map(o => o.label)).toContain('Put it on the ali-734 worktree as its own PR');
  });
});
