import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalDb } from '../lib/local-db.js';
import { citedProjectKeys } from '../lib/scope-defaults.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * L4 Test List (what to preselect in a Jira or Linear picker):
 * - Keys cited by local decisions (`ALI-12`, `OPS-3`) give the project prefixes `ALI` and `OPS`, most-cited first.
 * - Only tracker-shaped refs count (jira and the ambiguous `tracker` bucket); a Confluence or Slack ref is not a project key.
 * - A graph with no refs, no graph file, or an older file with no refs table gives an empty list, never an error.
 * - A prefix cited once is as good as one cited ten times: it is a suggestion, and the person sees it before it applies.
 * - At most ten, so a noisy history does not preselect the world.
 */
let dir: string;
let dbPath: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l4-defaults-')); dbPath = path.join(dir, 'graph.db'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function seed(refs: Array<{ decision: string; ref: string; platform: string }>): void {
  const db = createLocalDb(dbPath);
  try {
    for (const name of new Set(refs.map((r) => r.decision))) {
      // replaceRefs needs the decision to exist (foreign key), so insert a real row and use the id it returns.
      const id = db.insertDecision({ title: `Decision ${name}`, summary: `about ${name}`, sourceUrl: `https://example.test/${name}`, platform: 'cli' });
      db.replaceRefs(id, refs.filter((r) => r.decision === name).map((r) => ({ ref: r.ref, platform: r.platform })));
    }
  } finally { db.close(); }
}

describe('citedProjectKeys', () => {
  it('gives the prefixes of cited keys, most-cited first, then by name (two examples)', () => {
    seed([
      { decision: 'a', ref: 'OPS-3', platform: 'tracker' },
      { decision: 'a', ref: 'ALI-12', platform: 'jira' },
      { decision: 'b', ref: 'ALI-14', platform: 'tracker' },
      { decision: 'c', ref: 'ALI-15', platform: 'tracker' },
      { decision: 'c', ref: 'BETA-1', platform: 'tracker' },
    ]);
    expect(citedProjectKeys(dbPath)).toEqual(['ALI', 'BETA', 'OPS']);
  });

  it('counts decisions, not repeats: one decision citing a key five times is one citation', () => {
    seed([
      { decision: 'a', ref: 'AAA-1', platform: 'tracker' }, { decision: 'a', ref: 'AAA-2', platform: 'tracker' }, { decision: 'a', ref: 'AAA-3', platform: 'tracker' },
      { decision: 'b', ref: 'BBB-1', platform: 'tracker' },
      { decision: 'c', ref: 'BBB-2', platform: 'tracker' },
    ]);
    expect(citedProjectKeys(dbPath)).toEqual(['BBB', 'AAA']);
  });

  it('ignores refs that are not tracker keys (confluence, slack, github, code)', () => {
    seed([
      { decision: 'a', ref: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/1', platform: 'confluence' },
      { decision: 'a', ref: 'C0123', platform: 'slack' },
      { decision: 'b', ref: '#45', platform: 'code' },
      { decision: 'b', ref: 'OPS-9', platform: 'tracker' },
    ]);
    expect(citedProjectKeys(dbPath)).toEqual(['OPS']);
  });

  it('is empty with no refs, with no graph file, and with an older file that has no refs table', () => {
    seed([]);
    expect(citedProjectKeys(dbPath)).toEqual([]);
    expect(citedProjectKeys(path.join(dir, 'missing.db'))).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'missing.db'))).toBe(false);
    const old = path.join(dir, 'old.db');
    const raw = new DatabaseSync(old);
    raw.exec('CREATE TABLE decisions (id TEXT)');
    raw.close();
    expect(citedProjectKeys(old)).toEqual([]);
  });

  it('returns at most ten', () => {
    seed(Array.from({ length: 14 }, (_, i) => ({ decision: `d${i}`, ref: `PR${String.fromCharCode(65 + i)}-1`, platform: 'tracker' })));
    expect(citedProjectKeys(dbPath)).toHaveLength(10);
  });
});
