import { describe, expect, it } from 'vitest';
import { createConfigStore } from '../../lib/config.js';
import { resolveDetectorVersion } from '../detector-version.js';

describe('detector precedence: ALIGN_DETECTOR, then the saved setting, then the default', () => {
  it('the env var wins over a saved setting', () => {
    expect(resolveDetectorVersion({ ALIGN_DETECTOR: 'v0' }, 'v1')).toBe('v0');
  });

  it('a saved setting is used when the env var is unset', () => {
    expect(resolveDetectorVersion({}, 'v1')).toBe('v1');
  });

  it('neither set means v0, the default', () => {
    expect(resolveDetectorVersion({}, undefined)).toBe('v0');
  });

  it('an invalid saved setting is an error that names where it came from', () => {
    expect(() => resolveDetectorVersion({}, 'v2')).toThrow(/detector.*config/i);
  });
});

describe('the saved detector setting round-trips through the config store', () => {
  it('getDetector returns what setDetector saved, and undefined when nothing is saved', () => {
    const store = createConfigStore();
    expect(store.getDetector()).toBeUndefined();
    store.setDetector('v1');
    expect(store.getDetector()).toBe('v1');
    store.setDetector('v0');
    expect(store.getDetector()).toBe('v0');
  });
});
