/**
 * The local pre-edit check (align_check_alignment) also considers the decisions that wrote the code
 * the change touches, marked with how they were found, and the judge still decides the verdict.
 *
 *  1. Prose naming a tracked file: its writer joins the candidates with found_by 'blame-file'.
 *  2. A unified diff: the old-line writer joins with 'blame-lines'.
 *  3. Provenance alone is never a conflict: the judge says "relates" -> aligned; "conflicts_with" -> conflicting.
 *  4. Keyless (judge cannot run): unknown, with the writer listed, never a pass.
 *  5. Prose with no file and the edit hook's retrieval-only depth: unchanged (nothing found, no blame).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { mockClassify } = vi.hoisted(() => ({ mockClassify: vi.fn() }));
vi.mock('../lib/similarity/embedding-matrix.js', async () => (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-candidate-classify.js', () => ({ classifyCandidates: mockClassify }));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

let repo: string;
let dbPath: string;
let client: ReturnType<typeof createLocalGatewayClient>;
const TITLE = 'fix: clamp error statusCode between 400 and 599 with 500 fallback (#7089)';
const git = (...a: string[]): string =>
  execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'align-check-blame-'));
  dbPath = path.join(repo, '.graph.db');
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, '.gitignore'), '.graph.db*\n');
  writeFileSync(path.join(repo, 'error-status.js'), 'if (code >= 400) keep(code)\nelse fallback()\n');
  git('add', '.');
  git('commit', '-q', '-m', TITLE);
  const db = createLocalDb(dbPath);
  db.insertDecision({ title: TITLE, summary: 'clamp', sourceUrl: `https://github.com/acme/w/commit/${git('rev-parse', 'HEAD')}`, platform: 'git' });
  db.close();
  client = createLocalGatewayClient(dbPath, { cwd: repo });
});
afterAll(() => {
  client.close();
  rmSync(repo, { recursive: true, force: true });
});

const judge = (type: string | null) => mockClassify.mockImplementation(async (_s: unknown, cands: unknown[]) => ({
  outcomes: cands.map(() => (type
    ? { ok: true, relationship: { type, confidence: 0.9, reason: 'because' } }
    : { ok: false, reason: 'no_llm_key', failure: undefined })),
}));
const PROSE = 'In error-status.js, keep status codes in the 1xx-3xx range instead of falling back to 500.';

describe('local align_check_alignment with blame candidates', () => {
  it('names the writer of a file the prose names, marked blame-file, and the judge decides: relates -> aligned', async () => {
    judge('relates');
    const r = await client.checkAlignment(PROSE, 'ctx');
    expect(r.status).toBe('aligned');
    expect(r.relevant_decisions?.map((d: { title: string; found_by?: string }) => [d.title, d.found_by])).toEqual([[TITLE, 'blame-file']]);
    expect(r.relevant_decisions?.[0]?.similarity).toBeUndefined();
  });

  it('the judge saying conflicts_with makes the conflict, carrying the provenance', async () => {
    judge('conflicts_with');
    const r = await client.checkAlignment(PROSE, 'ctx');
    expect(r.status).toBe('conflicting');
    expect(r.conflicts?.[0]).toMatchObject({ title: TITLE, found_by: 'blame-file' });
  });

  it('a unified diff over the blamed line yields it as blame-lines', async () => {
    judge('relates');
    const diff = '--- a/error-status.js\n+++ b/error-status.js\n@@ -1,1 +1,1 @@\n-if (code >= 400) keep(code)\n+if (code >= 100) keep(code)\n';
    const r = await client.checkAlignment(diff, 'ctx');
    expect(r.relevant_decisions?.map((d: { found_by?: string }) => d.found_by)).toEqual(['blame-lines']);
  });

  it('keyless: the judge cannot run, so the status is unknown (not a pass) and the writer is still listed', async () => {
    judge(null);
    const r = await client.checkAlignment(PROSE, 'ctx');
    expect(r.status).toBe('unknown');
    expect(r.relevant_decisions?.map((d: { title: string }) => d.title)).toEqual([TITLE]);
  });

  it('prose naming no file, and the hook\'s retrieval-only depth, find nothing through blame', async () => {
    judge('relates');
    mockClassify.mockClear();
    const none = await client.checkAlignment('make the status range wider', 'ctx');
    expect(none.relevant_decisions ?? []).toEqual([]);
    const hook = await client.checkAlignment(PROSE, 'ctx', { depth: 'related' });
    expect(hook.relevant_decisions ?? []).toEqual([]);
    expect(mockClassify).not.toHaveBeenCalled();
  });
});

describe('align_check_alignment tool description', () => {
  it('stays first in the tool list and asks for a real diff and file names', async () => {
    const { TOOL_SCHEMAS } = await import('../commands/mcp.js');
    expect(TOOL_SCHEMAS[0]?.name).toBe('align_check_alignment');
    expect(TOOL_SCHEMAS[0]?.description).toMatch(/unified diff/);
    expect(TOOL_SCHEMAS[0]?.description).toMatch(/name the files/);
  });
});
