import { describe, expect, it } from 'vitest';
import { maxWorkersFor } from '../../vitest.workers.js';

// On windows-latest the suite is bound by commit fsyncs to the local graph. Three workers
// contending for one disk made the same tests run 2.6x slower on one run (983 s of test time became
// 3399 s) until a worker's 60 s `onTaskUpdate` RPC to the main thread timed out, failing the job with
// every test green. Windows runs fewer workers; other platforms keep vitest's default.
describe('vitest worker cap', () => {
  it('caps workers at 2 on win32', () => {
    expect(maxWorkersFor('win32', 4)).toBe(2);
  });

  it('never raises the default on a small win32 runner', () => {
    expect(maxWorkersFor('win32', 2)).toBe(1);
    expect(maxWorkersFor('win32', 1)).toBe(1);
  });

  it.each(['linux', 'darwin'] as const)('leaves the default worker count on %s', (p) => {
    expect(maxWorkersFor(p, 4)).toBeUndefined();
  });
});
