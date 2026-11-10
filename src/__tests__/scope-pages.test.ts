import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { resolveScope, viewScopes } from '../lib/scope.js';
import { checkScopeFlags, type ConnectScopeCtx, decideConnectScope, type PickOption, SKIP_VALUE } from '../lib/scope-connect.js';
import { describeTeamScope, disclosureText, fetchOptsFor, scopeKeyOf } from '../lib/scope-values.js';
import { windowExtras } from '../lib/since.js';
import { FIELDS, makeDeps, memStore, type Route } from './helpers/scope-deps.js';

/**
 * Notion pages and Confluence page trees (narrowing a read to part of what the token can see).
 *
 * Test List:
 * - Notion: the picker lists what the token can see (skip first), preselects a page whose title shares a whole word with the repo.
 * - Notion: chosen pages reach the fetcher as `pages` and are stored per repo; nothing chosen reads what it read before (no `pages`).
 * - Notion: skip is remembered and reads nothing; the picker cursor starts on what was stored.
 * - Notion: an older stored scope (yours, none) still resolves, and a stored pages scope reaches a background run as `pages`.
 * - Notion: --notion-pages is Notion only, checked against what the token can see, never printing a refused id.
 * - Confluence: after spaces, a second question lists top-level pages; chosen ones reach the fetcher as `ancestors` beside `spaces`.
 * - Confluence: "the whole space" (the default) and an older stored scope read exactly as before.
 * - Confluence: --confluence-pages needs --spaces.
 */
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-pages-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalGatewayClient(dbPath).close();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const P3 = '33333333-3333-3333-3333-333333333333';
const page = (id: string, title: string): unknown => ({ object: 'page', id, properties: { Name: { type: 'title', title: [{ plain_text: title }] } } });
const database = (id: string, title: string): unknown => ({ object: 'database', id, title: [{ plain_text: title }] });
const notionSearch = (...results: unknown[]): Route => [/api\.notion\.com\/v1\/search/, { body: { results, has_more: false } }];
const NOTION: Route[] = [notionSearch(page(P1, 'align-cli roadmap'), database(P2, 'Billing'), page(P3, 'Hiring'))];
const confluenceTables = (): Route[] => [
  [/wiki\/api\/v2\/spaces\?keys=ENG/, { body: { results: [{ id: '100', key: 'ENG' }] } }],
  [/wiki\/api\/v2\/spaces\/100\/pages/, { body: { results: [{ id: '555', title: 'Handbook' }, { id: '556', title: 'Runbooks' }] } }],
  [/wiki\/api\/v2\/pages\/555/, { body: { id: '555', title: 'Handbook' } }],
  [/wiki\/api\/v2\/pages\/556/, { body: { id: '556', title: 'Runbooks' } }],
  [/wiki\/api\/v2\/spaces/, { body: { results: [{ key: 'ENG', name: 'Engineering' }, { key: 'OPS', name: 'Operations' }] } }],
];

interface Asked { message: string; options: PickOption[]; initial: string[] }
function setup(o: { picks?: string[] | null; pagePicks?: string[] | null; flags?: ConnectScopeCtx['flags']; repoNames?: string[]; table?: Route[]; store?: ReturnType<typeof memStore>; inRepo?: boolean }) {
  const said: string[] = [];
  const asked: Asked[] = [];
  const deps = makeDeps(dbPath, { table: o.table ?? [], ...(o.store ? { store: o.store } : {}) });
  const ctx: ConnectScopeCtx = {
    deps, interactive: true, quiet: false, flags: o.flags ?? {},
    prompts: {
      multiselect: async (message, options, initial) => {
        asked.push({ message, options, initial });
        if (message.startsWith('Which pages of')) return o.pagePicks === undefined ? initial : o.pagePicks;
        return o.picks === undefined ? initial : o.picks;
      },
      confirm: async () => false,
    },
    citedKeys: () => [], say: (l) => said.push(l), repoNames: () => o.repoNames ?? [], inRepo: () => o.inRepo ?? true,
  };
  return { ctx, said, asked, deps };
}

describe('Notion picker', () => {
  it('lists pages by title with skip first, and preselects a page sharing a whole word with the repo name', async () => {
    const s = setup({ repoNames: ['align-cli'], table: NOTION });
    await decideConnectScope('notion', FIELDS['notion']!, s.ctx);
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]!.options.map((x) => x.value)).toEqual([SKIP_VALUE, P1, P2, P3]);
    expect(s.asked[0]!.options.map((x) => x.label)).toEqual(['None, skip Notion in this repo', 'align-cli roadmap', 'Billing', 'Hiring']);
    expect(s.asked[0]!.initial).toEqual([P1]);
  });

  it('with no page matching the repo nothing is preselected: Enter keeps today\'s read of everything shared', async () => {
    const s = setup({ repoNames: ['fastify'], table: NOTION });
    const d = await decideConnectScope('notion', FIELDS['notion']!, s.ctx);
    expect(s.asked[0]!.initial).toEqual([]);
    expect(d.extras).toEqual({ resolved: true });
    expect(d.scope).toBe('yours');
  });

  it('chosen pages reach the fetcher as `pages` and are stored for this repo, with their titles', async () => {
    const s = setup({ picks: [P1, P2], table: NOTION });
    const d = await decideConnectScope('notion', FIELDS['notion']!, s.ctx);
    expect(d.extras).toEqual({ resolved: true, pages: [P1, P2] });
    expect(d.scope).toBe('team');
    expect(s.said.join('\n')).toContain('align-cli roadmap');
    d.commit();
    expect(s.deps.store.scopes['notion']).toEqual({ kind: 'team', values: [P1, P2], labels: [P1, P2], narrow: { by: 'pages', ids: [P1, P2], names: ['align-cli roadmap', 'Billing'] } });
  });

  it('none ticked reads what it read before: no `pages`, stored as yours', async () => {
    const s = setup({ picks: [], table: NOTION });
    const d = await decideConnectScope('notion', FIELDS['notion']!, s.ctx);
    expect(d.extras).toEqual({ resolved: true });
    d.commit();
    expect(s.deps.store.scopes['notion']).toEqual({ kind: 'yours' });
  });

  it('skip reads nothing and is remembered; a cancel keeps what was stored', async () => {
    const skip = setup({ picks: [SKIP_VALUE, P1], table: NOTION });
    const d = await decideConnectScope('notion', FIELDS['notion']!, skip.ctx);
    expect(d.skipped).toBe(true);
    d.commit();
    expect(skip.deps.store.scopes['notion']).toEqual({ kind: 'skip' });
    const stored = { kind: 'team' as const, values: [P3], labels: [P3], narrow: { by: 'pages' as const, ids: [P3], names: ['Hiring'] } };
    const cancel = setup({ picks: null, table: NOTION, store: memStore({ scopes: { notion: stored } }) });
    const kept = await decideConnectScope('notion', FIELDS['notion']!, cancel.ctx);
    expect(kept.extras).toMatchObject({ pages: [P3] });
  });

  it('the cursor starts on the pages stored before', async () => {
    const stored = { kind: 'team' as const, values: [P3], labels: [P3], narrow: { by: 'pages' as const, ids: [P3], names: ['Hiring'] } };
    const s = setup({ table: NOTION, store: memStore({ scopes: { notion: stored } }) });
    await decideConnectScope('notion', FIELDS['notion']!, s.ctx);
    expect(s.asked[0]!.initial).toEqual([P3]);
  });

  it('a list that cannot be read is said, and Notion is read as before', async () => {
    const s = setup({ table: [[/api\.notion\.com\/v1\/search/, { status: 500 }]] });
    const d = await decideConnectScope('notion', FIELDS['notion']!, s.ctx);
    expect(s.said.join('\n')).toContain('Could not list your Notion pages');
    expect(d.extras).toEqual({ resolved: true });
  });
});

describe('Notion scope on its own', () => {
  it('an older stored scope (none, or yours) still resolves to reading everything shared, under the yours key', async () => {
    for (const scopes of [{}, { notion: { kind: 'yours' as const } }]) {
      const r = await resolveScope('notion', makeDeps(dbPath, { store: memStore({ scopes }) }), { foreground: true });
      expect(r).toMatchObject({ scope: 'yours', scopeKey: 'yours', extras: {} });
      expect(r.blocked).toBeUndefined();
      expect(r.note).toBeUndefined();
    }
  });

  it('a stored pages scope reaches a background run as `pages`, and skip reads nothing', async () => {
    const stored = { kind: 'team' as const, values: [P1], labels: [P1], narrow: { by: 'pages' as const, ids: [P1], names: ['Roadmap'] } };
    const r = await resolveScope('notion', makeDeps(dbPath, { store: memStore({ scopes: { notion: stored } }), isTty: () => false }), { foreground: false });
    expect(r).toMatchObject({ scope: 'team', extras: { pages: [P1] } });
    const skipped = await resolveScope('notion', makeDeps(dbPath, { store: memStore({ scopes: { notion: { kind: 'skip' } } }) }), { foreground: false });
    expect(skipped.skipped).toContain('skipped in this repo');
  });

  it('is described in words, with its own scope key, and shown by viewScopes', async () => {
    const narrow = { by: 'pages' as const, ids: [P2, P1], names: ['Billing', 'Roadmap'] };
    expect(fetchOptsFor('notion', [P1, P2], narrow)).toEqual({ pages: [P1, P2] });
    expect(scopeKeyOf('notion', [P1, P2], narrow)).toBe(`notion:${P1},${P2}`);
    expect(describeTeamScope('notion', [P1, P2], narrow)).toBe('the Notion pages Billing, Roadmap and the pages under them');
    expect(disclosureText('notion', [P1, P2], narrow)).toContain('Billing, Roadmap');
    const store = memStore({ scopes: { notion: { kind: 'team', values: [P1, P2], labels: [P1, P2], narrow } } });
    const view = (await viewScopes(makeDeps(dbPath, { store }))).find((v) => v.source === 'notion')!;
    expect(view).toMatchObject({ kind: 'team', can_set: true, origin: 'chosen' });
    expect(view.label).toContain('Billing, Roadmap');
    const plain = (await viewScopes(makeDeps(dbPath, { store: memStore() }))).find((v) => v.source === 'notion')!;
    expect(plain.label).toContain('shared with your integration');
  });

  it('--notion-pages is Notion only; ids are checked against what the token can see, and a refused one is not printed back', async () => {
    expect(checkScopeFlags('notion', { notionPages: P1 })).toBeUndefined();
    expect(checkScopeFlags('jira', { notionPages: P1 })).toMatch(/--notion-pages is for Notion/);
    expect(checkScopeFlags('notion', { notionPages: P1, scope: 'yours' })).toMatch(/not both/);
    const ok = setup({ flags: { notionPages: `${P2},${P1}` }, table: NOTION });
    const d = await decideConnectScope('notion', FIELDS['notion']!, ok.ctx);
    expect(d.extras).toEqual({ resolved: true, pages: [P1, P2] });
    const bad = setup({ flags: { notionPages: 'not-an-id' }, table: NOTION });
    await expect(decideConnectScope('notion', FIELDS['notion']!, bad.ctx)).rejects.toThrow(/Notion page id/);
    const hidden = setup({ flags: { notionPages: '44444444-4444-4444-4444-444444444444' }, table: NOTION });
    const err = await decideConnectScope('notion', FIELDS['notion']!, hidden.ctx).catch((e: Error) => e);
    expect((err as Error).message).toContain('cannot see');
    expect((err as Error).message).not.toContain('44444444');
  });

  it('windowExtras keeps `pages` and `ancestors`, so fetch, sync and a background sync all carry them', () => {
    expect(windowExtras({ pages: [P1], ancestors: ['555'], spaces: ['ENG'] })).toEqual({ pages: [P1], ancestors: ['555'], spaces: ['ENG'] });
    expect(windowExtras({})).toEqual({});
  });
});

describe('Confluence pages', () => {
  const spaceAnswer = ['ENG'];

  it('after spaces, lists top-level pages, whole space first and selected; chosen pages reach the fetcher as `ancestors` beside `spaces`', async () => {
    const s = setup({ picks: spaceAnswer, pagePicks: ['555'], table: confluenceTables() });
    const d = await decideConnectScope('confluence', FIELDS['confluence']!, s.ctx);
    const q = s.asked.find((a) => a.message.startsWith('Which pages of'))!;
    expect(q.options[0]!.label).toContain('whole');
    expect(q.options.slice(1).map((x) => x.label)).toEqual(['ENG: Handbook', 'ENG: Runbooks']);
    expect(q.initial).toEqual([':all']);
    expect(d.extras).toEqual({ resolved: true, spaces: ['ENG'], ancestors: ['555'] });
    expect(s.said.join('\n')).toContain('Handbook');
    d.commit();
    expect(s.deps.store.scopes['confluence']).toMatchObject({ kind: 'team', values: ['ENG'], labels: ['ENG'], narrow: { by: 'ancestors', ids: ['555'], names: ['Handbook'] } });
  });

  it('the whole space (the default), nothing ticked or a cancel read exactly as before: no `ancestors`', async () => {
    for (const pagePicks of [[':all'], [], null]) {
      const s = setup({ picks: spaceAnswer, pagePicks, table: confluenceTables() });
      const d = await decideConnectScope('confluence', FIELDS['confluence']!, s.ctx);
      expect(d.extras).toEqual({ resolved: true, spaces: ['ENG'] });
    }
  });

  it('pages that cannot be listed are said, and the whole space is read', async () => {
    const s = setup({ picks: spaceAnswer, table: [[/wiki\/api\/v2\/spaces\?keys=ENG/, { status: 500 }], ...confluenceTables()] });
    const d = await decideConnectScope('confluence', FIELDS['confluence']!, s.ctx);
    expect(s.said.join('\n')).toContain('Could not list the pages');
    expect(d.extras).toEqual({ resolved: true, spaces: ['ENG'] });
  });

  it('an older stored scope (spaces only) resolves with no `ancestors`; a stored one carries them to a background run', async () => {
    const old = await resolveScope('confluence', makeDeps(dbPath, { store: memStore({ scopes: { confluence: { kind: 'team', values: ['ENG'], labels: ['ENG'] } } }) }), { foreground: false });
    expect(old.extras).toEqual({ spaces: ['ENG'] });
    expect(old.scopeKey).toBe('confluence:ENG');
    const narrow = { by: 'ancestors' as const, ids: ['555'], names: ['Handbook'] };
    const r = await resolveScope('confluence', makeDeps(dbPath, { isTty: () => false, store: memStore({ scopes: { confluence: { kind: 'team', values: ['ENG'], labels: ['ENG'], narrow } } }) }), { foreground: false });
    expect(r.extras).toEqual({ spaces: ['ENG'], ancestors: ['555'] });
    expect(r.scopeKey).toBe('confluence:ENG#ancestors=555');
    expect(r.label).toBe('pages under Handbook in Confluence space ENG');
  });

  it('--confluence-pages needs --spaces and is Confluence only; its ids are checked against what the token can see', async () => {
    expect(checkScopeFlags('confluence', { spaces: 'ENG', confluencePages: '555' })).toBeUndefined();
    expect(checkScopeFlags('confluence', { confluencePages: '555' })).toMatch(/--confluence-pages needs --spaces/);
    expect(checkScopeFlags('notion', { notionPages: P1, confluencePages: '555' })).toMatch(/--confluence-pages is for Confluence/);
    expect(checkScopeFlags('confluence', { spaces: 'ENG', confluencePages: '555', scope: 'yours' })).toMatch(/not both/);
    const ok = setup({ flags: { spaces: 'ENG', confluencePages: '556,555' }, table: confluenceTables() });
    const d = await decideConnectScope('confluence', FIELDS['confluence']!, ok.ctx);
    expect(d.extras).toEqual({ resolved: true, spaces: ['ENG'], ancestors: ['555', '556'] });
    const bad = setup({ flags: { spaces: 'ENG', confluencePages: 'abc' }, table: confluenceTables() });
    await expect(decideConnectScope('confluence', FIELDS['confluence']!, bad.ctx)).rejects.toThrow(/Confluence page id/);
    const hidden = setup({ flags: { spaces: 'ENG', confluencePages: '999' }, table: confluenceTables() });
    const err = await decideConnectScope('confluence', FIELDS['confluence']!, hidden.ctx).catch((e: Error) => e);
    expect((err as Error).message).toContain('cannot see');
    expect((err as Error).message).not.toContain('999');
  });
});
