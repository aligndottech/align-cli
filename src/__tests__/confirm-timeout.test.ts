import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askWithTimeout, CONFIRM_TIMEOUT_MS } from '../lib/confirm-timeout.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('askWithTimeout', () => {
  it('a prompt nobody answers is No after 60 s, and not before', async () => {
    expect(CONFIRM_TIMEOUT_MS).toBe(60_000);
    let settled: boolean | undefined;
    void askWithTimeout(() => new Promise<boolean>(() => {})).then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(false);
  });

  it('a Yes and a No given in time are passed through, a throwing prompt is No, and no timer is left behind (four cases)', async () => {
    expect(await askWithTimeout(async () => true)).toBe(true);
    expect(await askWithTimeout(async () => false)).toBe(false);
    expect(await askWithTimeout(async () => { throw new Error('closed'); })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
