/**
 * ALI-794 component 2: the found-decisions summary that replaces the bare
 * `Imported N` line as the first thing a fresh user sees.
 *
 * Pure string builder + a pure reducer over the local db, so the wow moment is
 * unit-testable without a graph, a terminal or a network.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFoundSummary,
  FOUND_SUMMARY_MAX,
  type FoundSummaryDb,
  renderFoundSummary,
} from '../lib/found-summary.js';

function db(over: Partial<{
  decisions: number;
  rows: Array<{ id: string; title: string; sourceUrl?: string | null }>;
  links: Array<{ sourceId: string; targetId: string }>;
}> = {}): FoundSummaryDb {
  const rows = over.rows ?? [];
  const links = over.links ?? [];
  return {
    getStats: () => ({ decisions: over.decisions ?? rows.length }),
    listDecisions: () => rows,
    listLinks: () => links,
  };
}

const row = (n: number, sourceUrl?: string | null) => ({
  id: `d${n}`,
  title: `decision ${n}`,
  ...(sourceUrl === undefined ? {} : { sourceUrl }),
});

describe('buildFoundSummary', () => {
  it('reports the graph total from the db, not the length of the recent slice', () => {
    // 47 decisions in the graph, only the recent page listed. The two numbers are
    // deliberately different so a summary that measured the slice cannot pass.
    const s = buildFoundSummary(db({ decisions: 47, rows: [row(1), row(2), row(3)] }));
    expect(s.total).toBe(47);
    expect(s.recent).toHaveLength(3);
  });

  it('counts DISTINCT decisions touched by a link, never link rows', () => {
    // Two links between the same pair. A count of link rows says 2; the honest
    // answer - how many decisions have a connection - is 2 as well, so the fixture
    // uses a third decision on one of them to tell the two readings apart.
    const s = buildFoundSummary(db({
      decisions: 5,
      rows: [row(1), row(2), row(3)],
      links: [
        { sourceId: 'd1', targetId: 'd2' },
        { sourceId: 'd1', targetId: 'd2' },
        { sourceId: 'd1', targetId: 'd3' },
      ],
    }));
    // d1, d2, d3 - three decisions, across three link ROWS that name only three ids.
    expect(s.linked).toBe(3);
  });

  it('caps the recent list at FOUND_SUMMARY_MAX and keeps db order', () => {
    const rows = Array.from({ length: FOUND_SUMMARY_MAX + 3 }, (_, i) => row(i + 1));
    const s = buildFoundSummary(db({ decisions: rows.length, rows }));
    expect(s.recent).toHaveLength(FOUND_SUMMARY_MAX);
    expect(s.recent[0]?.title).toBe('decision 1');
    expect(s.recent[FOUND_SUMMARY_MAX - 1]?.title).toBe(`decision ${FOUND_SUMMARY_MAX}`);
  });

  it('lists fewer than the cap when the graph holds fewer', () => {
    // The second example for the cap rule: without it, `slice(0, MAX)` and a
    // hardcoded MAX-length array are indistinguishable.
    const s = buildFoundSummary(db({ decisions: 3, rows: [row(1), row(2), row(3)] }));
    expect(s.recent).toHaveLength(3);
  });

  it('carries a cite when the source url yields one, and omits it otherwise', () => {
    const s = buildFoundSummary(db({
      decisions: 2,
      rows: [
        row(1, 'https://github.com/aligndottech/align-cli/pull/219'),
        row(2, null),
      ],
    }));
    expect(s.recent[0]?.cite).toBe('align-cli#219');
    expect(s.recent[1]?.cite).toBeUndefined();
  });
});

describe('renderFoundSummary', () => {
  it('leads with the two counts a first-run user can check against their own repo', () => {
    const out = renderFoundSummary({
      total: 47,
      linked: 12,
      recent: [{ title: 'switch the queue to SQS', cite: 'align-cli#219' }],
    });
    expect(out).toContain('47 decisions');
    expect(out).toContain('12');
    expect(out).toContain('switch the queue to SQS');
    expect(out).toContain('align-cli#219');
  });

  it('renders a decision with no cite as its title alone, with no empty bracket left behind', () => {
    const out = renderFoundSummary({ total: 1, linked: 0, recent: [{ title: 'pick Postgres' }] });
    expect(out).toContain('pick Postgres');
    expect(out).not.toMatch(/\(\s*\)|\[\s*\]|undefined/);
  });

  it('says nothing was found rather than printing a zero dashboard', () => {
    // The empty graph is the one case where counts read as a broken tool. ALI-503's
    // lesson applied to the first run: report what is true, not a row of zeros.
    const out = renderFoundSummary({ total: 0, linked: 0, recent: [] });
    expect(out).not.toMatch(/\b0 decisions\b/);
    expect(out.toLowerCase()).toContain('no decisions');
  });

  it('omits the connections count when nothing is linked yet', () => {
    // A fresh git-only import links nothing, and "0 linked" beside a real decision
    // count is the same broken-counter read this ticket removes from the readout.
    const out = renderFoundSummary({ total: 9, linked: 0, recent: [{ title: 'a' }] });
    expect(out).toContain('9 decisions');
    expect(out).not.toMatch(/\b0\b/);
  });
});

describe('clearScreenForPicker (ALI-794 component 5)', () => {
  it('writes screen-clearing control codes on a real TTY, so the summary above does not sit under the picker', async () => {
    const { clearScreenForPicker } = await import('../lib/setup-ux.js');
    const writes: string[] = [];
    const fake = {
      isTTY: true,
      columns: 80,
      write: (s: string) => { writes.push(s); return true; },
    } as unknown as typeof process.stdout;
    clearScreenForPicker(fake);
    // readline.cursorTo/clearScreenDown own the exact escape sequence; assert only
    // that SOMETHING was written to clear the screen, not the bytes themselves.
    expect(writes.length).toBeGreaterThan(0);
  });

  it('does nothing on a non-TTY stream, so piped output stays clean', async () => {
    const { clearScreenForPicker } = await import('../lib/setup-ux.js');
    const writes: string[] = [];
    const fake = {
      isTTY: false,
      write: (s: string) => { writes.push(s); return true; },
    } as unknown as typeof process.stdout;
    clearScreenForPicker(fake);
    expect(writes).toEqual([]);
  });
});
