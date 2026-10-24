import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/local-gateway-client.js', () => ({
  createLocalGatewayClient: vi.fn().mockReturnValue({ whoami: vi.fn() }),
}));

import { approveAllSuggestions } from '../lib/approve-suggestions.js';
import { createGatewayClient } from '../lib/gateway-client.js';

/**
 * `align import ... --approve` listed suggestions once. The gateway returns 50 rows
 * when no limit is sent (cap 100), so a big scan approved the first 50 and reported success.
 *
 * Test List:
 *  1. 150 suggestions over 2 pages (100 + 50): all 150 ids reach the bulk approve call
 *  2. 40 suggestions on one page: exactly 40 ids reach it
 *  3. an exact multiple of the page size (100) ends on an empty page, not a loop
 *  4. a sync approve that updated fewer than were listed is reported as such
 *  5. cross-job duplicates, empty, errors carried, unusable reply throws
 */

const GATEWAY_DEFAULT_PAGE = 50; // what the real gateway returns when no limit is sent

let all: Array<{ id: string }>;
let bulkBodies: Array<{ suggestion_ids: string[] }>;
let bulkPaths: string[];
let bulkReply: unknown;

const mockFetch = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = new URL(String(input));
  if (url.pathname === '/import/suggestions' && (init?.method ?? 'GET') === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? GATEWAY_DEFAULT_PAGE), 100);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return json({ suggestions: all.slice(offset, offset + limit), counts: {} });
  }
  if (url.pathname.startsWith('/import/suggestions/bulk')) {
    bulkPaths.push(url.pathname);
    bulkBodies.push(JSON.parse(init?.body ?? '{}'));
    return json(bulkReply);
  }
  throw new Error(`unexpected request ${url.pathname}`);
});
vi.stubGlobal('fetch', mockFetch);

function json(body: unknown) {
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body, text: async () => JSON.stringify(body) };
}

const env = { gatewayUrl: 'https://api.align.tech', authToken: 'tok', tenantId: 't', mode: 'auth' as const };
const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }));

beforeEach(() => {
  mockFetch.mockClear();
  bulkBodies = [];
  bulkPaths = [];
  bulkReply = { updated: 0, created_decisions: [] };
});

describe('approveAllSuggestions pagination', () => {
  it('sends all 150 ids when the gateway serves 2 pages', async () => {
    all = make(150);
    bulkReply = { job_id: 'j1' };
    const r = await approveAllSuggestions(createGatewayClient(env), ['job-1']);
    expect(bulkBodies).toHaveLength(1);
    expect(bulkBodies[0]!.suggestion_ids).toEqual(all.map(s => s.id));
    expect(r.listed).toBe(150);
    expect(bulkPaths).toEqual(['/import/suggestions/bulk-async']);
    expect(r.kind).toBe('async');
  });

  it('sends exactly 40 ids for a single short page', async () => {
    all = make(40);
    bulkReply = { updated: 40, created_decisions: [] };
    const r = await approveAllSuggestions(createGatewayClient(env), ['job-1']);
    expect(bulkBodies[0]!.suggestion_ids).toEqual(all.map(s => s.id));
    expect(r).toEqual({ kind: 'sync', listed: 40, approved: 40, errors: [] });
  });

  it('stops after an empty page when the total is a multiple of the page size', async () => {
    all = make(100);
    await approveAllSuggestions(createGatewayClient(env), ['job-1']);
    expect(bulkBodies[0]!.suggestion_ids).toHaveLength(100);
    const lists = mockFetch.mock.calls.filter(c => String(c[0]).includes('offset=')).length;
    expect(lists).toBe(2);
    const urls = mockFetch.mock.calls.map(c => String(c[0])).filter(u => u.includes('offset='));
    expect(urls.every(u => u.includes('limit=100') && u.includes('job_id=job-1') && u.includes('status=pending'))).toBe(true);
  });

  it('reports approved below listed when the gateway updated fewer', async () => {
    all = make(40);
    bulkReply = { updated: 30, created_decisions: [] };
    const r = await approveAllSuggestions(createGatewayClient(env), ['job-1']);
    expect(r).toEqual({ kind: 'sync', listed: 40, approved: 30, errors: [] });
  });

  it('sends one id once when two jobs list it', async () => {
    all = make(3);
    bulkReply = { updated: 3, created_decisions: [] };
    await approveAllSuggestions(createGatewayClient(env), ['job-1', 'job-2']);
    expect(bulkBodies[0]!.suggestion_ids).toEqual(['s0', 's1', 's2']);
  });

  it('makes no approve call when nothing is pending', async () => {
    all = [];
    const r = await approveAllSuggestions(createGatewayClient(env), ['job-1']);
    expect(r).toEqual({ kind: 'none', listed: 0 });
    expect(bulkBodies).toEqual([]);
  });

  it('carries the gateway errors for skipped rows, and counts the created_decisions array', async () => {
    all = make(3);
    bulkReply = { created_decisions: [{}, {}], errors: ['Already approved'] };
    const r = await approveAllSuggestions(createGatewayClient(env), ['job-1']);
    expect(r).toEqual({ kind: 'sync', listed: 3, approved: 2, errors: ['Already approved'] });
  });

  it('throws on a sync reply with no usable count instead of reporting zero', async () => {
    all = make(3);
    bulkReply = {};
    await expect(approveAllSuggestions(createGatewayClient(env), ['job-1'])).rejects.toThrow(/unrecognised/);
  });
});
