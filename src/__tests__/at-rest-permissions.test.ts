import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alignConfigDir } from '../lib/private-files.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore, migrateConfigDirectory } from '../lib/config.js';
import { migrateLocalDb } from '../lib/local-mode.js';
import { createLocalDb } from '../lib/local-db.js';
import { markSurfaced, recentlySurfaced } from '../lib/advisory-dedup.js';
import { writeBlocked } from '../lib/sync/blocked.js';
import { listPromotions } from '../lib/share/ledger.js';
import { anyJudgements } from '../lib/curation/guardrail.js';
import { issueCode, loadRequest } from '../lib/share/pending.js';
import type { SharePayload } from '../lib/share/payload.js';
import { adjudicationPayloadPath, privateTmpDir } from '../lib/advisory-verdict.js';
import { modelFileCache } from '../lib/model-cache.js';
import { assertIsolatedHome } from './helpers/isolated-home.js';
import { rmDir } from './helpers/rm-dir.js';

// Owner-only modes are POSIX; see private-files.test.ts for the Windows half.
const posix = process.platform !== 'win32';
const mode = (p: string): number => statSync(p).mode & 0o777;

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'align-at-rest-')); });
afterEach(() => { vi.unstubAllEnvs(); rmDir(dir); });

describe.skipIf(!posix)('the config directory and config.json', () => {
  // The real conf, against the isolated test home (never the developer's real ~/.config).
  const configDir = alignConfigDir();
  const configFile = path.join(configDir, 'config.json');

  it('a pre-existing 0755 directory and 0644 config.json are tightened when the store opens', () => {
    assertIsolatedHome(configDir);
    mkdirSync(configDir, { recursive: true });
    chmodSync(configDir, 0o755);
    writeFileSync(configFile, '{"defaultEnv":"prod","environments":{},"connectorTokens":{}}');
    chmodSync(configFile, 0o644);
    createConfigStore();
    expect(mode(configDir)).toBe(0o700);
    expect(mode(configFile)).toBe(0o600);
  });

  it('a fresh store creates them owner-only', () => {
    assertIsolatedHome(configDir);
    rmDir(configDir);
    const old = process.umask(0o000);
    try {
      createConfigStore().setLocalMode('/x/local.db');
    } finally {
      process.umask(old);
    }
    expect(existsSync(configFile)).toBe(true);
    expect(mode(configDir)).toBe(0o700);
    expect(mode(configFile)).toBe(0o600);
  });
});

describe.skipIf(!posix)('the one-time directory migrations copy into an owner-only place', () => {
  it('migrateConfigDirectory: a 0644 old config lands 0600 in a 0700 directory', () => {
    const oldDir = path.join(dir, 'old');
    const newDir = path.join(dir, 'new');
    mkdirSync(oldDir);
    writeFileSync(path.join(oldDir, 'config.json'), '{}');
    chmodSync(path.join(oldDir, 'config.json'), 0o644);
    const old = process.umask(0o000);
    try { migrateConfigDirectory(oldDir, newDir); } finally { process.umask(old); }
    expect(mode(newDir)).toBe(0o700);
    expect(mode(path.join(newDir, 'config.json'))).toBe(0o600);
  });

  it('migrateLocalDb: a 0644 old graph lands 0600 in a 0700 directory', () => {
    const oldDir = path.join(dir, 'oldg');
    const newDir = path.join(dir, 'newg');
    createLocalDb(path.join(oldDir, 'local.db')).close();
    chmodSync(path.join(oldDir, 'local.db'), 0o644);
    const old = process.umask(0o000);
    try { migrateLocalDb(oldDir, newDir, { cwd: dir, home: dir }); } finally { process.umask(old); }
    expect(existsSync(path.join(newDir, 'local.db'))).toBe(true);
    expect(mode(newDir)).toBe(0o700);
    expect(mode(path.join(newDir, 'local.db'))).toBe(0o600);
  });
});

describe.skipIf(!posix)('state files rewritten in place stay owner-only', () => {
  it('the advisory dedup marker lives in the verified private temp folder, 0600, fresh and rewritten', () => {
    const cwd = path.join(dir, 'proj');
    // Review finding: a predictable name directly in the shared temp dir could be pre-planted by another account
    // (a symlink, or a 0666 file we would write into). It belongs in align-<uid>, which is lstat- and uid-checked.
    const store = privateTmpDir();
    expect(store).not.toBeNull();
    const marker = path.join(store!, `advisory-${createHash('sha1').update(cwd).digest('hex').slice(0, 16)}.json`);
    try {
      markSurfaced(cwd, ['a']);
      expect(existsSync(marker)).toBe(true);
      expect(mode(marker)).toBe(0o600);
      chmodSync(marker, 0o644);
      markSurfaced(cwd, ['b']);
      expect(mode(marker)).toBe(0o600);
      expect([...recentlySurfaced(cwd)].sort()).toEqual(['a', 'b']);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it('a blocked-source marker rewritten over a 0644 file is 0600', () => {
    const state = path.join(dir, 'state');
    mkdirSync(state, { mode: 0o700 });
    writeBlocked('confluence', 'manual', 'r', state);
    const f = path.join(state, 'confluence.blocked.json');
    expect(mode(f)).toBe(0o600);
    chmodSync(f, 0o644);
    writeBlocked('confluence', 'manual', 'r2', state);
    expect(mode(f)).toBe(0o600);
  });
});

describe.skipIf(!posix)('every short-lived opener of the graph re-checks its mode, not only createLocalDb', () => {
  const looseGraph = (): string => {
    const dbPath = path.join(dir, 'g', 'local.db');
    createLocalDb(dbPath).close();
    chmodSync(dbPath, 0o644);
    return dbPath;
  };
  it('the share ledger reader', () => {
    const dbPath = looseGraph();
    expect(listPromotions(dbPath, 'prod', 't').size).toBe(0);
    expect(mode(dbPath)).toBe(0o600);
  });
  it('the judgements guardrail reader', () => {
    const dbPath = looseGraph();
    expect(anyJudgements(dbPath)).toBe(false);
    expect(mode(dbPath)).toBe(0o600);
  });
});

describe.skipIf(!posix)('private state directories made by an older version are tightened when next used', () => {
  const payload = (id: string): SharePayload => ({ localId: id, item: {} as never, shown: [], leftLocal: [], deferredPairs: [], hash: `h-${id}`, fullHash: `f-${id}` });
  const meta = { agentId: 'a', envName: 'prod', preview: 'p', to: { tenantId: 't', gatewayUrl: 'https://g' } };

  it('pending-shares', () => {
    vi.stubEnv('XDG_STATE_HOME', path.join(dir, 'state'));
    const d = path.join(dir, 'state', 'align-cli', 'pending-shares');
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o755);
    expect(issueCode([payload('x')], meta)).not.toBeNull();
    expect(mode(d)).toBe(0o700);
  });

  it('pending-requests', () => {
    vi.stubEnv('XDG_STATE_HOME', path.join(dir, 'state'));
    const d = path.join(dir, 'state', 'align-cli', 'pending-requests');
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o755);
    expect(loadRequest('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(mode(d)).toBe(0o700);
  });

  it('the advisory verdict store in the shared temp dir', () => {
    const p = adjudicationPayloadPath('abcdef0123456789');
    expect(p).not.toBeNull();
    const d = path.dirname(p!);
    chmodSync(d, 0o755);
    adjudicationPayloadPath('abcdef0123456789');
    expect(mode(d)).toBe(0o700);
  });
});

describe.skipIf(!posix)('the embedding model cache', () => {
  it('a fresh cache directory is 0700 and each cached file 0600, whatever the umask', async () => {
    const cacheDir = path.join(dir, 'cache', 'models');
    const old = process.umask(0o000);
    try {
      await modelFileCache(cacheDir).put('https://example.test/model.onnx', new Response('weights'));
    } finally {
      process.umask(old);
    }
    const files = readdirSync(cacheDir);
    expect(files.length).toBe(1);
    expect(mode(cacheDir)).toBe(0o700);
    expect(mode(path.join(cacheDir, files[0]!))).toBe(0o600);
  });
  it('a pre-existing 0755 cache directory is tightened on the next write', async () => {
    const cacheDir = path.join(dir, 'cache2');
    mkdirSync(cacheDir);
    chmodSync(cacheDir, 0o755);
    await modelFileCache(cacheDir).put('https://example.test/tokenizer.json', new Response('{}'));
    expect(mode(cacheDir)).toBe(0o700);
  });
});
