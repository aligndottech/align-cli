// The decisions file is read back by a parser, not by a model: `align check --decisions-file` takes its
// decisions from it, so a wrong parse is a wrong gate. The renderer (renderDecisionsFile) is the only
// writer of the format, so the round trip through it is the contract.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ContextDecision, renderDecisionsFile } from '../lib/decisions-context.js';
import { DecisionsFileError, parseDecisionsFile, readDecisionsFile } from '../lib/decisions-file.js';

const rule: ContextDecision = {
  title: 'Never call the network from a unit test',
  cite: 'acme/app#12',
  sourceUrl: 'https://github.com/acme/app/pull/12',
  reason: 'Tests that touch the network flake on CI.',
  kind: 'rule',
};
const choice: ContextDecision = {
  title: 'Use SQLite for the local store',
  cite: 'acme/app#40',
  sourceUrl: 'https://github.com/acme/app/pull/40',
  kind: 'decision',
};
const bare: ContextDecision = { title: 'Pin the Node floor at 22', kind: 'decision' };

describe('parseDecisionsFile: what the renderer wrote', () => {
  it('reads a rule back with its title, cite, link and reason', () => {
    const [d] = parseDecisionsFile(renderDecisionsFile([rule]));
    expect(d).toEqual({
      kind: 'rule',
      title: 'Never call the network from a unit test',
      cite: 'acme/app#12',
      url: 'https://github.com/acme/app/pull/12',
      why: 'Tests that touch the network flake on CI.',
    });
  });

  it('reads a decision with no reason, and one with no cite or link', () => {
    const parsed = parseDecisionsFile(renderDecisionsFile([choice, bare]));
    const byTitle = (t: string) => parsed.find((d) => d.title === t);
    expect(parsed).toHaveLength(2);
    expect(byTitle('Use SQLite for the local store')).toEqual({ kind: 'decision', title: 'Use SQLite for the local store', cite: 'acme/app#40', url: 'https://github.com/acme/app/pull/40' });
    expect(byTitle('Pin the Node floor at 22')).toEqual({ kind: 'decision', title: 'Pin the Node floor at 22' });
  });

  it('keeps rules and decisions apart, whatever order the renderer puts them in', () => {
    const parsed = parseDecisionsFile(renderDecisionsFile([choice, rule, bare]));
    expect(parsed.filter((d) => d.kind === 'rule').map((d) => d.title)).toEqual([rule.title]);
    expect(parsed.filter((d) => d.kind === 'decision')).toHaveLength(2);
  });

  it('a title that itself contains " - " and parentheses is not cut short', () => {
    const [d] = parseDecisionsFile(renderDecisionsFile([{ title: 'Retry (max 3) - never loop forever', cite: 'a/b#1', sourceUrl: 'https://x.test/1', kind: 'decision' }]));
    expect(d?.title).toBe('Retry (max 3) - never loop forever');
    expect(d?.cite).toBe('a/b#1');
    expect(d?.url).toBe('https://x.test/1');
  });

  it('a scoped package name in parentheses stays in the title; it is not a citation', () => {
    const [d] = parseDecisionsFile(renderDecisionsFile([{ title: 'Use the shared auth package (@acme/auth)', kind: 'decision' }]));
    expect(d?.title).toBe('Use the shared auth package (@acme/auth)');
    expect(d).not.toHaveProperty('cite');
  });

  it('still reads a commit cite (repo@sha) and a package name together', () => {
    const [d] = parseDecisionsFile(renderDecisionsFile([{ title: 'Pin (@acme/auth) to v2', cite: 'cli@abc1234', kind: 'decision' }]));
    expect(d).toMatchObject({ title: 'Pin (@acme/auth) to v2', cite: 'cli@abc1234' });
  });

  it('a hosted graph file (one list, no section headings) parses too', () => {
    const parsed = parseDecisionsFile(renderDecisionsFile([{ title: 'Ship on Tuesdays' }, { title: 'No Friday deploys' }]));
    expect(parsed.map((d) => d.title).sort()).toEqual(['No Friday deploys', 'Ship on Tuesdays']);
  });

  it('does not govern with the agent-decided, unratified section or the left-out line', () => {
    const text = renderDecisionsFile(
      [choice, { title: 'An agent said to use Redis', deciderKind: 'agent', kind: 'decision' }],
      { leftOut: 7 },
    );
    const parsed = parseDecisionsFile(text);
    expect(parsed.map((d) => d.title)).toEqual(['Use SQLite for the local store']);
  });

  it('a reason that wraps onto a second indented line stays one reason', () => {
    const text = '# Decisions\n\n## Decisions, with the reason given where there is one\n\n- Cap the pool\n  Why: Postgres allows 100 connections\n  and we run four services.\n';
    expect(parseDecisionsFile(text)[0]?.why).toBe('Postgres allows 100 connections and we run four services.');
  });
});

describe('parseDecisionsFile: a file that yields nothing is an error, never "no conflicts"', () => {
  it.each([
    ['an empty file', ''],
    ['only whitespace', '\n  \n'],
    ['prose with no bullets', '# Notes\n\nWe should write some decisions down one day.\n'],
    ['the file `align up` writes for an empty graph', renderDecisionsFile([])],
    ['a file holding only unratified agent claims', renderDecisionsFile([{ title: 'An agent said so', deciderKind: 'agent' }])],
  ])('%s', (_name, text) => {
    expect(() => parseDecisionsFile(text)).toThrow(DecisionsFileError);
  });

  it('the error says what was wrong and which reason code a machine can read', () => {
    try {
      parseDecisionsFile('# Notes\n\nnothing here\n');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DecisionsFileError).reason).toBe('decisions_file_empty');
      expect((err as Error).message).toMatch(/no decisions/i);
    }
  });
});

describe('readDecisionsFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'align-decisions-file-'));

  it('reads and parses a file on disk', () => {
    const file = join(dir, 'DECISIONS.md');
    writeFileSync(file, renderDecisionsFile([rule]));
    expect(readDecisionsFile(file)).toHaveLength(1);
  });

  it('a file that is not there is an unreadable-file error naming the path', () => {
    const file = join(dir, 'missing.md');
    try {
      readDecisionsFile(file);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionsFileError);
      expect((err as DecisionsFileError).reason).toBe('decisions_file_unreadable');
      expect((err as Error).message).toContain(file);
    }
  });

  it('a directory is unreadable too, not an empty file', () => {
    expect(() => readDecisionsFile(dir)).toThrow(DecisionsFileError);
  });
});
