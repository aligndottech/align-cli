import { describe, expect, it } from 'vitest';
import { DETECTOR_VERSIONS, resolveDetectorVersion } from '../detector-version.js';

describe('ALIGN_DETECTOR', () => {
  it('unset -> v1 (the Phase A confirmatory run licensed the flip; see docs/local-mode.md)', () => {
    expect(resolveDetectorVersion({})).toBe('v1');
    expect(resolveDetectorVersion({ ALIGN_DETECTOR: '' })).toBe('v1');
    expect(resolveDetectorVersion({ ALIGN_DETECTOR: '  ' })).toBe('v1');
  });

  it('explicit v0 and v1 are read as given', () => {
    expect(resolveDetectorVersion({ ALIGN_DETECTOR: 'v0' })).toBe('v0');
    expect(resolveDetectorVersion({ ALIGN_DETECTOR: 'v1' })).toBe('v1');
  });

  it('an unknown value is an error naming the allowed values, never a fallback', () => {
    expect(() => resolveDetectorVersion({ ALIGN_DETECTOR: 'v2' })).toThrow(/ALIGN_DETECTOR="v2".*v0, v1/);
    expect(() => resolveDetectorVersion({ ALIGN_DETECTOR: 'V1' })).toThrow(/v0, v1/);
    expect(DETECTOR_VERSIONS).toEqual(['v0', 'v1']);
  });
});
