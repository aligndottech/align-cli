/**
 * MIRSAD export reader. Test list:
 * 1. a decision becomes one item: stable mirsad://decisions/<id> url, platform, title, author
 * 2. made_at: the bare "YYYY-MM-DD HH:MM" is the machine's local time; an ISO string with an offset or Z is used
 *    as given; a number is epoch seconds; made_at_utc, then made_at_offset, win over the bare string;
 *    anything else leaves created_at unset
 * 3. raw_text carries description, reasons, alternatives, evidence, effects, outcomes, labelled;
 *    empty sections are dropped
 * 4. supersedes links: number, array, null; superseded_by too; a pair seen from both ends counts once
 * 5. a link to an id not in the file is dropped, so is a self link
 * 6. not JSON, not an array: an error naming the problem
 * 7. an item without id or title is skipped and counted; nothing valid left is an error
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MirsadFileError, parseMirsadExport, readMirsadFile } from '../../lib/fetchers/mirsad.js';

const base = { description: '', status: 'accepted', made_by: 'o', made_at: '2026-11-16 17:14', supersedes: null, superseded_by: null, entities: [], reasons: [], evidence: [], alternatives_rejected: [], effects: [], outcomes: [] };
const dec = (id: number, extra: Record<string, unknown> = {}) => ({ ...base, id, title: `Decision ${id}`, ...extra });
const parse = (v: unknown) => parseMirsadExport(JSON.stringify(v));

describe('items', () => {
  it('maps a decision to one item with a stable url, author and local-time date', () => {
    const { items } = parse([dec(7, { made_by: 'koussay' }), dec(12)]);
    expect(items.map((i) => i.source_url)).toEqual(['mirsad://decisions/7', 'mirsad://decisions/12']);
    expect(items[0]).toMatchObject({ platform: 'mirsad', title: 'Decision 7', author: { name: 'koussay' } });
    expect(items[0]?.created_at).toBe(new Date(2026, 10, 16, 17, 14).toISOString());
  });

  it.each(['16/11/2026 17:14', '2026-02-30 10:00', '2026-11-16', '2026-11-16T17:14', '2026-02-30T10:00:00Z', '', 'x', true, null, Number.NaN, 1e20])('leaves created_at unset for %j', (made_at) => {
    const { items } = parse([dec(1, { made_at })]);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('created_at');
  });

  it('builds labelled raw_text and drops empty sections', () => {
    const { items } = parse([dec(1, {
      description: 'Use SQLite.', reasons: ['Offline', 'Inspectable'], alternatives_rejected: ['Hosted DB'],
      evidence: [{ text: 'Prototype ran offline', ref: null }, { text: 'Benchmark', ref: 'PR 4' }], effects: ['One file'], outcomes: ['Shipped'],
    }), dec(2, { description: 'Only this.' })]);
    expect(items[0]?.raw_text).toBe([
      'Use SQLite.', '', 'Reasons:', '- Offline', '- Inspectable', '', 'Alternatives rejected:', '- Hosted DB', '',
      'Evidence:', '- Prototype ran offline', '- Benchmark (PR 4)', '', 'Effects:', '- One file', '', 'Outcomes:', '- Shipped',
    ].join('\n'));
    expect(items[1]?.raw_text).toBe('Only this.');
  });
});

describe('made_at in the forms MIRSAD may send', () => {
  const at = (extra: Record<string, unknown>) => parse([dec(1, extra)]).items[0]?.created_at;

  it.each([['2026-11-16T17:14:00Z', '2026-11-16T17:14:00.000Z'], ['2026-11-16T17:14:00+01:00', '2026-11-16T16:14:00.000Z'], ['2026-11-16T17:14+05:30', '2026-11-16T11:44:00.000Z']])(
    'uses an ISO string with an offset or Z as given: %s', (made_at, iso) => {
      expect(at({ made_at })).toBe(iso);
    });

  it.each([[1763313240, '2025-11-16T17:14:00.000Z'], [0, '1970-01-01T00:00:00.000Z']])('reads a number as epoch seconds: %s', (made_at, iso) => {
    expect(at({ made_at })).toBe(iso);
  });

  it('prefers made_at_offset over the machine zone for the bare string', () => {
    expect(at({ made_at: '2026-11-16 17:14', made_at_offset: '+01:00' })).toBe('2026-11-16T16:14:00.000Z');
    expect(at({ made_at: '2026-11-16 17:14', made_at_offset: '-05:00' })).toBe('2026-11-16T22:14:00.000Z');
  });

  it('prefers made_at_utc over everything else', () => {
    expect(at({ made_at: '2026-11-16 17:14', made_at_offset: '+01:00', made_at_utc: '2026-11-16T09:00:00Z' })).toBe('2026-11-16T09:00:00.000Z');
    expect(at({ made_at: '2026-11-16 17:14', made_at_utc: 1763313240 })).toBe('2025-11-16T17:14:00.000Z');
  });

  it('falls back to the bare string when the offset or utc field is not usable, and ignores other field names', () => {
    const local = new Date(2026, 10, 16, 17, 14).toISOString();
    expect(at({ made_at: '2026-11-16 17:14', made_at_offset: 'CET' })).toBe(local);
    expect(at({ made_at: '2026-11-16 17:14', made_at_utc: 'soon' })).toBe(local);
    expect(at({ made_at: '2026-11-16 17:14', tz_offset: '+01:00', utc: '2026-11-16T09:00:00Z' })).toBe(local);
  });
});

describe('links', () => {
  it('reads supersedes as number, array or null, and superseded_by, once per pair', () => {
    const { links } = parse([dec(1, { superseded_by: 2 }), dec(2, { supersedes: 1 }), dec(3, { supersedes: [1, 2] }), dec(4, { supersedes: null })]);
    expect(links.map((l) => [l.newer, l.older]).sort()).toEqual([[2, 1], [3, 1], [3, 2]]);
  });

  it('drops links to ids outside the file and links to itself', () => {
    const { links } = parse([dec(1, { supersedes: 99 }), dec(2, { supersedes: 2 }), dec(3, { superseded_by: [98, 'x', null] }), dec(4, { supersedes: 1 })]);
    expect(links).toEqual([{ newer: 4, older: 1 }]);
  });
});

describe('malformed input', () => {
  it('names the problem for non-JSON and non-array', () => {
    expect(() => parseMirsadExport('{nope')).toThrow(/not valid JSON/);
    expect(() => parse({ id: 1 })).toThrow(/array of decisions/);
  });

  it('skips and counts items without id or title, but fails when nothing valid is left', () => {
    const r = parse([dec(1), { ...dec(2), title: '' }, { ...dec(3), id: undefined }, 'junk', null]);
    expect(r.items).toHaveLength(1);
    expect(r.skipped).toBe(4);
    expect(() => parse([{ title: 'x' }])).toThrow(MirsadFileError);
    expect(() => parse([])).toThrow(/no valid decisions/);
  });
});

describe('the real sample', () => {
  it('reads three decisions and one link: 2 supersedes 1', async () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mirsad', 'sample.json');
    const r = await readMirsadFile(file);
    expect(r.items.map((i) => i.source_url)).toEqual(['mirsad://decisions/1', 'mirsad://decisions/2', 'mirsad://decisions/3']);
    expect(r.links).toEqual([{ newer: 2, older: 1 }]);
  });
});
