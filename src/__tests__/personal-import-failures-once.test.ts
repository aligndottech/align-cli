import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * When every batch fails for one reason, the reason is said once, with a count, not
 * once per batch. Seen on a clean 0.70.0 install: `align connect git` before `align` printed
 * "Batch N: Align is not set up on this machine" 38 times, and the instruction scrolled away.
 */
const warn = vi.fn();
const info = vi.fn();
vi.mock('@clack/prompts', () => ({ log: { info, warn }, confirm: vi.fn(), isCancel: () => false, cancel: vi.fn() }));

const { runPersonalImport } = await import('../lib/personal-import.js');

const BATCH = 20;
const items = (batches: number) =>
  Array.from({ length: batches * BATCH }, (_, i) => ({ source_url: `https://github.com/o/r/commit/${i}`, platform: 'git', raw_text: `t${i}` }));
const snaps = (n: number) => ({ snapshots: Array.from({ length: n }, (_, i) => ({ id: String(i), title: 't', summary: 's' })) });

async function run(batches: number, ingestBatch: () => Promise<unknown>, extra: { local?: boolean; quiet?: boolean } = {}) {
  const result: { stored?: number; failedBatches?: number } = {};
  await runPersonalImport(items(batches), { ingestBatch } as never, {
    label: 'Git', approve: true, appUrl: 'x', quiet: true, result, exitOnTotalFailure: false, ...extra,
  });
  return { result, lines: warn.mock.calls.map((c) => String(c[0])) };
}

const NOT_SET_UP = 'Align is not set up on this machine. Run `align` to set it up.';

describe('runPersonalImport says each failure reason once', () => {
  beforeEach(() => { warn.mockClear(); vi.spyOn(console, 'log').mockImplementation(() => {}); });

  it('38 batches failing for one reason print one line with the count', async () => {
    const { result, lines } = await run(38, async () => { throw new Error(NOT_SET_UP); });
    expect(result.failedBatches).toBe(38); // positive control: all 38 really failed
    expect(lines).toEqual([`38 batches failed: ${NOT_SET_UP}`]);
  });

  it('two different reasons print one line each, with their own counts', async () => {
    let call = 0;
    const { lines } = await run(3, async () => { throw new Error(++call === 1 ? 'timeout' : 'down'); });
    expect(lines).toHaveLength(2);
    expect(lines).toContain('Batch 1: timeout');
    expect(lines).toContain('2 batches failed: down');
  });

  it('two different non-Error rejections are two lines, not one merged "undefined"', async () => {
    let call = 0;
    const { lines } = await run(2, async () => { throw ++call === 1 ? 'string one' : 'string two'; });
    expect(lines).toHaveLength(2);
    expect(lines).toContain('Batch 1: string one');
    expect(lines).toContain('Batch 2: string two');
  });

  it('a single failed batch out of several still names the batch', async () => {
    let call = 0;
    const { result, lines } = await run(2, async () => {
      if (++call === 2) throw new Error('boom');
      return snaps(BATCH);
    });
    expect(result).toEqual({ stored: BATCH, failedBatches: 1 });
    expect(lines).toEqual(['Batch 2: boom']);
  });
});

describe('any failed batch prints one align doctor hint', () => {
  beforeEach(() => { warn.mockClear(); info.mockClear(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  const hints = (_lines: string[]) => info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('align doctor'));

  it('quiet, local: one hint naming the embedding download, even when other batches stored', async () => {
    let call = 0;
    const { lines } = await run(3, async () => { if (++call === 1) throw new Error('boom'); return snaps(BATCH); }, { local: true });
    expect(hints(lines)).toHaveLength(1);
    expect(hints(lines)[0]).toContain('huggingface.co');
  });

  it('quiet, cloud: one hint that does not blame the embedding download', async () => {
    const { lines } = await run(4, async () => { throw new Error('boom'); });
    expect(hints(lines)).toHaveLength(1);
    expect(hints(lines)[0]).not.toContain('huggingface');
  });

  it('non-quiet prints the hint too, once, however many reasons failed', async () => {
    let call = 0;
    const { lines } = await run(3, async () => { throw new Error(++call === 1 ? 'a' : 'b'); }, { quiet: false, local: true });
    expect(hints(lines)).toHaveLength(1);
  });

  it('no failures, no hint', async () => {
    const { lines } = await run(2, async () => snaps(BATCH));
    expect(hints(lines)).toHaveLength(0);
  });
});
