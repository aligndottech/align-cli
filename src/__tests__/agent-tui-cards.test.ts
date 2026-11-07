import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { commandCard, gateCard, gateNote, headerLine, toolLine } from '../lib/agent/tui/cards.js';
import type { HumanQuestion } from '../lib/agent/permission-broker.js';
import type { ToolAsk } from '../lib/agent/types.js';

// Strip colour so the assertions read the words, not the escape codes.
const plain = (lines: string[]) => stripVTControlCharacters(lines.join('\n'));

const RULE = { id: 'd-7089', title: 'Error handler keeps only status codes 400-599', why: 'Codes below 400 fall back to 500', url: 'https://github.com/fastify/fastify/pull/7089', via: 'verdict' as const };
const OLD = { id: 'd-601', title: 'Do not allow a status code lower than 400', why: 'Since 2018', url: 'https://github.com/fastify/fastify/pull/601', via: 'blame' as const };
const ask: ToolAsk = { id: 'e1', tool: 'Edit', kind: 'edit' };
const gateQ = (reason: 'conflict' | 'rewrites-decided-lines', cards = [RULE]): Extract<HumanQuestion, { kind: 'gate' }> =>
  ({ kind: 'gate', outcome: { kind: 'ask', reason, cards }, ask });

describe('gate card', () => {
  it('leads a conflict with the conflict line and carries title, why, url and the key line', () => {
    const text = plain(gateCard(gateQ('conflict')));
    expect(text.split('\n')[0]).toContain('This edit conflicts with a decision');
    expect(text).toContain(RULE.title);
    expect(text).toContain(RULE.why);
    expect(text).toContain(RULE.url);
    expect(text).toContain('[a] allow once   [s] stop');
  });

  it('says the edit changes lines written by a decision for the rewrites reason', () => {
    const text = plain(gateCard(gateQ('rewrites-decided-lines', [OLD])));
    expect(text).toContain('changes lines written by');
    expect(text).not.toContain('conflicts with a decision');
    expect(text).toContain(OLD.url);
  });

  it('lists every decision when there are two', () => {
    const text = plain(gateCard(gateQ('conflict', [RULE, OLD])));
    for (const d of [RULE, OLD]) for (const part of [d.title, d.why, d.url]) expect(text).toContain(part);
  });

  it('skips the why and url lines a decision does not have', () => {
    const text = plain(gateCard(gateQ('conflict', [{ id: 'x', title: 'Bare decision', via: 'retrieval' }])));
    expect(text).toContain('Bare decision');
    expect(text).not.toContain('undefined');
  });
});

describe('command card', () => {
  it('shows the command and the three keys', () => {
    const text = plain(commandCard({ kind: 'command', command: 'npm publish', ask }));
    expect(text).toContain('npm publish');
    expect(text).toContain('[y] yes   [s] yes for this session   [n] no');
  });
  it('shows a different command', () => {
    expect(plain(commandCard({ kind: 'command', command: 'rm -rf dist', ask }))).toContain('rm -rf dist');
  });
});

describe('gate note for an allowed edit', () => {
  it('says nothing when there were no cards and nothing went unchecked', () => {
    expect(gateNote({ kind: 'allow', cards: [] })).toEqual([]);
  });
  it('names the titles of retrieval and blame cards on one line', () => {
    const lines = gateNote({ kind: 'allow', cards: [{ ...RULE, via: 'retrieval' }, OLD] });
    expect(lines).toHaveLength(1);
    expect(plain(lines)).toBe(`checked against: ${RULE.title}, ${OLD.title}`);
  });
  it('names a single title', () => {
    expect(plain(gateNote({ kind: 'allow', cards: [OLD] }))).toBe(`checked against: ${OLD.title}`);
  });
  it('is never silent when the edit was not checked', () => {
    expect(plain(gateNote({ kind: 'allow', cards: [], note: 'not-checked' }))).toBe('not checked against the decision graph');
    expect(gateNote({ kind: 'allow', cards: [OLD], note: 'not-checked' }).length).toBeGreaterThan(0);
  });
});

describe('header line', () => {
  it('has the engine label and the decision count', () => {
    expect(plain([headerLine({ label: 'Claude Code', decisionCount: 749 })])).toBe('Align · Claude Code · 749 decisions');
  });
  it('uses the other engine label and count, and the singular', () => {
    expect(plain([headerLine({ label: 'Align engine', decisionCount: 12 })])).toBe('Align · Align engine · 12 decisions');
    expect(plain([headerLine({ label: 'Align engine', decisionCount: 1 })])).toBe('Align · Align engine · 1 decision');
  });
});

describe('tool line', () => {
  it('shows the tool and its summary when a tool starts', () => {
    expect(plain(toolLine({ type: 'tool-start', id: 't', tool: 'Edit', summary: 'lib/a.js' }))).toContain('Edit');
    expect(plain(toolLine({ type: 'tool-start', id: 't', tool: 'Bash', summary: 'npm test' }))).toContain('npm test');
  });
  it('says so when a tool fails, and stays quiet when it succeeds', () => {
    expect(plain(toolLine({ type: 'tool-end', id: 't', ok: false }))).toContain('failed');
    expect(toolLine({ type: 'tool-end', id: 't', ok: true })).toEqual([]);
  });
  it('shows why a tool failed when it said', () => {
    const text = plain(toolLine({ type: 'tool-end', id: 't', ok: false, detail: 'Exit code 1\nCannot find module avvio' }));
    expect(text).toContain('failed');
    expect(text).toContain('Exit code 1');
    expect(text).toContain('Cannot find module avvio');
  });
});
