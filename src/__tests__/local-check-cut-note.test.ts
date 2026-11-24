/**
 * #719: local align_check_alignment says when the judge read only part of the text. Test List:
 * 1. cuts reported by the classifier -> the result carries a note naming the decision, and the verdict is untouched
 * 2. no cuts -> no such note
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { mockClassify } = vi.hoisted(() => ({ mockClassify: vi.fn() }));
vi.mock('../lib/similarity/embedding-matrix.js', async () => (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.9),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-candidate-classify.js', () => ({ classifyCandidates: mockClassify }));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

const TITLE = '22. Str.format is the only template surface';
let dir: string;
let client: ReturnType<typeof createLocalGatewayClient>;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'align-cut-note-'));
  const dbPath = path.join(dir, '.graph.db');
  const db = createLocalDb(dbPath);
  const id = db.insertDecision({ title: TITLE, summary: 'Printf % is removed.', sourceUrl: 'https://github.com/o/r/blob/main/doc/adr/22.md', platform: 'docs' });
  db.setEmbedding(typeof id === 'string' ? id : (id as { id: string }).id, new Float32Array(384).fill(0.1), 'Xenova/all-MiniLM-L6-v2');
  db.close();
  client = createLocalGatewayClient(dbPath, { cwd: dir });
});
afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

const relates = (cuts?: unknown) => mockClassify.mockImplementation(async (_s: unknown, cands: unknown[]) => ({
  outcomes: cands.map(() => ({ ok: true, relationship: { type: 'relates', confidence: 0.85 } })),
  ...(cuts ? { cuts } : {}),
}));

describe('local align_check_alignment: a judge that read part of the text says so', () => {
  it('adds a note naming the cut decision, and leaves the verdict as the judge gave it', async () => {
    relates({ windowTokens: 8_192, subject: null, candidates: [{ kept: 10, total: 4_174 }] });
    const r = await client.checkAlignment('Add Str.__mod__ for printf-style formatting');
    expect(r.status).toBe('aligned');
    const note = (r.notes ?? []).find((n: string) => n.includes('8,192-token window'));
    expect(note).toContain(`"${TITLE}", 10 of 4,174 characters`);
  });

  it('adds no such note when nothing was cut', async () => {
    relates({ windowTokens: 32_768, subject: null, candidates: [null] });
    const r = await client.checkAlignment('Add Str.__mod__ for printf-style formatting');
    expect(r.status).toBe('aligned');
    expect((r.notes ?? []).some((n: string) => n.includes('-token window'))).toBe(false);
  });
});
