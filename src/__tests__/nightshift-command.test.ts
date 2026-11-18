/**
 * `align connect nightshift`: orchestration over the real reader and a real local graph.
 * Test list:
 * 1. answered parking-lot entries import; open ones stay out, and the command says how many are open
 * 2. a re-run after an answer changes updates the decision rather than adding a second one
 * 3. no .nightshift folder exits 1 naming the problem, and imports nothing
 * 4. --dir reads another repo's .nightshift
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Command } from 'commander';
import type * as ConfigModule from '../lib/config.js';
import type * as GatewayClientModule from '../lib/gateway-client.js';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('ora', () => ({ default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn(), fail: vi.fn(), succeed: vi.fn(), warn: vi.fn() })) }));
const state = vi.hoisted(() => ({ env: { mode: 'local-embedded', gatewayUrl: 'http://localhost:8080', localDbPath: '' } as Record<string, unknown>, cloudIngest: vi.fn() }));
vi.mock('../lib/resolve-env.js', () => ({ resolveImportEnv: () => 'local', resolveEnv: () => 'local' }));
vi.mock('../lib/config.js', async (orig) => {
  const real = await orig<typeof ConfigModule>();
  return { ...real, createConfigStore: () => ({ ...real.createConfigStore(), getEnvironment: () => state.env }) };
});
vi.mock('../lib/not-set-up.js', () => ({ refuseUnlessSetUp: () => undefined }));
vi.mock('../lib/gateway-client.js', async (orig) => {
  const real = await orig<typeof GatewayClientModule>();
  return { ...real, createGatewayClient: (env: { mode: string }) => (env.mode === 'local-embedded' ? real.createGatewayClient(env as never) : { ingestBatch: state.cloudIngest }) };
});

const { registerImportCommand } = await import('../commands/import.js');
import { getEmbedding } from '../lib/local-embeddings.js';
import { rmDir } from './helpers/rm-dir.js';

vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let repo: string;
let out: string[];
let err: string[];
let cwdBefore: string;

beforeEach(() => {
  vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(384).fill(0.1));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-ns-cmd-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  state.env = { mode: 'local-embedded', gatewayUrl: 'http://localhost:8080', localDbPath: path.join(dir, 'graph.db') };
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit:${c}`); }) as never);
  cwdBefore = process.cwd();
  process.chdir(repo);
  process.exitCode = undefined;
});
afterEach(() => {
  process.chdir(cwdBefore);
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmDir(dir);
});

async function run(args: string[]): Promise<string | undefined> {
  const program = new Command();
  program.exitOverride();
  registerImportCommand(program);
  try { await program.parseAsync(['connect', 'nightshift', ...args], { from: 'user' }); } catch (e) { return (e as Error).message; }
  return undefined;
}
function q<T>(sql: string): T[] {
  const db = new DatabaseSync(path.join(dir, 'graph.db'));
  try { return db.prepare(sql).all() as T[]; } finally { db.close(); }
}
const lot = (root: string, ...entries: string[]) => {
  fs.mkdirSync(path.join(root, '.nightshift', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nightshift', 'inbox', 'parking-lot.md'), `# Parking Lot\n\n---\n\n${entries.join('\n')}\n`);
};

describe('align connect nightshift', () => {
  it('imports answered entries, leaves open ones in nightshift, and says how many are open', async () => {
    lot(repo, '- Keep the cache? · kept it · cheaper · answered: yes', '- Ship the flag on? · answered: yes, behind the setting', '- Bump Node? · moved to 22 · 20 is ending');
    expect(await run(['--approve'])).toBeUndefined();
    expect(q<{ title: string }>('SELECT title FROM decisions ORDER BY title').map((r) => r.title)).toEqual(['Keep the cache?', 'Ship the flag on?']);
    expect(out.concat(err).join('\n')).toMatch(/1 parking-lot entry is still open/);
  });

  it('a re-run after the answer changes updates the decision rather than adding another', async () => {
    lot(repo, '- Keep the cache? · kept it · cheaper · answered: yes');
    await run(['--approve']);
    lot(repo, '- Keep the cache? · kept it · cheaper · answered: yes, for a week');
    await run(['--approve']);
    const rows = q<{ summary: string }>("SELECT summary FROM decisions WHERE title = 'Keep the cache?'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toContain('yes, for a week');
  });

  it('exits 1 naming the problem when there is no .nightshift folder, and imports nothing', async () => {
    expect(await run(['--approve'])).toBe('exit:1');
    expect(err.join('\n')).toMatch(/align connect nightshift: There is no \.nightshift folder/);
    expect(fs.existsSync(path.join(dir, 'graph.db'))).toBe(false);
  });

  it('says how many were left out when --limit is below what was found', async () => {
    lot(repo, '- Keep the cache? · answered: yes', '- Use pnpm? · answered: yes', '- Ship it? · answered: yes');
    expect(await run(['--limit', '2', '--approve'])).toBeUndefined();
    expect(q('SELECT 1 FROM decisions')).toHaveLength(2);
    expect(out.concat(err).join('\n')).toMatch(/Importing 2 of 3 answered decisions\. Raise --limit to import the rest\./);
  });

  it('--dir reads another repo', async () => {
    const other = path.join(dir, 'other');
    lot(other, '- Use pnpm? · answered: yes');
    expect(await run(['--dir', other, '--approve'])).toBeUndefined();
    expect(q<{ title: string }>('SELECT title FROM decisions').map((r) => r.title)).toEqual(['Use pnpm?']);
  });
});
