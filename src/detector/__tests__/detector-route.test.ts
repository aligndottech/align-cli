import { describe, expect, it } from 'vitest';
import { resolveDetectorVersion } from '../detector-version.js';
import { classifierRoute } from '../classifier-route.js';

describe('the default detector follows the route the classifier takes', () => {
  it('a hosted route defaults to v1, the same detector the paid product runs', () => {
    expect(resolveDetectorVersion({}, undefined, 'hosted')).toBe('v1');
  });

  it('a local route defaults to v0, because v1 loses recall on small local models', () => {
    expect(resolveDetectorVersion({}, undefined, 'local')).toBe('v0');
  });

  it('ALIGN_DETECTOR still wins over the route default', () => {
    expect(resolveDetectorVersion({ ALIGN_DETECTOR: 'v0' }, undefined, 'hosted')).toBe('v0');
  });

  it('a saved choice still wins over the route default', () => {
    expect(resolveDetectorVersion({}, 'v0', 'hosted')).toBe('v0');
  });

  it('no route given keeps v0, so the startup check stays env-only', () => {
    expect(resolveDetectorVersion({})).toBe('v0');
  });
});

describe('classifierRoute: hosted when any hosted key is set, local otherwise', () => {
  const noKeys = { getProviderKey: () => null };
  it('an environment key makes the route hosted', () => {
    expect(classifierRoute({ ANTHROPIC_API_KEY: 'sk-test' }, noKeys)).toBe('hosted');
  });

  it('a saved key makes the route hosted', () => {
    expect(classifierRoute({}, { getProviderKey: () => 'saved' })).toBe('hosted');
  });

  it('no key anywhere is the local route', () => {
    expect(classifierRoute({}, noKeys)).toBe('local');
  });

  it('a model name alone is not a key, so the route stays local', () => {
    expect(classifierRoute({ ANTHROPIC_MODEL: 'claude-haiku-4-5' }, noKeys)).toBe('local');
  });

  it('an empty key does not count', () => {
    expect(classifierRoute({ ANTHROPIC_API_KEY: '   ' }, noKeys)).toBe('local');
  });
});
