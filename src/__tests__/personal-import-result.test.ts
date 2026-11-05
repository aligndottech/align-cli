import { describe, expect, it, vi } from 'vitest';

/**
 * L3 review 4: the report says what was STORED. runPersonalImport fills an out-parameter with the
 * number of decisions the gateway returned and the number of batches that failed, so a caller can
 * print "imported 20 of 40 (a batch failed)" instead of the fetched count.
 */
vi.mock('@clack/prompts', () => ({ log: { info: vi.fn(), warn: vi.fn() }, confirm: vi.fn(), isCancel: () => false, cancel: vi.fn() }));

const { runPersonalImport } = await import('../lib/personal-import.js');

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ source_url: `https://github.com/o/r/pull/${i + 1}`, platform: 'github', raw_text: `t${i}` }));
const snaps = (n: number) => ({ snapshots: Array.from({ length: n }, (_, i) => ({ id: String(i), title: 't', summary: 's' })) });
const run = (n: number, ingestBatch: (b: unknown[]) => Promise<unknown>) => {
  const result: { stored?: number; failedBatches?: number } = {};
  const client = { ingestBatch } as never;
  return runPersonalImport(items(n), client, { label: 'GitHub', approve: true, appUrl: 'x', quiet: true, silent: true, result }).then((total) => ({ total, result }));
};

describe('runPersonalImport fills the result it was given', () => {
  it('every batch stored: stored is the count the gateway returned, no failures', async () => {
    const { result } = await run(40, async (b) => snaps(b.length));
    expect(result).toEqual({ stored: 40, failedBatches: 0 });
  });

  it('one of two batches rejects: stored counts only the batch that landed, and one failure is recorded', async () => {
    let call = 0;
    const { total, result } = await run(40, async (b) => {
      if (++call === 2) throw new Error('boom');
      return snaps(b.length);
    });
    expect(result).toEqual({ stored: 20, failedBatches: 1 });
    expect(total).toBe(20);
  });

  it('both batches reject: nothing stored, two failures', async () => {
    const { result } = await run(40, async () => { throw new Error('down'); });
    expect(result).toEqual({ stored: 0, failedBatches: 2 });
  });

  it('stored is what came BACK, not what was sent (the gateway may return fewer)', async () => {
    const { result } = await run(20, async () => snaps(15));
    expect(result.stored).toBe(15);
  });

  // when every batch fails nothing was imported, so the process must not exit 0.
  // Seen live: the on-device model could not download, 38 of 38 batches failed, exit 0, empty graph.
  it('every batch fails: the process exit code becomes 1', async () => {
    process.exitCode = undefined;
    try {
      await run(40, async () => { throw new Error('Could not set up the on-device embedding model'); });
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = undefined; }
  });

  it('some batches land: the exit code is left alone (a partial import is still an import)', async () => {
    process.exitCode = undefined;
    let call = 0;
    try {
      await run(40, async (b) => { if (++call === 2) throw new Error('boom'); return snaps(b.length); });
      expect(process.exitCode).toBeUndefined();
    } finally { process.exitCode = undefined; }
  });

  it('every batch fails but the caller opted out (setup, many sources): exit code left alone', async () => {
    process.exitCode = undefined;
    try {
      const result: { stored?: number; failedBatches?: number } = {};
      await runPersonalImport(items(40), { ingestBatch: async () => { throw new Error('down'); } } as never, { label: 'x', approve: true, appUrl: 'x', quiet: true, silent: true, result, exitOnTotalFailure: false });
      expect(result.failedBatches).toBe(2); // positive control: the failure really happened
      expect(process.exitCode).toBeUndefined();
    } finally { process.exitCode = undefined; }
  });

  it('no items: stored 0, no failures, and the caller\'s object is still filled', async () => {
    const result: { stored?: number; failedBatches?: number } = {};
    await runPersonalImport([], {} as never, { label: 'x', approve: true, appUrl: 'x', silent: true, result });
    expect(result).toEqual({ stored: 0, failedBatches: 0 });
  });
});
