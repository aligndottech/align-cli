import { describe, expect, it } from 'vitest';
import { alignDistribution } from '../lib/distribution.js';

describe('alignDistribution', () => {
  // Under vitest nothing defines __ALIGN_DIST__, which is the npm/source case. The
  // 'binary' branch is proven by scripts/smoke-binary.sh against a real compiled
  // artifact - the only place the define actually exists, so the only place that
  // claim can honestly be tested.
  it('reports npm when the build-time define is absent', () => {
    expect(alignDistribution()).toBe('npm');
  });

  it('does not throw on an undeclared identifier', () => {
    expect(() => alignDistribution()).not.toThrow();
  });
});
