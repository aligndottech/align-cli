import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
const empty = { items: [], report: { scanned: 0, skips: [], complete: true } };
const fetchNotionItems = vi.hoisted(() => vi.fn(async () => empty));
const fetchConfluenceItems = vi.hoisted(() => vi.fn(async () => empty));
vi.mock('../lib/fetchers/notion.js', () => ({ fetchNotionItems }));
vi.mock('../lib/fetchers/confluence.js', () => ({ fetchConfluenceItems }));

import { buildSources } from '../commands/setup.js';
import { fetchSource } from '../lib/sync/sources.js';

/**
 * The pages a person chose reach the REAL fetcher call, through the one path connect, sync and a background sync all use
 * (fetchSource -> the source's fetch in setup.ts -> the fetcher), not only the scope code in front of it.
 */
beforeEach(() => { fetchNotionItems.mockClear(); fetchConfluenceItems.mockClear(); });

describe('chosen pages reach the fetcher', () => {
  const P = '11111111-1111-1111-1111-111111111111';

  it('Notion `pages`, from a sync and from connect', async () => {
    await fetchSource('notion', { token: 't' }, {}, { scopeKey: `notion:${P}`, scope: 'team', extras: { pages: [P] } });
    expect(fetchNotionItems).toHaveBeenLastCalledWith(expect.objectContaining({ token: 't', pages: [P] }));
    const def = buildSources(false).find((s) => s.id === 'notion')!;
    await def.fetch({ token: 't' }, {}, { resolved: true, pages: [P] });
    expect(fetchNotionItems).toHaveBeenLastCalledWith(expect.objectContaining({ pages: [P] }));
  });

  it('Confluence `ancestors` beside `spaces`, from a sync and from connect', async () => {
    await fetchSource('confluence', { token: 't' }, {}, { scopeKey: 'confluence:ENG#ancestors=555', scope: 'team', extras: { spaces: ['ENG'], ancestors: ['555'] } });
    expect(fetchConfluenceItems).toHaveBeenLastCalledWith(expect.objectContaining({ spaces: ['ENG'], ancestors: ['555'] }));
    const def = buildSources(false).find((s) => s.id === 'confluence')!;
    await def.fetch({ token: 't' }, {}, { resolved: true, spaces: ['ENG'], ancestors: ['555'] });
    expect(fetchConfluenceItems).toHaveBeenLastCalledWith(expect.objectContaining({ ancestors: ['555'] }));
  });

  it('no pages chosen sends neither option (an older scope reads as before)', async () => {
    await fetchSource('notion', { token: 't' }, {}, { scopeKey: 'yours', scope: 'yours', extras: {} });
    expect(fetchNotionItems.mock.calls.at(-1)![0]).not.toHaveProperty('pages');
    await fetchSource('confluence', { token: 't' }, {}, { scopeKey: 'confluence:ENG', scope: 'team', extras: { spaces: ['ENG'] } });
    expect(fetchConfluenceItems.mock.calls.at(-1)![0]).not.toHaveProperty('ancestors');
  });
});
