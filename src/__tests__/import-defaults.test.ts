import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, SLACK_DAYS_BACK } from '../lib/import-defaults.js';

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

describe('IMPORT_LIMITS', () => {
  it('found the commands at all (the positive control for the parity below)', () => {
    expect(commandIds.length).toBeGreaterThan(5);
    expect(commandIds).toContain('slack');
  });

  it('has one entry per import command, and no entry without one', () => {
    expect(Object.keys(IMPORT_LIMITS).sort()).toEqual(commandIds);
  });

  it('is what every import command defaults --limit to, by reference and never by literal', () => {
    for (const id of commandIds) {
      const src = readFileSync(path.join(IMPORT_DIR, `${id}.ts`), 'utf8');
      // The default is either the table reference or a quoted literal; capturing both
      // forms is what lets a literal FAIL the equality below rather than not match at all.
      const m = src.match(/\.option\('--limit <n>', '[^']*', (String\(IMPORT_LIMITS\.\w+\)|'[^']*')\)/);
      expect(m, `${id}.ts declares --limit`).not.toBeNull();
      expect(m![1], `${id}.ts --limit default`).toBe(`String(IMPORT_LIMITS.${id})`);
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
      expect(buildSources, `setup reads IMPORT_LIMITS.${id}`).toContain(`IMPORT_LIMITS.${id}`);
    }
    // Both docs sites (the local value phase and cloud setup), and no literal anywhere in
    // the file - `toContain` alone is satisfied while the other site regresses.
    expect(src.match(/fetchDocsItems\(\{ limit: IMPORT_LIMITS\.docs \}\)/g)).toHaveLength(2);
    expect(src.match(/limit: \d+/g) ?? []).toEqual([]);
    expect(src).toContain('daysBack: SLACK_DAYS_BACK');
  });

  it('carries the numbers the plan set: 500 for the two zero-credential sources, 250 for the rest, 50 for zoom', () => {
    expect(IMPORT_LIMITS.git).toBe(500);
    expect(IMPORT_LIMITS.docs).toBe(500);
    expect(IMPORT_LIMITS.zoom).toBe(50);
    for (const id of commandIds.filter((c) => !['git', 'docs', 'zoom'].includes(c))) {
      expect(IMPORT_LIMITS[id as keyof typeof IMPORT_LIMITS], id).toBe(250);
    }
    expect(SLACK_DAYS_BACK).toBe(90);
  });
});
