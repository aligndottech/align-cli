import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/config.js', () => ({ createConfigStore: vi.fn() }));

import { resolveEnv, resolveImportEnv } from '../lib/resolve-env.js';
import { createConfigStore } from '../lib/config.js';

type EnvShape = { mode: string; authToken: string | null };

function mockConfig(opts: { defaultEnv?: string; local?: Partial<EnvShape>; cloud?: Partial<EnvShape> } = {}) {
  const { defaultEnv = 'prod', local = {}, cloud = {} } = opts;
  (createConfigStore as ReturnType<typeof vi.fn>).mockReturnValue({
    getDefaultEnv: () => defaultEnv,
    getEnvironment: (e: string) =>
      e === 'local'
        ? { mode: 'demo', authToken: null, ...local }
        : { mode: 'auth', authToken: null, ...cloud },
  });
}

describe('resolveEnv preferLocalEmbedded (BUG-2: a --local user running bare `align ask`)', () => {
  const orig = process.env['ALIGN_ENV'];
  afterEach(() => {
    vi.clearAllMocks();
    if (orig === undefined) delete process.env['ALIGN_ENV'];
    else process.env['ALIGN_ENV'] = orig;
  });

  it('prefers local when local-embedded is configured and the cloud default has no token', () => {
    delete process.env['ALIGN_ENV'];
    mockConfig({ defaultEnv: 'prod', local: { mode: 'local-embedded' }, cloud: { authToken: null } });
    expect(resolveEnv(undefined, { preferLocalEmbedded: true })).toBe('local');
  });

  it('stays on the authenticated cloud default (no surprise redirect for a logged-in user)', () => {
    delete process.env['ALIGN_ENV'];
    mockConfig({ defaultEnv: 'prod', local: { mode: 'local-embedded' }, cloud: { authToken: 'tok' } });
    expect(resolveEnv(undefined, { preferLocalEmbedded: true })).toBe('prod');
  });

  it('an explicit --env flag always wins over the local preference', () => {
    mockConfig({ defaultEnv: 'prod', local: { mode: 'local-embedded' } });
    expect(resolveEnv('preview', { preferLocalEmbedded: true })).toBe('preview');
  });

  it('does not redirect when local mode is not configured', () => {
    delete process.env['ALIGN_ENV'];
    mockConfig({ defaultEnv: 'prod', local: { mode: 'demo' }, cloud: { authToken: null } });
    expect(resolveEnv(undefined, { preferLocalEmbedded: true })).toBe('prod');
  });

  it('does not redirect when preferLocalEmbedded is not requested', () => {
    delete process.env['ALIGN_ENV'];
    mockConfig({ defaultEnv: 'prod', local: { mode: 'local-embedded' }, cloud: { authToken: null } });
    expect(resolveEnv()).toBe('prod');
  });
});
describe('resolveImportEnv (ALI-675: imports are local-servable, so they get the same redirect)', () => {
  const orig = process.env['ALIGN_ENV'];
  afterEach(() => {
    vi.clearAllMocks();
    if (orig === undefined) delete process.env['ALIGN_ENV'];
    else process.env['ALIGN_ENV'] = orig;
  });

  it('redirects a no-account user to the local graph instead of a 401 against cloud', () => {
    delete process.env['ALIGN_ENV'];
    mockConfig({ defaultEnv: 'prod', local: { mode: 'local-embedded' }, cloud: { authToken: null } });
    expect(resolveImportEnv(undefined)).toBe('local');
  });

  it('never hijacks a logged-in user: a cloud token keeps the cloud default', () => {
    delete process.env['ALIGN_ENV'];
    // preview, not prod: a DIFFERENT value from the redirect target on both sides,
    // so "returned the default" and "returned local" cannot be confused (tdd.md,
    // the equal-values fixture trap).
    mockConfig({ defaultEnv: 'preview', local: { mode: 'local-embedded' }, cloud: { authToken: 'tok' } });
    expect(resolveImportEnv(undefined)).toBe('preview');
  });

  it('an explicit --env flag always wins', () => {
    mockConfig({ defaultEnv: 'prod', local: { mode: 'local-embedded' }, cloud: { authToken: null } });
    expect(resolveImportEnv('preview')).toBe('preview');
  });
});
