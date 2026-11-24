import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn(() => 0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['relates_to'],
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { supersedeNotes } from '../lib/local-partial-supersession.js';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

/*
 * TEST LIST. An ADR can replace ONE bullet of another ADR, named by number (vyasdx/adda-cli ADR-0018 and ADR-0013).
 * Headers below are lifted verbatim from that repository.
 * 1. Active header "Supersedes: the "not yet in ADDA's own CI" bullet of ADR-0012": link 0018 -> 0012, either ingest order.
 *    1b. another bullet and ADR number: Supersedes: the "no retries" item of ADR-0004.
 * 2. Passive: `- ADR-0012's "no configuration" bullet is superseded for project-specific files.` links 0013 -> 0012.
 *    2b. another number and noun.
 * 3. Negatives, none linking: "Amends: ADR-0012"; whole-ADR "Supersedes: ADR-0012"; a negated clause;
 *    an ADR number the graph does not hold; a number held by two files (ambiguous).
 */
const ADR = (n: string, slug: string) => `https://github.com/vyasdx/adda-cli/blob/main/adda/DECISIONS/${n}-${slug}.md`;
const HEAD = '<!-- Developed by - Vedavyas Vayalpadu - vyas4c3@gmail.com -->\n<!-- Coded by - Claude Code -->\n\n';
const ADR_0012 = `${HEAD}# 0012 — Instruction files are checked, not mapped\n\nDate: 2026-09-24\nStatus: accepted\nIssue: ENH-ADDA-024\nExtends: ADR-0011\n\n## Context\n\nThe checker reads instruction files.\n\n## Decision\n\n- No configuration.\n- Not yet in ADDA's own CI.\n`;
const ADR_0018 = `${HEAD}# 0018 — \`audit --refs\` runs in CI as a warning\n\nDate: 2026-09-24\nStatus: accepted\nIssue: DEC-ADDA-013\nSupersedes: the "not yet in ADDA's own CI" bullet of ADR-0012\n\n## Context\n\nCI runs the refs audit.\n`;
const ADR_0013 = `${HEAD}# 0013 — The map keeps keys it does not generate\n\nDate: 2026-09-24\nStatus: accepted\nIssue: ENH-ADDA-028\nAmends: ADR-0012\n\n## Consequences\n\n- ADR-0012's "no configuration" bullet is superseded for project-specific files.\n  Its reasoning stands.\n`;

let dir: string; let dbPath: string;
const opened: Array<{ close(): void }> = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-adr-')); dbPath = path.join(dir, 'graph.db'); });
afterEach(() => { for (const h of opened.splice(0)) h.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const client = () => { const c = createLocalGatewayClient(dbPath, { cwd: dir }); opened.push(c); return c; };
type Item = { source_url: string; title: string; raw_text: string };
const item = (n: string, slug: string, raw: string): Item => ({ source_url: ADR(n, slug), title: raw.split('\n').find((l) => l.startsWith('# '))!.slice(2), raw_text: raw });
async function ingest(c: ReturnType<typeof client>, ...items: Item[]): Promise<string[]> {
  const { snapshots } = await c.ingestBatch(items.map((i) => ({ ...i, platform: 'docs', created_at: undefined })));
  return snapshots.map((s) => s.id);
}
function links(): Array<{ source: string; target: string }> {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (!raw.prepare(`SELECT 1 AS x FROM sqlite_master WHERE name = 'decision_partial_supersessions'`).get()) return [];
    return raw.prepare('SELECT source_id AS source, target_id AS target FROM decision_partial_supersessions').all() as Array<{ source: string; target: string }>;
  } finally { raw.close(); }
}

describe('1. an active header naming a bullet of another ADR', () => {
  it('0012 first, then 0018', async () => {
    const [t, s] = await ingest(client(), item('0012', 'instruction-files', ADR_0012), item('0018', 'refs-in-ci', ADR_0018));
    expect(links()).toEqual([{ source: s, target: t }]);
  });
  it('0018 first, then 0012', async () => {
    const [s, t] = await ingest(client(), item('0018', 'refs-in-ci', ADR_0018), item('0012', 'instruction-files', ADR_0012));
    expect(links()).toEqual([{ source: s, target: t }]);
  });
  it('another bullet and number', async () => {
    const [t, s] = await ingest(client(),
      item('0004', 'retries', `# 0004 — Retries\n\nStatus: accepted\n\n- no retries on writes.\n`),
      item('0021', 'backoff', `# 0021 — Backoff\n\nStatus: accepted\nSupersedes: the "no retries" item of ADR-0004\n\nWrites back off.\n`));
    expect(links()).toEqual([{ source: s, target: t }]);
  });
});

describe('2. a passive sentence naming a bullet of another ADR', () => {
  it('0013 supersedes the "no configuration" bullet of 0012', async () => {
    const [t, s] = await ingest(client(), item('0012', 'instruction-files', ADR_0012), item('0013', 'map-keeps-keys', ADR_0013));
    expect(links()).toEqual([{ source: s, target: t }]);
  });
  it('another number and noun', async () => {
    const [t, s] = await ingest(client(),
      item('0004', 'retries', `# 0004 — Retries\n\nStatus: accepted\n\n- no retries on writes.\n`),
      item('0030', 'x', `# 0030 — X\n\nStatus: accepted\n\n- ADR-0004's "no retries" rule is superseded for idempotent calls.\n`));
    expect(links()).toEqual([{ source: s, target: t }]);
  });
});

describe('3. nothing links when the text does not say one part is replaced', () => {
  const only = async (...items: Item[]) => { await ingest(client(), ...items); return links(); };
  it('"Amends: ADR-0012" alone', async () => {
    expect(await only(item('0012', 'a', ADR_0012), item('0013', 'b', `# 0013 — B\n\nAmends: ADR-0012\n\nBody text here.\n`))).toEqual([]);
  });
  it('a whole-ADR "Supersedes: ADR-0012" stays a person\'s act', async () => {
    expect(await only(item('0012', 'a', ADR_0012), item('0013', 'b', `# 0013 — B\n\nSupersedes: ADR-0012\n\nBody text here.\n`))).toEqual([]);
  });
  it('a negated clause', async () => {
    expect(await only(item('0012', 'a', ADR_0012), item('0013', 'b', `# 0013 — B\n\n- ADR-0012's "no configuration" bullet is not superseded by this.\n`))).toEqual([]);
  });
  it('an ADR number the graph does not hold', async () => {
    expect(await only(item('0018', 'b', ADR_0018))).toEqual([]);
  });
  it('a number held by two files in one repo is ambiguous', async () => {
    expect(await only(item('0012', 'a', ADR_0012), item('0012', 'other', ADR_0012.replace('# 0012', '# 0012b')), item('0018', 'b', ADR_0018))).toEqual([]);
  });
});

describe('the parser alone', () => {
  it('reads the quoted words of the bullet', () => {
    expect(supersedeNotes('Supersedes: the "not yet in ADDA\'s own CI" bullet of ADR-0012').map((n) => n.adr)).toEqual([12]);
  });
});
