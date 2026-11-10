import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cappedNote } from '../lib/capped-read.js';
import { SYNC_CEILINGS } from '../lib/import-defaults.js';
import { CUT_KINDS_BY_SOURCE } from '../lib/sync/run-source.js';

/**
 * Item 1 Test List (a read that hit its cap says so, and never prints the cap as the total):
 * - Exactly the cap read: said capped, with how many were read and the command that reads more (Linear 2,000; Jira 2,000: two examples).
 * - One under the cap: nothing to say.
 * - Every windowed connector has its own cap in the sentence, read from SYNC_CEILINGS (one table, one writer).
 * - A fetcher that says it did not reach the end (complete: false) is said too, even under the cap, and names no cap it did not hit.
 * - An explicit --limit smaller than the ceiling is the cap that was hit.
 * - The commands offered exist: `align sync <source>` and `align connect --source <source> --since 30d` (`align import` is retired, and
 *   `align connect` has no --limit, so neither is named).
 */
const WINDOWED = ['github', 'slack', 'jira', 'linear', 'gitlab', 'confluence', 'notion', 'teams', 'zoom'] as const;

describe('cappedNote', () => {
  it('Linear at exactly its ceiling says it was capped, how many were read, and how to read more', () => {
    const note = cappedNote({ source: 'linear', read: 2000 });
    expect(note).toContain('2,000');
    expect(note).toMatch(/capped|cap/i);
    expect(note).toContain('align connect --source linear --since 30d');
    expect(note).not.toMatch(/^Found/);
  });
  it('Jira at exactly its ceiling says the same with its own command', () => {
    expect(cappedNote({ source: 'jira', read: 2000 })).toContain('align sync jira');
    expect(cappedNote({ source: 'jira', read: 2000 })).toContain('align connect --source jira --since 30d');
  });
  it('one under the ceiling says nothing', () => {
    expect(cappedNote({ source: 'linear', read: 1999 })).toBeUndefined();
    expect(cappedNote({ source: 'github', read: 2999 })).toBeUndefined();
  });
  it.each(WINDOWED)('%s: capped at its own ceiling, from the one table', (source) => {
    const cap = SYNC_CEILINGS[source];
    const note = cappedNote({ source, read: cap });
    expect(note).toContain(cap.toLocaleString('en-US'));
    expect(note).toContain(`align connect --source ${source} --since 30d`);
    expect(cappedNote({ source, read: cap - 1 })).toBeUndefined();
  });
  it('a limit the person gave is the cap that was hit', () => {
    expect(cappedNote({ source: 'linear', read: 50, limit: 50 })).toContain('the cap is 50');
    expect(cappedNote({ source: 'linear', read: 49, limit: 50 })).toBeUndefined();
  });
  it('a fetcher that did not reach the end says more is there, without naming a cap it did not hit', () => {
    const note = cappedNote({ source: 'linear', read: 300, complete: false });
    expect(note).toContain('300');
    expect(note).toMatch(/stopped before the end/);
    expect(note).not.toMatch(/has more than this/);
    expect(note).not.toContain('2,000');
    expect(cappedNote({ source: 'linear', read: 300, complete: true })).toBeUndefined();
  });
  it('a source with no windowed cap (git, docs) says nothing', () => {
    expect(cappedNote({ source: 'docs', read: 500 })).toBeUndefined();
  });
});

describe('`align sync` is offered only where a sync really reads further back (CUT_KINDS_BY_SOURCE)', () => {
  const resumes = new Set(Object.keys(CUT_KINDS_BY_SOURCE));
  it('found the set (positive control: it is not empty and names jira)', () => {
    expect(resumes.has('jira')).toBe(true);
  });
  it.each(WINDOWED)('%s', (source) => {
    const note = cappedNote({ source, read: SYNC_CEILINGS[source] })!;
    if (resumes.has(source)) {
      expect(note).toContain(`align sync ${source}`);
    } else {
      // A sync would re-read the same newest items, so it is not offered, and the note says what was left out.
      expect(note).not.toContain('align sync');
      expect(note).toContain('oldest items were left out');
    }
  });
});

describe('every place that prints "Found N items" for a windowed read also says when it was capped', () => {
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands');
  const read = (f: string): string => readFileSync(path.join(SRC, f), 'utf8');
  it.each(WINDOWED)('align import %s calls sayIfCapped for itself, after its Found line', (source) => {
    const src = read(`import/${source}.ts`);
    const found = src.search(/spinner\.stop\(`Found \$\{items\.length\}/);
    const said = src.indexOf(`sayIfCapped({ source: '${source}'`);
    expect(found, `${source}.ts prints a Found line`).toBeGreaterThan(-1);
    expect(said, `${source}.ts says when capped`).toBeGreaterThan(found);
  });
  it('align setup says it for the source it just read', () => {
    const src = read('setup.ts');
    expect(src.indexOf('sayIfCapped({ source: source.id')).toBeGreaterThan(src.search(/spinner\.stop\(`Found \$\{items\.length\} items`\)/));
  });
});
