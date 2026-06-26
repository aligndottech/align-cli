import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DoD: a green test here must predict that `align setup --local` then `align ask` /
// `align search` works when a user runs it for real. So we mock ONLY the heavy,
// non-deterministic boundary (the on-device embedding model). The local SQLite DB,
// the real createGatewayClient wiring, and the real command logic all run for real.
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.9),
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue(null),
}));
vi.mock('../lib/local-llm.js', () => ({ synthesiseLocally: vi.fn().mockResolvedValue(null) }));

let dbPath = '';
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({
      gatewayUrl: '',
      authToken: null,
      tenantId: null,
      mode: 'local-embedded',
      localDbPath: dbPath,
    })),
    getDefaultEnv: vi.fn(() => 'local'),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'local') }));

import { createLocalDb } from '../lib/local-db.js';
import { registerAskCommand } from '../commands/why.js';
import { registerSearchCommand } from '../commands/search.js';

const output: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });
// Surface a command's process.exit(1) as a throw so a crash fails the test loudly
// instead of killing the runner.
vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as never);

describe('ask/search against a real local-embedded graph (BUG-2 end-to-end)', () => {
  beforeEach(() => {
    output.length = 0;
    dbPath = path.join(os.tmpdir(), `align-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = createLocalDb(dbPath);
    const id = db.insertDecision({ title: 'Adopt PostgreSQL', summary: 'Chose Postgres for JSONB + pgvector', sourceUrl: null, platform: 'git' });
    db.setEmbedding(id, new Float32Array(384).fill(0.1));
    db.close();
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Best-effort cleanup: the command opens the local client but never closes it
    // (in real use the process just exits), so on Windows the SQLite file is still
    // locked here (EBUSY on unlink). The temp dir is reaped by the OS; don't fail
    // the test on cleanup.
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${dbPath}${suffix}`;
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* Windows: handle still open */ }
    }
  });

  it('`align ask` renders a local decision instead of crashing on results.results', async () => {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);
    expect(output.some(l => l.includes('Adopt PostgreSQL'))).toBe(true);
  });

  it('`align search` renders a local decision instead of crashing', async () => {
    const program = new Command();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'align', 'search', 'postgres']);
    expect(output.some(l => l.includes('Adopt PostgreSQL'))).toBe(true);
  });
});