/**
 * A date taken from git history must not look as solid as a date the ADR declares.
 * Test List:
 *  S1  adrDecisionDate says which source gave the date (written / first-commit), two examples each
 *  S2  no date at all: undefined
 *  S3  the docs item carries `date_source: 'first-commit'` only for a git date
 *  S4  the local store remembers it; the row's basis is `first_commit`, a written date stays `decided`
 *  S5  re-import: a written date arriving later replaces the git date and clears the mark; the reverse sets it
 *  S6  a first-commit date still orders like a decided one (later-on-topic, timeline)
 *  S7  the timeline contract tells the agent to suffix `first_commit`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

vi.mock('../../lib/similarity/embedding-matrix.js', async () =>
  (await import('../helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.9),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['relates_to'],
}));
vi.setConfig({ testTimeout: 30_000 });

import { adrDecisionDate } from '../../lib/fetchers/adr-date.js';
import { fetchDocsItems } from '../../lib/fetchers/docs.js';
import { createLocalGatewayClient } from '../../lib/local-gateway-client.js';
import { createLocalDb } from '../../lib/local-db.js';
import { topicTimelineMessage } from '../../lib/mcp-timeline-tools.js';
import { dateOf, laterOnTopic } from '../../lib/local-later-on-topic.js';

let repo: string;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'align-adrsrc-')); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

const BODY = 'We need a relational store with strong consistency across services.';
function adr(name: string, text: string): void {
  mkdirSync(join(repo, 'docs/adr'), { recursive: true });
  writeFileSync(join(repo, 'docs/adr', name), text);
}
async function git(args: string[], date?: string): Promise<void> {
  await execa('git', args, {
    cwd: repo,
    env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
}
async function commitAll(date: string): Promise<void> {
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'x'], date);
}

describe('S1 / S2 adrDecisionDate reports its source', () => {
  it('a header Date is written; so is front matter', async () => {
    expect(await adrDecisionDate(repo, 'a.md', `# A\n\nDate: 2025-09-01\n\n${BODY}`, false))
      .toEqual({ date: '2025-09-01', source: 'written' });
    expect(await adrDecisionDate(repo, 'b.md', `---\ndate: 2024-02-03\n---\n# B\n\n${BODY}`, false))
      .toEqual({ date: '2024-02-03', source: 'written' });
  });

  it('no declared date falls back to the first commit, and says so', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0001-a.md', `# A\n\n${BODY}`);
    adr('0002-b.md', `# B\n\n${BODY}`);
    await commitAll('2023-05-06T00:00:00+00:00');
    expect(await adrDecisionDate(repo, 'docs/adr/0001-a.md', `# A\n\n${BODY}`))
      .toEqual({ date: '2023-05-06T00:00:00.000Z', source: 'first-commit' });
    expect(await adrDecisionDate(repo, 'docs/adr/0002-b.md', `# B\n\n${BODY}`))
      .toEqual({ date: '2023-05-06T00:00:00.000Z', source: 'first-commit' });
  });

  it('neither: undefined', async () => {
    expect(await adrDecisionDate(repo, 'c.md', `# C\n\n${BODY}`, false)).toBeUndefined();
  });
});

describe('S3 - S5 the item, the store, the re-import', () => {
  async function importAll(client: ReturnType<typeof createLocalGatewayClient>) {
    const { items } = await fetchDocsItems({ limit: 50, cwd: repo });
    return { items, ...(await client.ingestBatch(items)) };
  }

  it('S3 only a git date marks the item', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0001-git.md', `# Git dated\n\n${BODY}`);
    adr('0002-written.md', `# Written\n\nDate: 2025-09-01\n\n${BODY}`);
    await commitAll('2023-05-06T00:00:00+00:00');
    const { items } = await fetchDocsItems({ limit: 50, cwd: repo });
    const by = (n: string) => items.find((i) => i.source_url.endsWith(n)) as { date_source?: string };
    expect(by('0001-git.md').date_source).toBe('first-commit');
    expect(by('0002-written.md').date_source).toBeUndefined();
  });

  it('S4 the store keeps the source: first_commit vs decided', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0001-git.md', `# Git dated\n\n${BODY}`);
    adr('0002-written.md', `# Written\n\nDate: 2025-09-01\n\n${BODY}`);
    await commitAll('2023-05-06T00:00:00+00:00');
    const dbPath = join(repo, 'graph.db');
    const client = createLocalGatewayClient(dbPath);
    const { snapshots } = await importAll(client);
    client.close?.();
    const db = createLocalDb(dbPath);
    const byTitle = (t: string) => db.getDecisionById(snapshots.find((s) => s.title === t)!.id)!;
    expect(dateOf(byTitle('Git dated'))?.basis).toBe('first_commit');
    expect(dateOf(byTitle('Written'))?.basis).toBe('decided');
    db.close();
  });

  it('S5 written date arriving later replaces the git date and clears the mark; the reverse sets it', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0001-x.md', `# Flip\n\n${BODY}`);
    await commitAll('2023-05-06T00:00:00+00:00');
    const dbPath = join(repo, 'graph.db');
    const read = (id: string) => { const d = createLocalDb(dbPath); const r = d.getDecisionById(id)!; d.close(); return r; };
    const client = createLocalGatewayClient(dbPath);
    const first = await importAll(client);
    const id = first.snapshots[0].id;
    expect(dateOf(read(id))?.basis).toBe('first_commit');

    adr('0001-x.md', `# Flip\n\nDate: 2025-09-01\n\n${BODY}`);
    await importAll(client);
    expect(read(id)).toMatchObject({ decidedAt: '2025-09-01T00:00:00.000Z' });
    expect(dateOf(read(id))?.basis).toBe('decided');

    adr('0001-x.md', `# Flip\n\n${BODY}`);
    await importAll(client);
    expect(dateOf(read(id))?.basis).toBe('first_commit');
    client.close?.();
  });

  it('S6 later-on-topic lists a later first-commit row with its own basis, and a decided hit still sees it', () => {
    const row = (id: string, decidedAt: string, dateFirstCommit?: boolean) =>
      ({ id, title: id, summary: '', sourceUrl: null, platform: 'docs', createdAt: '2026-11-01 00:00:00', decidedAt, repo: null,
        deciderKind: null, confirmedBy: null, confirmedAt: null, ratifiedBy: null, ratifiedAt: null, dateFirstCommit }) as never;
    const hit = row('hit', '2024-01-01T00:00:00.000Z');
    const later = row('later', '2025-01-01T00:00:00.000Z', true);
    const out = laterOnTopic({ hit, neighbours: [{ decisionId: 'later', score: 0.9 }], linksOfHit: [], rowById: (id) => (id === 'later' ? later : null), threshold: 0.5 });
    expect(out.map((e) => [e.id, e.date_basis])).toEqual([['later', 'first_commit']]);
  });

  it('S6 a first-commit date still orders like a decided one, and the timeline labels it', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0001-old.md', `# Old tick\n\nDate: 2024-01-01\n\n${BODY}`);
    adr('0002-new.md', `# New tick\n\n${BODY}`);
    await commitAll('2025-01-01T00:00:00+00:00');
    const client = createLocalGatewayClient(join(repo, 'graph.db'));
    await importAll(client);
    const t = await client.getTopicTimeline('relational store', 50, undefined, { all: true });
    expect((t.decisions ?? []).map((d) => [d.title, d.date_basis])).toEqual([['Old tick', 'decided'], ['New tick', 'first_commit']]);
    client.close?.();
  });
});

describe('S7 the timeline contract', () => {
  it('tells the agent to suffix first_commit dates', async () => {
    const text = topicTimelineMessage({
      count: 2, semanticRan: true, topic: 't', backgroundCount: 0, whyState: 'absent', disagreementCount: undefined,
      stillOpenState: 'absent', chainCount: 2, chainPlatforms: ['docs'], chainSupersededCount: 0, chainCorrectedCount: 0,
    });
    expect(text).toMatch(/Suffix anything not `decided`[^\n]*\(first commit\)/);
  });
});
