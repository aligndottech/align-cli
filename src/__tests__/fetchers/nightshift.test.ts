/**
 * Reading nightshift's parking lot (github.com/orwa-mahmoud/nightshift). The agent parks a
 * decision it could not settle as one `- ` bullet below the `---` rule: context · the default it
 * chose · why, with `Default:` and `Rollback:` lines under it. The owner closes it by appending a
 * disposition: ` · answered: <decision>`, `accepted-tradeoff`, `rejected-because`, `fixed` or
 * `ignored`. Archive files closed entries under `.nightshift/archive/`.
 *
 * Test List:
 * 1. an answered entry is one decision: titled by its question, carrying the default, the why and the answer
 * 2. two answered entries are two decisions
 * 3. an open entry (no disposition) is not imported, and is counted as open
 * 4. fixed and ignored entries are not decisions, and neither is an answer of "later"
 * 5. accepted-tradeoff and rejected-because are decisions, and say which
 * 6. Default:, Rollback: and indented lines belong to the entry above them
 * 7. the template text above the rule, a Filed: pointer and a paragraph are not entries
 * 8. the same question answered later keeps one identity, so a re-import updates it
 * 9. a trailing date is the decision date; otherwise a date in the archive folder name
 * 10. readNightshift finds live and archived parking lots, in the folder layout and the older flat one,
 *     and keeps one decision per question
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseParkingLot, readNightshift } from '../../lib/fetchers/nightshift.js';

const TEMPLATE = [
  '# Parking Lot',
  '',
  '> Decisions for the owner. During a shift the agent parks here instead of asking - one short,',
  '> plain-language entry per decision, written for a human.',
  '',
  '**Each entry** is one `- ` bullet below the rule: a sentence or two of context · the',
  'production-grade default chosen so work could continue · why it was chosen.',
  '',
  '---',
  '',
].join('\n');

const lot = (...entries: string[]) => `${TEMPLATE}${entries.join('\n')}\n`;

describe('parseParkingLot', () => {
  it('an answered entry is one decision, titled by its question, carrying the default, the why and the answer', () => {
    const { items } = parseParkingLot(lot('- Ship the flag on? · kept it off · a flip changes what users see · answered: yes, behind the setting'));
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Ship the flag on?');
    expect(items[0]!.platform).toBe('nightshift');
    expect(items[0]!.raw_text).toContain('Answered: yes, behind the setting');
    expect(items[0]!.raw_text).toContain("Agent's default: kept it off");
    expect(items[0]!.raw_text).toContain('Why: a flip changes what users see');
  });

  it('two answered entries are two decisions', () => {
    const { items } = parseParkingLot(lot('- Ship the flag on? · answered: yes', '- Rename the flag? · answered: keep the name'));
    expect(items.map((i) => i.title)).toEqual(['Ship the flag on?', 'Rename the flag?']);
  });

  it('an open entry is not imported, and is counted as open', () => {
    const { items, open } = parseParkingLot(lot('- Bump the minimum Node? · moved to 20 · 18 is end of life', '- Rename the flag? · answered: keep the name'));
    expect(items.map((i) => i.title)).toEqual(['Rename the flag?']);
    expect(open).toBe(1);
  });

  it('fixed and ignored entries are not decisions, and neither is an answer of "later"', () => {
    const { items, open } = parseParkingLot(lot(
      '- [notice] the watchman restarted · ignored',
      '- the build broke on Windows · fixed in abc1234',
      '- Drop the old endpoint? · answered: later',
      '- Keep the cache? · answered: yes',
    ));
    expect(items.map((i) => i.title)).toEqual(['Keep the cache?']);
    expect(open).toBe(1); // "later" is still waiting on the owner
  });

  it('accepted-tradeoff and rejected-because are decisions, and say which', () => {
    const { items } = parseParkingLot(lot(
      '- Allow a slower test run? · kept the full suite · coverage first · accepted-tradeoff: CI takes two minutes longer',
      '- Vendor the parser? · vendored it · no network in CI · rejected-because: we pin it in the lockfile instead',
    ));
    expect(items).toHaveLength(2);
    expect(items[0]!.raw_text).toContain("Accepted the agent's default: CI takes two minutes longer");
    expect(items[1]!.raw_text).toContain("Rejected the agent's default: we pin it in the lockfile instead");
  });

  it('Default:, Rollback: and indented lines belong to the entry above them', () => {
    const { items } = parseParkingLot(lot(
      '- Ship the flag on? · answered: yes, behind the setting',
      '- **Default:** kept off',
      '',
      '  - Rollback: turn it off again',
      '- Rename the flag? · answered: keep the name',
    ));
    expect(items.map((i) => i.title)).toEqual(['Ship the flag on?', 'Rename the flag?']);
    expect(items[0]!.raw_text).toContain('Default: kept off');
    expect(items[0]!.raw_text).toContain('Rollback: turn it off again');
  });

  it('a default that starts with a disposition word is not read as the disposition', () => {
    const { items, open } = parseParkingLot(lot('- Retry failed jobs? · fixed retry count of 3 · avoid retry storms · answered: use exponential backoff'));
    expect(items).toHaveLength(1);
    expect(items[0]!.raw_text).toContain('Answered: use exponential backoff');
    expect(items[0]!.raw_text).toContain("Agent's default: fixed retry count of 3");
    expect(open).toBe(0);
  });

  it('the same question in two repos is two decisions', () => {
    const a = parseParkingLot(lot('- Use Redis? · answered: yes'), { repo: 'acme/api' });
    const b = parseParkingLot(lot('- Use Redis? · answered: no'), { repo: 'acme/web' });
    expect(a.items[0]!.source_url).not.toBe(b.items[0]!.source_url);
    expect(parseParkingLot(lot('- Use Redis? · answered: maybe'), { repo: 'acme/api' }).items[0]!.source_url).toBe(a.items[0]!.source_url);
  });

  // From a real workspace (Orwa Mahmoud, AdaptTable, 18 Nov): 10 of 23 answered entries imported on 0.86.0.
  it('finds an answer on an indented line under the bullet', () => {
    const { items, open } = parseParkingLot(lot(
      '- Keep the retry queue on disk? · kept it on disk · survives a restart',
      '  · answered: yes, keep it on disk',
    ));
    expect(items.map((i) => i.title)).toEqual(['Keep the retry queue on disk?']);
    expect(items[0]!.raw_text).toContain('Answered: yes, keep it on disk');
    expect(open).toBe(0);
  });

  it('text the runtime adds after the answer does not hide it', () => {
    const { items, open } = parseParkingLot(lot(
      '- Ship the export? · kept it · users asked · answered: yes · outcome: shipped in 2.3',
      '- Rename the table? · answered: no · reconciled 2026-10-02',
    ));
    expect(items.map((i) => i.title)).toEqual(['Ship the export?', 'Rename the table?']);
    expect(items[0]!.raw_text).toContain('Outcome: shipped in 2.3');
    expect(open).toBe(0);
  });

  it('a date before the answer is the date, not the why', () => {
    const { items } = parseParkingLot(lot('- Drop the legacy flag? · kept it · 2026-09-30 · answered: drop it'));
    expect(items[0]!.raw_text).not.toContain('Why: 2026-09-30');
    expect(items[0]!.created_at).toBe('2026-09-30T00:00:00.000Z');
  });

  it('a runtime permission request is not a decision', () => {
    const { items } = parseParkingLot(lot(
      '- needs allowance: network access for the docs build · answered: allowed for the next shift',
      '- Keep the cache? · answered: yes',
    ));
    expect(items.map((i) => i.title)).toEqual(['Keep the cache?']);
  });

  it('a prose entry gets a short title, and its text keeps the whole entry', () => {
    const long = 'The importer reads every row of the sheet and the sheet has grown past ten thousand rows so the nightly run now takes forty minutes, and I paged it rather than skipping rows';
    const { items } = parseParkingLot(lot(`- ${long} · answered: page it`));
    expect(items[0]!.title.length).toBeLessThanOrEqual(100);
    expect(long.startsWith(items[0]!.title.replace(/\.\.\.$/, ''))).toBe(true);
    expect(items[0]!.raw_text).toContain(long);
  });

  it('never prints "Default:" twice', () => {
    const { items } = parseParkingLot(lot(
      '- Ship the flag on? · Default: kept off · answered: yes',
      '  - Default: Default: kept off',
    ));
    expect(items[0]!.raw_text).not.toMatch(/Default:\s*Default:/i);
    expect(items[0]!.raw_text).toContain("Agent's default: kept off");
  });

  // Second real run on AdaptTable (Orwa Mahmoud, 18 Nov): 22 of 22 imported, then these.
  it('a leading item number and "vs." do not end the title', () => {
    const { items } = parseParkingLot(lot(
      '- **14.** Keep the CSV export for field teams · kept it · offline sites · answered: yes',
      '- Postgres vs. SQLite for the local cache · SQLite · one file · answered: SQLite',
    ));
    expect(items.map((i) => i.title)).toEqual(['Keep the CSV export for field teams', 'Postgres vs. SQLite for the local cache']);
  });

  it('a wrapped entry keeps its whole question in the title', () => {
    const { items } = parseParkingLot(lot(
      '- Keep the retry queue on disk so a restart',
      '  does not lose jobs? · kept it on disk · survives a restart · answered: yes',
    ));
    expect(items[0]!.title).toBe('Keep the retry queue on disk so a restart does not lose jobs?');
    expect(items[0]!.raw_text).toContain('Answered: yes');
  });

  it('labelled segments go under their own label, never twice', () => {
    const { items } = parseParkingLot(lot('- Drop the v1 API? · Default: keep it · Why: two clients still call it · Rollback: re-enable the route · answered: keep it'));
    const text = items[0]!.raw_text;
    expect(text).not.toMatch(/Why:\s*Why:/);
    expect(text).toContain("Agent's default: keep it");
    expect(text).toContain('Why: two clients still call it');
    expect(text).toContain('Rollback: re-enable the route');
    expect(text).not.toMatch(/Why:[^\n]*Rollback/);
  });

  it('a "stalled, needs human" note is status, not a decision', () => {
    const { items } = parseParkingLot(lot(
      '- stalled - needs human: the deploy key expired · answered: rotated it',
      '- Keep the cache? · answered: yes',
    ));
    expect(items.map((i) => i.title)).toEqual(['Keep the cache?']);
  });

  it('the template above the rule, a Filed: pointer and a paragraph are not entries', () => {
    const { items } = parseParkingLot(lot(
      '- Keep the cache? · answered: yes',
      '',
      'A note the owner wrote as a paragraph · answered: later',
      '',
      'Filed: [2026-09-24](archive/2026-09-24/inbox/parking-lot.md)',
    ));
    expect(items.map((i) => i.title)).toEqual(['Keep the cache?']);
  });

  it('a file with no rule (an older archive) is read from the top', () => {
    const { items } = parseParkingLot('# Parking Lot\n\n- a decision · answered: yes\n');
    expect(items.map((i) => i.title)).toEqual(['a decision']);
  });

  it('the same question answered later keeps one identity, so a re-import updates it', () => {
    const before = parseParkingLot(lot('- Keep the cache? · kept it · cheaper · answered: yes'));
    const after = parseParkingLot(lot('- Keep the cache? · kept it · cheaper · answered: yes, for a week'));
    const other = parseParkingLot(lot('- Keep the queue? · answered: yes'));
    expect(after.items[0]!.source_url).toBe(before.items[0]!.source_url);
    expect(other.items[0]!.source_url).not.toBe(before.items[0]!.source_url);
    expect(before.items[0]!.source_url).toMatch(/^nightshift:\/\/parking-lot\/[0-9a-f]{16}$/);
  });

  it('a trailing date is the decision date; otherwise the date in the archive folder name', () => {
    const dated = parseParkingLot(lot('- a question · default · answered: yes · 2026-09-25'));
    expect(dated.items[0]!.raw_text).toContain('Answered: yes');
    expect(dated.items[0]!.raw_text).not.toContain('2026-09-25');
    expect(dated.items[0]!.created_at).toBe('2026-09-25T00:00:00.000Z');
    const filed = parseParkingLot(lot('- another question · answered: no'), { fileDate: '2026-09-24' });
    expect(filed.items[0]!.created_at).toBe('2026-09-24T00:00:00.000Z');
    expect(parseParkingLot(lot('- a third · answered: no')).items[0]!.created_at).toBeUndefined();
  });
});

describe('readNightshift', () => {
  let repo: string;
  afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });
  const write = (rel: string, text: string) => {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };

  it('finds live and archived parking lots in the folder layout, and keeps one decision per question', async () => {
    repo = mkdtempSync(join(tmpdir(), 'ns-read-'));
    write('.nightshift/inbox/parking-lot.md', lot('- Still open? · a default · a why', '- Keep the cache? · answered: yes, for a week'));
    write('.nightshift/archive/2026-09-24/inbox/parking-lot.md', lot('- Keep the cache? · answered: yes', '- Ship the flag on? · answered: yes'));
    const read = await readNightshift(repo);
    expect(read.items.map((i) => i.title).sort()).toEqual(['Keep the cache?', 'Ship the flag on?']);
    expect(read.items.find((i) => i.title === 'Keep the cache?')!.raw_text).toContain('yes, for a week'); // the live answer wins
    expect(read.items.find((i) => i.title === 'Ship the flag on?')!.created_at).toBe('2026-09-24T00:00:00.000Z');
    expect(read.open).toBe(1);
    expect(read.files).toBe(2);
  });

  it('a question parked again in the live file, still open, wins over an older archived answer', async () => {
    repo = mkdtempSync(join(tmpdir(), 'ns-read-'));
    write('.nightshift/archive/2026-09-24/inbox/parking-lot.md', lot('- Use Redis? · answered: yes', '- Keep the cache? · answered: yes'));
    write('.nightshift/inbox/parking-lot.md', lot('- Use Redis? · switched to Valkey · licence change'));
    const read = await readNightshift(repo);
    expect(read.items.map((i) => i.title)).toEqual(['Keep the cache?']);
    expect(read.open).toBe(1);
  });

  it('reads the older flat layout too', async () => {
    repo = mkdtempSync(join(tmpdir(), 'ns-read-'));
    write('.nightshift/parking-lot.md', '# Parking Lot\n\n- a decision · answered: yes\n');
    write('.nightshift/archive/2026-09-20/parking-lot.md', '# Parking Lot\n\n- an older one · answered: no\n');
    const read = await readNightshift(repo);
    expect(read.items.map((i) => i.title).sort()).toEqual(['a decision', 'an older one']);
  });

  it('says there is no nightshift workspace when .nightshift is missing', async () => {
    repo = mkdtempSync(join(tmpdir(), 'ns-read-'));
    await expect(readNightshift(repo)).rejects.toThrow(/no \.nightshift/);
  });
});
