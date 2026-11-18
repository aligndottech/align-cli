/**
 * Reading nightshift's plan record (github.com/orwa-mahmoud/nightshift): the plan room's notebook,
 * `.nightshift/staging/plan-record.md`, and its filed copies at `<archive folder>/staging/plan-record.md`.
 * Fixture shapes come from nightshift's own files:
 *  - the header and the entry shape: plugins/nightshift/skills/nightshift/references/templates/plan-record.md
 *  - a real entry with Where we are / Decided / Rejected / Open: docs/plan-room.md, "The plan record"
 *  - ` · captured: <file>` and ` · dropped: <why>` closing an entry: the same template, and tests/plan-record.bats
 *  - menu choices recorded as Decided lines: plugins/nightshift/skills/nightshift/references/plan/menu.md
 *  - archive.root and archive.layout: docs/knobs.md ("archive"); rules.json shape from
 *    skills/nightshift/references/nightshift-rules-template.json; the frozen copy in run/shift-policy.json
 *    (shape from tests/control.bats, createdAt is a UTC timestamp); run/.ended is `key=value` lines
 *    (ns_ended_record in lib/state.sh)
 *
 * Test List:
 * 1. a Decided line is one decision: the decision, its why, and the plan it came from
 * 2. a Rejected line is a rejected option, with its reason
 * 3. Where we are and Open lines are not imported; open questions are counted
 * 4. a dropped plan imports nothing; a captured plan and an open plan import their lines
 * 5. the planning menu's own choices (planning depth, pre-mortem) are not decisions
 * 6. the header, its fenced example, a Filed: pointer and "(empty)" are not entries
 * 7. the date is the entry's "open since" day, else the archive folder's
 * 8. the key survives an edit to the reason and a move to the archive, and differs by repo, plan and kind
 * 9. a wrapped line continues the line above it
 * 10. readNightshift finds the live and the filed record, and one decision stays one decision
 * 11. archive.root moved: its folders still count as archived and keep their date (rules.json, the frozen policy, the ending marker)
 * 12. archive.layout name or shift: the folder has no date, so it comes from the filed shift policy
 * 13. an unreadable or unsafe setting falls back to the default archive folder, and never files a live record
 * 14. the older flat plan record is not read
 * 15. a layout belongs to its own root: an unsafe root takes its layout with it, and two roots keep their own layouts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlanRecord, readNightshift } from '../../lib/fetchers/nightshift.js';

// templates/plan-record.md, header and rule included.
const HEADER = [
  '# Plan Record',
  '',
  "> The plan room's notebook. The planning conversation keeps it current as the discussion moves.",
  '',
  '**Each entry** is one `- ` bullet below the rule, one per plan, with its notes indented under it:',
  '',
  '```text',
  '  - **<topic>** · open since <local time>',
  '    - Decided: <decision> — <why>',
  '```',
  '',
  '---',
  '',
].join('\n');

const record = (...entries: string[]) => `${HEADER}${entries.join('\n')}\n`;

// docs/plan-room.md, "The plan record".
const EXPORT = [
  '- **Session export** · open since 2026-11-14 09:12 (UTC+04:00)',
  '  - Where we are: export format agreed; next, how a partial export reports itself',
  '  - Decided: stream rows instead of buffering — exports reach 2 GB',
  '  - Rejected: a background job queue — adds a service for one feature',
  '  - Open: does an export include archived rows?',
].join('\n');

describe('parsePlanRecord', () => {
  it('a Decided line is one decision: the decision, its why, and the plan it came from', () => {
    const { items } = parsePlanRecord(record(EXPORT));
    const d = items.find((i) => i.title === 'stream rows instead of buffering')!;
    expect(d).toBeDefined();
    expect(d.platform).toBe('nightshift');
    expect(d.raw_text).toContain('stream rows instead of buffering');
    expect(d.raw_text).toContain('Why: exports reach 2 GB');
    expect(d.raw_text).toContain('Plan: Session export');
    // second example: another plan, another decision, no why
    const two = parsePlanRecord(record('- **Config loader** · open since 2026-10-08 18:40 (UTC+04:00)', '  - Decided: one TOML file, no environment overrides — fewer places to look', '  - Decided: reload on SIGHUP'));
    expect(two.items.map((i) => i.title)).toEqual(['one TOML file, no environment overrides', 'reload on SIGHUP']);
    expect(two.items[1]!.raw_text).not.toContain('Why:');
  });

  it('a Rejected line is a rejected option, with its reason', () => {
    const { items } = parsePlanRecord(record(EXPORT));
    const r = items.find((i) => i.title === 'Rejected: a background job queue')!;
    expect(r).toBeDefined();
    expect(r.raw_text).toContain('Rejected: a background job queue');
    expect(r.raw_text).toContain('Why: adds a service for one feature');
    expect(r.raw_text).toContain('Plan: Session export');
    const two = parsePlanRecord(record('- **Retry budget** · open since 2026-10-09 09:12 (UTC+04:00)', '  - Rejected: unbounded retries — a dead dependency would hold the shift forever'));
    expect(two.items.map((i) => i.title)).toEqual(['Rejected: unbounded retries']);
  });

  it('Where we are and Open lines are not imported, and the open questions are counted', () => {
    const { items, open } = parsePlanRecord(record(EXPORT));
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.raw_text.includes('archived rows') || i.raw_text.includes('partial export'))).toBe(false);
    expect(open).toBe(1);
    const more = parsePlanRecord(record(EXPORT, '- **Dark mode** · open since 2026-10-07 11:05 (UTC+04:00)', '  - Open: which components first?', '  - Open: do we ship a toggle?'));
    expect(more.open).toBe(3);
  });

  it('a dropped plan imports nothing; a captured plan and an open plan import their lines', () => {
    const { items, open } = parsePlanRecord(record(
      '- **Dark mode** · open since 2026-10-07 11:05 (UTC+04:00) · dropped: not this quarter',
      '  - Decided: use CSS variables — one place to theme',
      '  - Open: which components first?',
      '- **Config loader** · open since 2026-10-08 18:40 (UTC+04:00) · captured: ## Plan: Config loader',
      '  - Decided: one TOML file, no environment overrides — fewer places to look',
      '- **Retry budget** · open since 2026-10-09 09:12 (UTC+04:00)',
      '  - Rejected: unbounded retries — a dead dependency would hold the shift forever',
    ));
    expect(items.map((i) => i.title)).toEqual(['one TOML file, no environment overrides', 'Rejected: unbounded retries']);
    expect(open).toBe(0); // a dropped plan's open question is not waiting on anyone
  });

  it('the planning menu\'s own choices are not decisions', () => {
    const { items } = parsePlanRecord(record(
      '- **Session export** · open since 2026-11-14 09:12 (UTC+04:00)',
      '  - Decided: planning depth — none',
      '  - Decided: pre-mortem — kept 2 lines: item 1 (expired token), non-goal (offline sync)',
      '  - Decided: ordering check — moved item 3 first; the owner declined a checkpoint item',
      '  - Decided: stream rows instead of buffering — exports reach 2 GB',
    ));
    expect(items.map((i) => i.title)).toEqual(['stream rows instead of buffering']);
  });

  it('the header, its fenced example, a Filed: pointer and "(empty)" are not entries', () => {
    expect(parsePlanRecord(`${HEADER}(empty)\n`).items).toEqual([]);
    const { items } = parsePlanRecord(record(
      'Filed: [2026-10-09](../archive/2026-10-09/staging/plan-record.md)',
      '',
      EXPORT,
    ));
    expect(items).toHaveLength(2);
  });

  it('the date is the entry\'s "open since" day, else the archive folder\'s', () => {
    const { items } = parsePlanRecord(record(EXPORT), { fileDate: '2026-11-20' });
    expect(items[0]!.created_at).toBe('2026-11-14T00:00:00.000Z');
    const undated = record('- **Retry budget**', '  - Decided: fixed budget — simpler');
    expect(parsePlanRecord(undated, { fileDate: '2026-11-20' }).items[0]!.created_at).toBe('2026-11-20T00:00:00.000Z');
    expect(parsePlanRecord(undated).items[0]!.created_at).toBeUndefined();
  });

  it('the key survives an edit to the reason, and differs by repo, plan and kind', () => {
    const a = parsePlanRecord(record(EXPORT), { repo: 'acme/api' }).items;
    const edited = parsePlanRecord(record(EXPORT.replace('exports reach 2 GB', 'exports reach 4 GB')), { repo: 'acme/api' }).items;
    expect(edited[0]!.source_url).toBe(a[0]!.source_url);
    expect(a[0]!.source_url).toMatch(/^nightshift:\/\/plan-record\/[0-9a-f]{16}$/);
    expect(parsePlanRecord(record(EXPORT), { repo: 'acme/web' }).items[0]!.source_url).not.toBe(a[0]!.source_url);
    const renamedPlan = parsePlanRecord(record(EXPORT.replace('Session export', 'Report export')), { repo: 'acme/api' }).items;
    expect(renamedPlan[0]!.source_url).not.toBe(a[0]!.source_url);
    expect(a[0]!.source_url).not.toBe(a[1]!.source_url);
    const same = parsePlanRecord(record('- **Session export**', '  - Decided: a background job queue', '  - Rejected: a background job queue — adds a service'), { repo: 'acme/api' }).items;
    expect(same[0]!.source_url).not.toBe(same[1]!.source_url);
  });

  it('a wrapped line continues the line above it, and a hyphen can part the decision from its why', () => {
    const { items } = parsePlanRecord(record(
      '- **Session export** · open since 2026-11-14 09:12 (UTC+04:00)',
      '  - Decided: stream rows instead of buffering the whole',
      '    result set — exports reach 2 GB',
      '  - Decided: report a partial export with an error trailer - the client can tell it was cut short',
    ));
    expect(items.map((i) => i.title)).toEqual(['stream rows instead of buffering the whole result set', 'report a partial export with an error trailer']);
    expect(items[1]!.raw_text).toContain('Why: the client can tell it was cut short');
  });
});

describe('readNightshift: the plan record', () => {
  let repo: string;
  afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });
  const write = (rel: string, text: string) => {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  const lot = (...e: string[]) => `# Parking Lot\n\n---\n\n${e.join('\n')}\n`;
  const fresh = () => { repo = mkdtempSync(join(tmpdir(), 'ns-plan-')); };
  // rules.json carries the archive block (nightshift-rules-template.json).
  const rules = (root: string, layout = 'date') => JSON.stringify({ archive: { automatic: false, root, layout, templatePath: '' } });
  // A filed shift policy (tests/control.bats shape).
  const policy = (createdAt: string) => JSON.stringify({ schemaVersion: 1, shiftId: '9f2c40ab77e51d63', createdAt, source: 'composition' });
  const titles = (r: { items: { title: string }[] }) => r.items.map((i) => i.title).sort();

  it('finds the live and the filed record, and one decision stays one decision', async () => {
    fresh();
    write('.nightshift/staging/plan-record.md', record(
      '- **Session export** · open since 2026-11-14 09:12 (UTC+04:00)',
      '  - Decided: stream rows instead of buffering — exports reach 4 GB',
      '  - Open: does an export include archived rows?',
    ));
    write('.nightshift/archive/2026-10-09/staging/plan-record.md', record(
      '- **Session export** · open since 2026-10-09 09:12 (UTC+04:00) · captured: x',
      '  - Decided: stream rows instead of buffering — exports reach 2 GB',
      '- **Config loader** · open since 2026-10-08 18:40 (UTC+04:00) · captured: y',
      '  - Decided: one TOML file — fewer places to look',
    ));
    const read = await readNightshift(repo);
    expect(titles(read)).toEqual(['one TOML file', 'stream rows instead of buffering']);
    expect(read.items.find((i) => i.title.startsWith('stream'))!.raw_text).toContain('4 GB'); // the live copy wins
    expect(read.items.find((i) => i.title.startsWith('stream'))!.created_at).toBe('2026-11-14T00:00:00.000Z');
    expect(read.items.find((i) => i.title.startsWith('one TOML'))!.created_at).toBe('2026-10-08T00:00:00.000Z');
    expect(read.planOpen).toBe(1);
    expect(read.planFiles).toBe(2);
  });

  it('an archive.root that moved still counts as archived and keeps its date', async () => {
    fresh();
    write('.nightshift/rules.json', rules('history/shifts'));
    write('.nightshift/history/shifts/2026-09-24/inbox/parking-lot.md', lot('- Keep the cache? · answered: yes', '- Still open? · a default'));
    write('.nightshift/history/shifts/2026-09-24/staging/plan-record.md', record('- **Cache**', '  - Decided: keep the cache — cheaper', '  - Open: how big?'));
    const read = await readNightshift(repo);
    expect(read.items.find((i) => i.title === 'Keep the cache?')!.created_at).toBe('2026-09-24T00:00:00.000Z');
    expect(read.items.find((i) => i.title === 'keep the cache')!.created_at).toBe('2026-09-24T00:00:00.000Z');
    expect(read.open).toBe(0); // an archived copy keeps its own history; only the live file is waiting
    expect(read.planOpen).toBe(0);
    // second example: a second root, named in the frozen shift policy and in the ending marker
    fresh();
    write('.nightshift/run/shift-policy.json', JSON.stringify({ schemaVersion: 1, createdAt: '2026-10-01T00:00:00Z', archive: { root: 'filed', layout: 'date' } }));
    write('.nightshift/run/.ended', 'shiftId=aaaa1111bbbb2222\narchiveRoot=old/shelf\narchiveLayout=date\nshiftName=\narchiveFolder=\nhost=claude\n');
    write('.nightshift/filed/2026-09-20/inbox/parking-lot.md', lot('- Use pnpm? · answered: yes'));
    write('.nightshift/old/shelf/2026-09-21/inbox/parking-lot.md', lot('- Use vitest? · answered: yes'));
    const two = await readNightshift(repo);
    expect(two.items.map((i) => [i.title, i.created_at]).sort()).toEqual([['Use pnpm?', '2026-09-20T00:00:00.000Z'], ['Use vitest?', '2026-09-21T00:00:00.000Z']]);
  });

  it('with the name or shift layout the folder has no date, so the filed shift policy gives it', async () => {
    fresh();
    write('.nightshift/rules.json', rules('archive', 'name'));
    write('.nightshift/archive/release-prep/inbox/parking-lot.md', lot('- Keep the cache? · answered: yes'));
    write('.nightshift/archive/release-prep/run/shift-policy.json', policy('2026-09-02T02:30:00Z'));
    // a name that looks like a date is a name, not the day
    write('.nightshift/archive/2026-01-01/staging/plan-record.md', record('- **Cache**', '  - Decided: keep the cache — cheaper'));
    write('.nightshift/archive/2026-01-01/run/shift-policy.json', policy('2026-09-03T02:30:00Z'));
    const read = await readNightshift(repo);
    expect(read.items.find((i) => i.title === 'Keep the cache?')!.created_at).toBe('2026-09-02T00:00:00.000Z');
    expect(read.items.find((i) => i.title === 'keep the cache')!.created_at).toBe('2026-09-03T00:00:00.000Z');
    // second example: the shift layout
    fresh();
    write('.nightshift/rules.json', rules('archive', 'shift'));
    write('.nightshift/archive/shift-9f2c40ab77e51d63/inbox/parking-lot.md', lot('- Use pnpm? · answered: yes'));
    write('.nightshift/archive/shift-9f2c40ab77e51d63/run/shift-policy.json', policy('2026-10-05T23:59:59Z'));
    expect((await readNightshift(repo)).items[0]!.created_at).toBe('2026-10-05T00:00:00.000Z');
  });

  it('an unreadable or unsafe setting falls back to the default folder, and never files a live record', async () => {
    fresh();
    write('.nightshift/rules.json', '{ not json');
    write('.nightshift/archive/2026-09-24/inbox/parking-lot.md', lot('- Keep the cache? · answered: yes'));
    write('.nightshift/inbox/parking-lot.md', lot('- Still open? · a default'));
    const read = await readNightshift(repo);
    expect(read.items[0]!.created_at).toBe('2026-09-24T00:00:00.000Z');
    expect(read.open).toBe(1);
    for (const root of ['inbox', 'staging/old', '../elsewhere', '/abs/path', 'run', '']) {
      fresh();
      write('.nightshift/rules.json', rules(root));
      write('.nightshift/inbox/parking-lot.md', lot('- Still open? · a default'));
      write('.nightshift/staging/plan-record.md', record('- **Cache**', '  - Open: how big?'));
      const r = await readNightshift(repo);
      expect([root, r.open, r.planOpen]).toEqual([root, 1, 1]);
    }
  });

  it('the older flat plan record is not read', async () => {
    fresh();
    write('.nightshift/inbox/parking-lot.md', lot('- Keep the cache? · answered: yes'));
    write('.nightshift/plan-record.md', record('- **Cache**', '  - Decided: keep the cache — cheaper'));
    write('.nightshift/archive/2026-09-20/plan-record.md', record('- **Cache**', '  - Decided: use redis — fast'));
    const read = await readNightshift(repo);
    expect(titles(read)).toEqual(['Keep the cache?']);
    expect(read.planFiles).toBe(0);
  });

  it('a layout belongs to its own root', async () => {
    // an unsafe root is ignored together with its layout, so the default folder keeps its date
    fresh();
    write('.nightshift/rules.json', rules('inbox', 'name'));
    write('.nightshift/archive/2026-09-24/inbox/parking-lot.md', lot('- Keep the cache? · answered: yes'));
    expect((await readNightshift(repo)).items[0]!.created_at).toBe('2026-09-24T00:00:00.000Z');
    // two roots, two layouts: the date-named default folder is dated by its name, the name-layout folder by its policy
    fresh();
    write('.nightshift/rules.json', rules('history', 'name'));
    write('.nightshift/run/.ended', 'shiftId=aaaa1111bbbb2222\narchiveRoot=archive\narchiveLayout=date\nshiftName=\narchiveFolder=\nhost=claude\n');
    write('.nightshift/archive/2026-09-24/inbox/parking-lot.md', lot('- Keep the cache? · answered: yes'));
    write('.nightshift/history/release-prep/inbox/parking-lot.md', lot('- Use pnpm? · answered: yes'));
    write('.nightshift/history/release-prep/run/shift-policy.json', policy('2026-09-02T02:30:00Z'));
    const read = await readNightshift(repo);
    expect(read.items.map((i) => [i.title, i.created_at]).sort()).toEqual([['Keep the cache?', '2026-09-24T00:00:00.000Z'], ['Use pnpm?', '2026-09-02T00:00:00.000Z']]);
  });
});
