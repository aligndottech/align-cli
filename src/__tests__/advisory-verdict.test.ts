/**
 * ALI-570's verdict store: the channel between the detached adjudicator and the next hook
 * invocation. Two properties carry all the weight, so they get the boundary treatment:
 *
 * - A deny keys on CONTENT identity, never file identity, so it can only hit a retry of the
 *   change that was judged - an adjusted approach hashes differently and proceeds.
 * - Everything expires, because a verdict about a tree that has moved on must not go on
 *   denying: VERDICT_TTL_MS for verdicts, the much shorter PENDING_TTL_MS for spawn markers
 *   so a crashed adjudicator debounces rather than wedges.
 *
 * Time is injected everywhere; no test sleeps.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  adjudicationExistsFor,
  blockableVerdictFor,
  contentHashOf,
  markAdjudicationPending,
  PENDING_TTL_MS,
  recordVerdict,
  type StoredVerdict,
  VERDICT_TTL_MS,
} from '../lib/advisory-verdict.js';

const T0 = 1_700_000_000_000;

function verdict(overrides: Partial<StoredVerdict> = {}): StoredVerdict {
  return {
    ts: T0,
    filePath: 'src/db.ts',
    contentHash: contentHashOf('switch to mysql'),
    conflicts: [
      {
        decision_id: 'd-1',
        title: 'Use Postgres for persistence',
        reason: 'Reverses the datastore decision',
        severity: 'critical',
      },
    ],
    ...overrides,
  };
}

/** Each test gets its own cwd key so stores cannot bleed between tests. */
let seq = 0;
function freshCwd(): string {
  seq += 1;
  return path.join(os.tmpdir(), `verdict-test-cwd-${process.pid}-${seq}`);
}

function storeFileFor(cwd: string): string {
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `align-advisory-verdict-${hash}.json`);
}

const created: string[] = [];
afterEach(() => {
  for (const f of created.splice(0)) if (fs.existsSync(f)) fs.unlinkSync(f);
});

function track(cwd: string): string {
  created.push(storeFileFor(cwd));
  return cwd;
}

describe('blockable verdict lookup (content identity)', () => {
  it('returns a fresh verdict for exactly the adjudicated content', () => {
    const cwd = track(freshCwd());
    recordVerdict(cwd, verdict(), T0);

    const hit = blockableVerdictFor(cwd, contentHashOf('switch to mysql'), T0 + 1_000);

    expect(hit?.conflicts[0]?.title).toBe('Use Postgres for persistence');
  });

  it('returns nothing for DIFFERENT content, even in the same file', () => {
    const cwd = track(freshCwd());
    recordVerdict(cwd, verdict(), T0);

    expect(blockableVerdictFor(cwd, contentHashOf('switch to mysql, but with a migration plan'), T0 + 1_000)).toBeNull();
  });

  it('expires: one millisecond past the TTL it cannot block', () => {
    const cwd = track(freshCwd());
    recordVerdict(cwd, verdict(), T0);

    expect(blockableVerdictFor(cwd, contentHashOf('switch to mysql'), T0 + VERDICT_TTL_MS)).not.toBeNull();
    expect(blockableVerdictFor(cwd, contentHashOf('switch to mysql'), T0 + VERDICT_TTL_MS + 1)).toBeNull();
  });

  it('a clock that went BACKWARDS does not resurrect anything', () => {
    const cwd = track(freshCwd());
    recordVerdict(cwd, verdict(), T0);

    expect(blockableVerdictFor(cwd, contentHashOf('switch to mysql'), T0 - 1)).toBeNull();
  });
});

describe('spawn dedup (pending markers)', () => {
  it('a fresh pending marker reports an adjudication in flight', () => {
    const cwd = track(freshCwd());
    markAdjudicationPending(cwd, 'h-1', T0);

    expect(adjudicationExistsFor(cwd, 'h-1', T0 + PENDING_TTL_MS)).toBe(true);
    expect(adjudicationExistsFor(cwd, 'h-1', T0 + PENDING_TTL_MS + 1)).toBe(false);
  });

  it('a pending marker for OTHER content does not suppress this one', () => {
    const cwd = track(freshCwd());
    markAdjudicationPending(cwd, 'h-1', T0);

    expect(adjudicationExistsFor(cwd, 'h-2', T0 + 1_000)).toBe(false);
  });

  it('a recorded verdict also suppresses re-spawning for its content', () => {
    const cwd = track(freshCwd());
    recordVerdict(cwd, verdict({ contentHash: 'h-1' }), T0);

    expect(adjudicationExistsFor(cwd, 'h-1', T0 + 1_000)).toBe(true);
  });

  it('recording the verdict clears its own pending marker', () => {
    const cwd = track(freshCwd());
    markAdjudicationPending(cwd, 'h-1', T0);
    recordVerdict(cwd, verdict({ contentHash: 'h-1' }), T0 + 1_000);

    // Past the pending TTL but inside the verdict TTL: only the verdict can answer, and
    // it does - proving the marker was replaced, not left to answer alongside it.
    expect(adjudicationExistsFor(cwd, 'h-1', T0 + PENDING_TTL_MS + 5_000)).toBe(true);
  });
});

describe('the store never throws at the hook', () => {
  it('treats a corrupt store file as empty rather than crashing', () => {
    const cwd = track(freshCwd());
    fs.writeFileSync(storeFileFor(cwd), '{ not json', 'utf8');

    expect(blockableVerdictFor(cwd, 'h', T0)).toBeNull();
    expect(() => recordVerdict(cwd, verdict(), T0)).not.toThrow();
    // ...and the write recovered the file: the verdict is now readable.
    expect(blockableVerdictFor(cwd, verdict().contentHash, T0 + 1)).not.toBeNull();
  });

  it('leaves no tmp file behind after a write (atomic rename)', () => {
    const cwd = track(freshCwd());
    recordVerdict(cwd, verdict(), T0);

    const dir = path.dirname(storeFileFor(cwd));
    const strays = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(storeFileFor(cwd))) && f.endsWith('.tmp'));
    expect(strays).toEqual([]);
  });
});
