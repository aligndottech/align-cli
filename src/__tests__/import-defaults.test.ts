import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_DISCUSSION_BUDGET,
  SYNC_CEILINGS,
  SYNC_TIME_BUDGET_MS,
  SYNC_WINDOW_DEFAULT_DAYS,
} from '../lib/import-defaults.js';
import { CAPTURE_SOURCES } from '../lib/capture-sources.js';

/**
 * ALI-829 R30: the per-connector fetch cap has ONE writer, read by `align setup` and by
 * every `align import <x>` default. Pinned as a parity gate over the source, the same way
 * import-env-parity.test.ts pins the env resolver: the defect was never one number, it was
 * eleven call sites each free to carry their own.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = path.join(HERE, '..', 'commands', 'import');
const SETUP = path.join(HERE, '..', 'commands', 'setup.ts');

const commandIds = readdirSync(IMPORT_DIR).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, '')).sort();

describe('SYNC_CEILINGS (was IMPORT_LIMITS; L3 made it the one table)', () => {
  it('found the commands at all (the positive control for the parity below)', () => {
    expect(commandIds.length).toBeGreaterThan(5);
    expect(commandIds).toContain('slack');
  });

  it('has one entry per import command, and no entry without one', () => {
    expect(Object.keys(SYNC_CEILINGS).sort()).toEqual(commandIds);
    expect(Object.keys(SYNC_CEILINGS).sort()).toEqual(Object.keys(CAPTURE_SOURCES).sort());
  });

  it('is what every import command defaults --limit to, by reference and never by literal', () => {
    for (const id of commandIds) {
      const src = readFileSync(path.join(IMPORT_DIR, `${id}.ts`), 'utf8');
      // The default is either the table reference or a quoted literal; capturing both
      // forms is what lets a literal FAIL the equality below rather than not match at all.
      const m = src.match(/\.option\('--limit <n>', '[^']*', (String\(SYNC_CEILINGS\.\w+\)|'[^']*')\)/);
      expect(m, `${id}.ts declares --limit`).not.toBeNull();
      expect(m![1], `${id}.ts --limit default`).toBe(`String(SYNC_CEILINGS.${id})`);
    }
  });

  it('is what every setup source fetches with: no numeric limit literal survives in buildSources', () => {
    const src = readFileSync(SETUP, 'utf8');
    const buildSources = src.slice(src.indexOf('function buildSources('), src.indexOf('// Token collection helper'));
    expect(buildSources.length).toBeGreaterThan(1000);           // the slice found the function
    expect(buildSources.match(/limit: \d+/g) ?? []).toEqual([]);   // no literal
    // Every source id that setup fetches for reads its own entry. docs is fetched outside
    // buildSources (the value phase), so it is pinned separately below. sessions (ALI-808)
    // is neither: it reads local agent-session transcripts, has no OAuth/token and no
    // per-tenant fetch, and refuses any environment but the local graph outright - there is
    // nothing for `align setup`'s cloud/local onboarding to wire up, so it is exempt from
    // this loop the same way docs is, rather than forcing a fetch-shaped entry that would
    // not fire.
    for (const id of commandIds.filter((c) => c !== 'docs' && c !== 'sessions')) {
      expect(buildSources, `setup reads SYNC_CEILINGS.${id} through fetchWindow`).toContain(`fetchWindow('${id}'`);
    }
    // Both docs sites (the local value phase and cloud setup), and no literal anywhere in
    // the file - `toContain` alone is satisfied while the other site regresses.
    expect(src.match(/fetchDocsItems\(\{ limit: SYNC_CEILINGS\.docs \}\)/g)).toHaveLength(2);
    expect(src.match(/limit: \d+/g) ?? []).toEqual([]);
    // Slack's look-back is the shared window now (`since`), not a second 90-day literal.
    expect(src).not.toMatch(/daysBack/);
  });

  it('carries the numbers the plan set (L3 table)', () => {
    expect(SYNC_CEILINGS).toEqual({
      github: 3_000, slack: 2_000, jira: 2_000, linear: 2_000, gitlab: 2_000, confluence: 2_000,
      notion: 1_000, teams: 1_000, zoom: 200, git: 5_000, docs: 500, sessions: 250,
    });
    expect(SYNC_WINDOW_DEFAULT_DAYS).toBe(180);
    expect(SYNC_TIME_BUDGET_MS).toBe(8 * 60_000);
    expect(GITHUB_DISCUSSION_BUDGET).toBe(600);
  });

  it('marks exactly the ceilings P0 could not measure as PROVISIONAL, and says why on the line', () => {
    const src = readFileSync(path.join(HERE, '..', 'lib', 'import-defaults.ts'), 'utf8');
    const table = src.slice(src.indexOf('export const SYNC_CEILINGS'), src.indexOf('} as const', src.indexOf('export const SYNC_CEILINGS')));
    const lines = table.split('\n').filter((l) => /^\s+\w+:\s+[\d_]+,/.test(l));
    expect(lines.length).toBe(Object.keys(SYNC_CEILINGS).length);    // the slice found every entry
    const provisional = lines.filter((l) => l.includes('PROVISIONAL')).map((l) => l.trim().split(':')[0]);
    expect(provisional.sort()).toEqual(['confluence', 'gitlab', 'jira', 'linear', 'notion', 'teams', 'zoom']);
    // The header states what PROVISIONAL means, so the word is never a bare tag.
    expect(src).toMatch(/PROVISIONAL = P0 could not measure it/);
  });
});
