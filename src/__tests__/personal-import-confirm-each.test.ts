/**
 * ALI-808: `runConfirmEachImport`, added beside (not instead of) `runPersonalImport` - a
 * per-item review loop rather than "preview N, confirm once, batch". An agent must not be
 * able to accept its own claims unattended, so this refuses a non-TTY caller exactly the
 * way `align ratify` does (ratify.ts) - a hook, a pipe, or an agent shell all arrive with
 * stdin that is not a TTY.
 *
 * Test List:
 * 1. an empty item list returns {imported:0, skipped:0, remaining:0} without prompting
 * 2. a non-TTY caller throws before prompting or calling onAccept - same fail direction as
 *    align ratify
 * 3. accepting an item calls onAccept once and counts it imported
 * 4. skipping an item does not call onAccept and counts it skipped
 * 5. cancelling (Ctrl-C) stops the loop; items already reviewed keep their tally, the rest
 *    count as remaining, not skipped
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const select = vi.hoisted(() => vi.fn());
const isCancelMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock('@clack/prompts', () => ({
  select,
  isCancel: isCancelMock,
  cancel: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
}));

import { runConfirmEachImport } from '../lib/personal-import.js';

const inTty = process.stdin.isTTY;
function setStdinTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  select.mockReset();
  isCancelMock.mockReset().mockReturnValue(false);
  setStdinTty(true);
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: inTty, configurable: true });
});

interface Item { render(): string }
function item(text: string): Item {
  return { render: () => text };
}

describe('runConfirmEachImport', () => {
  it('an empty list returns zero counts without prompting', async () => {
    const onAccept = vi.fn();
    const result = await runConfirmEachImport([], onAccept, { label: 'test items' });
    expect(result).toEqual({ imported: 0, skipped: 0, remaining: 0 });
    expect(select).not.toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('a non-TTY caller throws before prompting or accepting anything', async () => {
    setStdinTty(false);
    const onAccept = vi.fn();
    await expect(runConfirmEachImport([item('q1')], onAccept, { label: 'test items' })).rejects.toThrow(/terminal/i);
    expect(select).not.toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('accepting an item calls onAccept once and counts it imported', async () => {
    select.mockResolvedValueOnce('accept');
    const onAccept = vi.fn().mockResolvedValue({ id: 'd1' });
    const result = await runConfirmEachImport([item('q1')], onAccept, { label: 'test items' });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ imported: 1, skipped: 0, remaining: 0 });
  });

  it('skipping an item does not call onAccept and counts it skipped', async () => {
    select.mockResolvedValueOnce('skip');
    const onAccept = vi.fn();
    const result = await runConfirmEachImport([item('q1')], onAccept, { label: 'test items' });
    expect(onAccept).not.toHaveBeenCalled();
    expect(result).toEqual({ imported: 0, skipped: 1, remaining: 0 });
  });

  it('cancelling stops the loop - reviewed items keep their tally, the rest are remaining, not skipped', async () => {
    select.mockResolvedValueOnce('accept').mockResolvedValueOnce('__cancelled__');
    isCancelMock.mockImplementation((v) => v === '__cancelled__');
    const onAccept = vi.fn().mockResolvedValue({ id: 'd1' });
    const result = await runConfirmEachImport([item('q1'), item('q2'), item('q3')], onAccept, { label: 'test items' });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ imported: 1, skipped: 0, remaining: 2 });
  });
});
