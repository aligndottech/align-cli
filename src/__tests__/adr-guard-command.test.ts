/**
 * `align connect adr-guard`: orchestration over the real reader, a real git repository and the link writer.
 * Test list:
 * 1. in a terminal, inside the repo, reads .adr-guard/relationships.json and confirms the replacement
 * 2. with no terminal nothing is written, and the reason is said
 * 3. a missing export exits 1 naming what to run
 * 4. ADRs not imported yet are counted, with what to run
 * 5. a cloud environment writes no local link
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Command } from 'commander';
import type * as ConfigModule from '../lib/config.js';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
const state = vi.hoisted(() => ({ env: { mode: 'local-embedded', localDbPath: '' } as Record<string, unknown> }));
vi.mock('../lib/resolve-env.js', () => ({ resolveImportEnv: () => 'local', resolveEnv: () => 'local' }));
vi.mock('../lib/config.js', async (orig) => {
  const real = await orig<typeof ConfigModule>();
  return { ...real, createConfigStore: () => ({ ...real.createConfigStore(), getEnvironment: () => state.env }) };
});
vi.mock('../lib/curation/judge.js', () => ({ defaultJudge: async () => ({ judgeId: 'install-1', judgeLabel: null }) }));
vi.mock('../lib/not-set-up.js', () => ({ refuseUnlessSetUp: () => undefined }));

const { registerImportCommand } = await import('../commands/import.js');
const { createLocalGatewayClient } = await import('../lib/local-gateway-client.js');
import { getEmbedding } from '../lib/local-embeddings.js';
import { rmDir } from './helpers/rm-dir.js';

vi.setConfig({ testTimeout: 30_000 });

const OLD = 'docs/adr/0001-legacy-storage.md';
const NEW = 'docs/adr/0002-managed-storage.md';
const EXPORT = {
  schemaVersion: '1.0',
  adrs: [
    { identifier: 'ADR-1', path: OLD, title: 'Use legacy storage', status: 'Superseded' },
    { identifier: 'ADR-2', path: NEW, title: 'Use managed storage', status: 'Accepted' },
  ],
  relationships: [{ sourceIdentifier: 'ADR-1', sourcePath: OLD, type: 'superseded-by', declaredTarget: '0002-managed-storage.md', targetIdentifier: 'ADR-2', targetPath: NEW, resolution: 'resolved' }],
  issues: [],
};

let dir: string;
let repo: string;
let prevCwd: string;
let out: string[];
let err: string[];
let ttyBefore: PropertyDescriptor | undefined;
const setTty = (v: boolean) => Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
const dbPath = () => path.join(dir, 'graph.db');

beforeEach(() => {
  vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(384).fill(0.1));
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-adrguard-cmd-')));
  repo = path.join(dir, 'api');
  fs.mkdirSync(path.join(repo, '.adr-guard'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/acme/api.git');
  fs.writeFileSync(path.join(repo, '.adr-guard', 'relationships.json'), JSON.stringify(EXPORT));
  prevCwd = process.cwd();
  process.chdir(repo);
  state.env = { mode: 'local-embedded', localDbPath: dbPath() };
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit:${c}`); }) as never);
  ttyBefore = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(prevCwd);
  if (ttyBefore) Object.defineProperty(process.stdin, 'isTTY', ttyBefore); else delete (process.stdin as { isTTY?: boolean }).isTTY;
  rmDir(dir);
});

async function importAdrs(paths: string[]) {
  const c = createLocalGatewayClient(dbPath());
  try {
    await c.ingestBatch(paths.map((p) => ({ source_url: `https://github.com/acme/api/blob/main/${p}`, platform: 'docs', title: p, raw_text: `# ${p}\n\nWe decided this for a reason.` })) as never, { classify: false });
  } finally { c.close(); }
}
async function run(args: string[] = []): Promise<string | undefined> {
  const program = new Command();
  program.exitOverride();
  registerImportCommand(program);
  try { await program.parseAsync(['connect', 'adr-guard', ...args], { from: 'user' }); } catch (e) { return (e as Error).message; }
  return undefined;
}
function supersedes(): unknown[] {
  if (!fs.existsSync(dbPath())) return [];
  const db = new DatabaseSync(dbPath());
  try { return db.prepare("SELECT 1 FROM decision_links WHERE relation = 'supersedes'").all(); } finally { db.close(); }
}

describe('align connect adr-guard', () => {
  it('in a terminal reads the default export and confirms the replacement', async () => {
    await importAdrs([OLD, NEW]);
    setTty(true);
    expect(await run()).toBeUndefined();
    expect(supersedes()).toHaveLength(1);
    expect(out.join('\n')).toContain('1 replacement(s) confirmed');
  });

  it('without a terminal writes nothing and says why', async () => {
    await importAdrs([OLD, NEW]);
    setTty(false);
    expect(await run()).toBeUndefined();
    expect(supersedes()).toHaveLength(0);
    expect(out.join('\n')).toContain('needs a terminal');
  });

  it('exits 1 naming what to run when there is no export', async () => {
    fs.rmSync(path.join(repo, '.adr-guard'), { recursive: true });
    expect(await run()).toBe('exit:1');
    expect(err.join('\n')).toMatch(/adr-guard export relationships/);
  });

  it('counts ADRs that are not in the graph yet, and names the command that brings them in', async () => {
    await importAdrs([NEW]);
    setTty(true);
    expect(await run()).toBeUndefined();
    expect(supersedes()).toHaveLength(0);
    expect(out.join('\n')).toMatch(/0 replacement\(s\) confirmed, as the ADRs record them; 1 not in your graph \(run align connect docs/);
  });

  it('refuses a --limit that is not a positive whole number', async () => {
    await importAdrs([OLD, NEW]);
    setTty(true);
    for (const bad of ['abc', '0', '-2']) {
      expect(await run(['--limit', bad])).toBe('exit:1');
    }
    expect(supersedes()).toHaveLength(0);
    expect(err.join('\n')).toMatch(/--limit/);
  });

  it('reads the paths against the repository the --file export is in, not the one it is run from', async () => {
    await importAdrs([OLD, NEW]);
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: elsewhere, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/other.git'], { cwd: elsewhere, stdio: 'pipe' });
    process.chdir(elsewhere);
    setTty(true);
    expect(await run(['--file', path.join(repo, '.adr-guard', 'relationships.json')])).toBeUndefined();
    expect(supersedes()).toHaveLength(1);
  });

  it('in a cloud environment writes no local link', async () => {
    state.env = { mode: 'auth', gatewayUrl: 'https://example.test', authToken: 't' };
    setTty(true);
    expect(await run()).toBeUndefined();
    expect(out.join('\n')).toContain('recorded in a local graph only');
    expect(fs.existsSync(dbPath())).toBe(false);
  });
});
