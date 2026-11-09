import { describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../lib/config.js';
import { describeScopeKey, disclosureText, fetchOptsFor, labelOfScopeKey, type Narrowing, scopeKeyOf } from '../lib/scope-values.js';

// The file the config store writes, readable here so a test can see exactly what is on disk.
const disk = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('conf', () => ({
  default: class {
    constructor(opts: { defaults?: Record<string, unknown> }) { disk.store = JSON.parse(JSON.stringify(opts.defaults ?? {})); }
    get(k: string) { return disk.store[k]; }
    set(k: string, v: unknown) { disk.store[k] = v; }
    has(k: string) { return k in disk.store; }
    delete(k: string) { delete disk.store[k]; }
    clear() { disk.store = {}; }
  },
}));
const rawScope = (source: string): string | undefined => (disk.store['connectorTokens'] as Record<string, string> | undefined)?.[`local:${source}:scope`];

/**
 * A team that shares one Jira project (one board inside it) or one Linear team (one project inside it)
 * reads only its own part. The narrowing rides on a team scope.
 *
 * Test List:
 * - Each narrowing gets its own scope key, so two boards (or two Linear projects) never share a watermark; no narrowing keeps today's key.
 * - The key's place still reads as the project or team (the narrowing is cut off before the labels are read).
 * - The fetch gets the narrowing: Jira `jql` beside `projects`, Linear `projects` beside `teams`. None: today's options.
 * - The disclosure names the part, says the read stays inside the project, and never prints a JQL.
 * - Stored on disk as kind "narrowed", so an older CLI (which reads an unknown kind as yours) can never widen it to the whole project;
 *   read back as a team scope carrying the narrowing.
 */

const BOARD: Narrowing = { by: 'board', id: '42', name: 'Payments', jql: 'project = AC AND team = 7' };
const OTHER_BOARD: Narrowing = { by: 'board', id: '43', name: 'Payouts', jql: 'project = AC AND team = 8' };
const JQL: Narrowing = { by: 'jql', jql: 'labels = payments' };
const LIN: Narrowing = { by: 'projects', ids: ['p-2', 'p-1'], names: ['Billing', 'Auth'] };

describe('narrowed scope values', () => {
  it('each narrowing has its own key; none keeps the old key', () => {
    expect(scopeKeyOf('jira', ['AC'])).toBe('jira:AC');
    const keys = [scopeKeyOf('jira', ['AC'], BOARD), scopeKeyOf('jira', ['AC'], OTHER_BOARD), scopeKeyOf('jira', ['AC'], JQL), scopeKeyOf('linear', ['ENG'], LIN)];
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).toBe('jira:AC#board=42');
    expect(keys[3]).toBe('linear:ENG#projects=p-1,p-2');
    expect(keys[2]).toMatch(/^jira:AC#jql=[0-9a-f]{12}$/);
    expect(keys[2]).not.toContain('payments');
  });

  it('the place in a narrowed key still reads as the project or team', () => {
    expect(labelOfScopeKey('jira', 'jira:AC#board=42')).toBe('Jira project AC');
    expect(labelOfScopeKey('linear', 'linear:ENG#projects=p-1')).toBe('Linear team ENG');
  });

  it('describes a narrowed key by its part', () => {
    expect(describeScopeKey('jira', 'jira:AC#board=42', 'team')).toBe('issues on Jira board 42 in Jira project AC');
    expect(describeScopeKey('jira', scopeKeyOf('jira', ['AC'], JQL), 'team')).toBe('issues matching your filter in Jira project AC');
    expect(describeScopeKey('linear', 'linear:ENG#projects=p-1,p-2', 'team')).toBe('issues in 2 Linear projects of Linear team ENG');
    expect(describeScopeKey('jira', 'jira:AC', 'team')).toBe("everyone's items in Jira project AC");
  });

  it('hands the fetcher the narrowing beside the project or team', () => {
    expect(fetchOptsFor('jira', ['AC'], BOARD)).toEqual({ projects: ['AC'], jql: BOARD.jql });
    expect(fetchOptsFor('jira', ['AC'], JQL)).toEqual({ projects: ['AC'], jql: 'labels = payments' });
    expect(fetchOptsFor('linear', ['team-id'], LIN)).toEqual({ teams: ['team-id'], projects: ['p-2', 'p-1'] });
    expect(fetchOptsFor('jira', ['AC'])).toEqual({ projects: ['AC'] });
  });

  it('the disclosure names the part, keeps the read inside the project, and never prints a JQL', () => {
    const board = disclosureText('jira', ['AC'], BOARD);
    expect(board).toContain('issues on the Payments board in Jira project AC');
    expect(board).toContain('Only AC is read, even if the board shows other projects');
    expect(board).not.toContain('team = 7');
    const jql = disclosureText('jira', ['AC'], JQL);
    expect(jql).toContain('issues matching your filter in Jira project AC');
    expect(jql).not.toContain('payments');
    expect(disclosureText('linear', ['ENG'], LIN)).toContain('issues in Linear projects Auth, Billing of Linear team ENG');
  });
});

describe('narrowed scope storage', () => {
  it('is written as kind "narrowed" and read back as a team scope carrying it (two examples)', () => {
    const c = createConfigStore();
    c.setConnectorScope('local', 'jira', { kind: 'team', values: ['AC'], labels: ['AC'], narrow: BOARD });
    expect(c.getConnectorScope('local', 'jira')).toEqual({ kind: 'team', values: ['AC'], labels: ['AC'], narrow: BOARD });
    c.setConnectorScope('local', 'linear', { kind: 'team', values: ['t-1'], labels: ['ENG'], narrow: LIN });
    expect(c.getConnectorScope('local', 'linear')).toEqual({ kind: 'team', values: ['t-1'], labels: ['ENG'], narrow: LIN });
  });

  it('on disk it is not a team scope, so an older CLI cannot widen it', () => {
    const c = createConfigStore();
    c.setConnectorScope('local', 'jira', { kind: 'team', values: ['AC'], labels: ['AC'], narrow: JQL });
    const onDisk = JSON.parse(rawScope('jira')!) as { kind: string };
    expect(onDisk.kind).toBe('narrowed');
  });

  it('a damaged narrowing reads as yours, never as the whole project', () => {
    const c = createConfigStore();
    c.setConnectorScope('local', 'jira', { kind: 'yours' });
    (disk.store['connectorTokens'] as Record<string, string>)['local:jira:scope'] = JSON.stringify({ kind: 'narrowed', values: ['AC'], labels: ['AC'], narrow: { by: 'board', id: 'x; drop' } });
    expect(c.getConnectorScope('local', 'jira')).toEqual({ kind: 'yours' });
  });
});
