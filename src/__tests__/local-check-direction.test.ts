/**
 * Direction of the v0 pair classifier through the public checkAlignment path. The classifier's prompt
 * asks how B relates to A, and "supersedes" means B replaces A. The recorded decision must therefore be
 * A and the proposed change B, so "supersedes" reads as "the change reverses the recorded decision".
 * The fake answers by WHICH argument is A, so a swapped call site changes the verdict.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';


vi.mock('../lib/similarity/embedding-matrix.js', async () => (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

process.env['ALIGN_DETECTOR'] = 'v0';
let repo: string;
let dbPath: string;
let client: ReturnType<typeof createLocalGatewayClient>;
vi.mock('../lib/local-relationship-classifier.js', async (orig) => ({
  ...(await orig<typeof import('../lib/local-relationship-classifier.js')>()),
  classifyRelationship: vi.fn(async (a: { title: string }) => ({
    ok: true,
    // B supersedes A only when the RECORDED decision is A (so B, the change, replaces it).
    relationship: { type: a.title === 'fix: clamp error statusCode between 400 and 599 with 500 fallback (#7089)' ? 'supersedes' : 'relates', confidence: 0.9, reason: 'because' },
  })),
}));

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

const PROSE = 'In error-status.js, keep status codes in the 1xx-3xx range instead of falling back to 500.';

describe('local align_check_alignment classifier direction', () => {
  it('puts the recorded decision in A and the change in B, so "supersedes" is a reversal', async () => {
    const r = await client.checkAlignment(PROSE, 'ctx');
    expect(r.status).toBe('conflicting');
    expect(r.conflicts?.[0]?.reason).toMatch(/^Reverses a recorded decision/);
  });
});
