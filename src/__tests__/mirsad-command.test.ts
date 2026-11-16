/**
 * `align connect mirsad --file <path>`: orchestration over the real reader, local graph and link writer.
 * Test list:
 * 1. in a terminal, a file imports its decisions and records its supersedes link as confirmed
 * 2. with no terminal the decisions still import and the link is left out, with the reason said
 * 3. a file that is not JSON exits 1 naming the problem, and imports nothing
 * 4. bad items are skipped and counted; the rest import
 * 5. --file is required
 * 6. a cloud environment imports the decisions and writes no local link
 * 7. --limit caps the import
 * (the not-set-up guard is hooked on the connect group and is covered for mirsad in connect-before-setup.test.ts)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
vi.mock('../lib/curation/judge.js', () => ({ defaultJudge: async () => ({ judgeId: 'install-1', judgeLabel: null }) }));
vi.mock('../lib/not-set-up.js', () => ({ refuseUnlessSetUp: () => undefined }));
vi.mock('../lib/gateway-client.js', async (orig) => {
  const real = await orig<typeof GatewayClientModule>();
  return { ...real, createGatewayClient: (env: { mode: string }) => (env.mode === 'local-embedded' ? real.createGatewayClient(env as never) : { ingestBatch: state.cloudIngest }) };
});

const { registerImportCommand } = await import('../commands/import.js');
import { getEmbedding } from '../lib/local-embeddings.js';
import { rmDir } from './helpers/rm-dir.js';

vi.setConfig({ testTimeout: 30_000 });
const SAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mirsad', 'sample.json');

let dir: string;
let out: string[];
let err: string[];
let ttyBefore: PropertyDescriptor | undefined;
const setTty = (v: boolean) => Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });

beforeEach(() => {
  vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(384).fill(0.1)); // restoreAllMocks below resets it
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-mirsad-cmd-'));
  state.env = { mode: 'local-embedded', gatewayUrl: 'http://localhost:8080', localDbPath: path.join(dir, 'graph.db') };
  state.cloudIngest.mockReset().mockResolvedValue({ snapshots: [] });
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit:${c}`); }) as never);
  ttyBefore = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (ttyBefore) Object.defineProperty(process.stdin, 'isTTY', ttyBefore); else delete (process.stdin as { isTTY?: boolean }).isTTY;
  process.exitCode = undefined;
  rmDir(dir);
});

async function run(args: string[]): Promise<string | undefined> {
  const program = new Command();
  program.exitOverride();
  registerImportCommand(program);
  try { await program.parseAsync(['connect', 'mirsad', ...args], { from: 'user' }); } catch (e) { return (e as Error).message; }
  return undefined;
}
function q<T>(sql: string): T[] {
  const db = new DatabaseSync(path.join(dir, 'graph.db'));
  try { return db.prepare(sql).all() as T[]; } finally { db.close(); }
}
const supersedes = () => q("SELECT 1 FROM decision_links WHERE relation = 'supersedes'");
const write = (name: string, body: string) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };
const item = (id: number, extra: Record<string, unknown> = {}) => ({ id, title: `T${id}`, description: 'd', supersedes: null, superseded_by: null, ...extra });

describe('align connect mirsad', () => {
  it('in a terminal imports the decisions and confirms the supersedes link', async () => {
    setTty(true);
    expect(await run(['--file', SAMPLE, '--approve'])).toBeUndefined();
    expect(q('SELECT 1 FROM decisions')).toHaveLength(3);
    expect(supersedes()).toHaveLength(1);
    expect(out.join('\n')).toContain('1 supersedes link(s) confirmed');
  });

  it('without a terminal imports the decisions, leaves the link out and says why', async () => {
    setTty(false);
    expect(await run(['--file', SAMPLE, '--approve'])).toBeUndefined();
    expect(q('SELECT 1 FROM decisions')).toHaveLength(3);
    expect(supersedes()).toHaveLength(0);
    expect(out.join('\n')).toContain('needs a terminal');
  });

  it('exits 1 naming the problem for a file that is not JSON, and imports nothing', async () => {
    expect(await run(['--file', write('bad.json', '{nope'), '--approve'])).toBe('exit:1');
    expect(err.join('\n')).toMatch(/align connect mirsad: This is not valid JSON/);
    expect(fs.existsSync(path.join(dir, 'graph.db'))).toBe(false);
  });

  it('skips and counts bad items, importing the rest', async () => {
    setTty(true);
    const f = write('mixed.json', JSON.stringify([item(1), { title: 'no id' }, 'junk']));
    expect(await run(['--file', f, '--approve'])).toBeUndefined();
    expect(q('SELECT 1 FROM decisions')).toHaveLength(1);
    expect(out.concat(err).join('\n')).toContain('Skipped 2 item(s)');
  });

  it('requires --file', async () => {
    expect(await run(['--approve'])).toMatch(/required option '--file <path>' not specified/);
  });

  it('in a cloud environment sends the decisions and writes no local link', async () => {
    state.env = { mode: 'auth', gatewayUrl: 'https://example.test', authToken: 't' };
    setTty(true);
    expect(await run(['--file', SAMPLE, '--approve'])).toBeUndefined();
    expect(state.cloudIngest).toHaveBeenCalledTimes(1);
    expect(state.cloudIngest.mock.calls[0]![0]).toHaveLength(3);
    expect(out.join('\n')).toContain('recorded in a local graph only');
    expect(fs.existsSync(path.join(dir, 'graph.db'))).toBe(false);
  });

  it('--limit caps what is imported, and a link to a decision cut by it is ignored', async () => {
    setTty(true);
    expect(await run(['--file', SAMPLE, '--approve', '--limit', '1'])).toBeUndefined();
    expect(q('SELECT 1 FROM decisions')).toHaveLength(1);
    expect(supersedes()).toHaveLength(0);
  });
});
