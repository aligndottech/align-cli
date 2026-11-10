import { describe, expect, it } from 'vitest';
import { resolveScope, viewScopes } from '../lib/scope.js';
import { makeDeps, memStore } from './helpers/scope-deps.js';

/**
 * A Linear scope names SEVERAL projects of its team. Resolve, view and sync all read the one stored list.
 *
 * Test List:
 * - Two projects stored: the scope key, the options handed to the fetcher (sync and background use resolveScope), the disclosure and
 *   the status view all name both.
 * - An older stored single-project narrowing reads as one project, with the same key as before.
 * - A single project and a list of two never share a key (so a watermark is never reused across them).
 */
const two = { kind: 'team', values: ['t-1'], labels: ['ENG'], narrow: { by: 'projects', ids: ['p-1', 'p-2'], names: ['Auth', 'Billing'] } } as const;
const one = { kind: 'team', values: ['t-1'], labels: ['ENG'], narrow: { by: 'projects', ids: ['p-2'], names: ['Billing'] } } as const;
const deps = (scope: typeof two | typeof one) => makeDeps(undefined, { store: memStore({ connected: ['linear'], scopes: { linear: scope } }), coreNarrows: () => true, isTty: () => true });

describe('a Linear scope with several projects', () => {
  it('resolves to every project, in the key, the fetch options, the disclosure and the view', async () => {
    const d = deps(two);
    const r = await resolveScope('linear', d, { foreground: true });
    expect(r.scopeKey).toBe('linear:ENG#projects=p-1,p-2');
    expect(r.extras).toEqual({ teams: ['t-1'], projects: ['p-1', 'p-2'] });
    expect(r.disclosure).toContain('Linear projects Auth, Billing of Linear team ENG');
    const bg = await resolveScope('linear', d, { foreground: false });
    expect(bg.extras).toEqual({ teams: ['t-1'], projects: ['p-1', 'p-2'] });
    const view = (await viewScopes(d)).find((v) => v.source === 'linear')!;
    expect(view).toMatchObject({ scope_key: 'linear:ENG#projects=p-1,p-2', label: 'issues in Linear projects Auth, Billing of Linear team ENG' });
  });

  it('an older single-project narrowing still reads as that one project', async () => {
    const r = await resolveScope('linear', deps(one), { foreground: true });
    expect(r.scopeKey).toBe('linear:ENG#projects=p-2');
    expect(r.extras).toEqual({ teams: ['t-1'], projects: ['p-2'] });
    expect(r.label).toBe('issues in Linear project Billing of Linear team ENG');
  });
});
