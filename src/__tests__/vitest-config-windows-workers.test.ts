import { describe, expect, it } from 'vitest';
import { maxWorkersFor } from '../../vitest.workers.js';

// ALI-1771: on windows-latest the suite is bound by commit fsyncs to the local graph. Three workers
// contending for one disk made the same tests run 2.6x slower on one run (983 s of test time became
// 3399 s) until a worker's 60 s `onTaskUpdate` RPC to the main thread timed out, failing the job with
// every test green. Windows runs fewer workers; other platforms keep vitest's default.
describe('vitest worker cap', () => {
  it('caps workers at 2 on win32', () => {
    expect(maxWorkersFor('win32')).toBe(2);
  });

  it.each(['linux', 'darwin'] as const)('leaves the default worker count on %s', (p) => {
    expect(maxWorkersFor(p)).toBeUndefined();
  });
});
