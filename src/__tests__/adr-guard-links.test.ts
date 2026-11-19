/**
 * ADR Guard's replacements, recorded in a local graph. The ADRs are rows `align connect docs`
 * already wrote (platform docs, keyed by the file's blob URL); the export names them by path.
 *
 * Test List:
 * 1. a replacement is recorded as a person marking "newer replaces older": one judgement, one edge
 * 2. the ADRs are found on another branch than the one being read now, by their path
 * 3. a path matching no ADR row, or a docs section of another file, is counted unmatched
 * 4. idempotent
 * 5. no terminal, nothing written
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { createLocalDb } from '../lib/local-db.js';
import { confirmAdrGuardLinks } from '../lib/adr-guard-links.js';
import { rmDir } from './helpers/rm-dir.js';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

const JUDGE = { judgeId: 'install-1', judgeLabel: 'me@example.com' };
const WEB = 'https://github.com/acme/api';
const OLD = 'docs/adr/0001-legacy-storage.md';
const NEW = 'docs/adr/0002-managed-storage.md';
const urlFor = (p: string) => `${WEB}/blob/main/${p}`;

let dir: string;
let dbPath: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-adrguard-')); dbPath = path.join(dir, 'graph.db'); });
afterEach(() => rmDir(dir));

async function importDocs(rows: Array<{ url: string; title: string }>) {
  const c = createLocalGatewayClient(dbPath);
  try {
    await c.ingestBatch(rows.map((r) => ({ source_url: r.url, platform: 'docs', title: r.title, raw_text: `# ${r.title}\n\nWe decided this for a reason.` })) as never, { classify: false });
  } finally { c.close(); }
}
function q<T>(sql: string, ...args: string[]): T[] {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
}
const idOf = (url: string) => q<{ id: string }>('SELECT id FROM decisions WHERE source_url = ?', url)[0]!.id;

describe('confirmAdrGuardLinks', () => {
  it('records a replacement as a person marking "newer replaces older"', async () => {
    await importDocs([{ url: urlFor(OLD), title: 'Use legacy storage' }, { url: urlFor(NEW), title: 'Use managed storage' }]);
    const out = confirmAdrGuardLinks(dbPath, [{ newer: NEW, older: OLD }], urlFor, { judge: JUDGE, terminal: true });
    expect(out).toMatchObject({ confirmed: 1, unmatched: 0, refused: 0, needsTerminal: false });
    const edges = q<{ source_id: string; target_id: string; confidence: number }>("SELECT * FROM decision_links WHERE relation = 'supersedes'");
    expect(edges).toEqual([expect.objectContaining({ source_id: idOf(urlFor(NEW)), target_id: idOf(urlFor(OLD)), confidence: 1 })]);
    expect(q<{ kind: string }>('SELECT kind FROM local_judgements')).toEqual([{ kind: 'supersede' }]);
    const local = createLocalDb(dbPath);
    try { expect(local.isSuperseded(idOf(urlFor(OLD)))).toBe(true); expect(local.isSuperseded(idOf(urlFor(NEW)))).toBe(false); } finally { local.close(); }
  });

  it('finds ADRs imported from another branch of this repository by their path', async () => {
    const onBranch = (p: string) => `${WEB}/blob/feature/storage/${p}`;
    await importDocs([{ url: onBranch(OLD), title: 'Use legacy storage' }, { url: onBranch(NEW), title: 'Use managed storage' }]);
    const out = confirmAdrGuardLinks(dbPath, [{ newer: NEW, older: OLD }], urlFor, { judge: JUDGE, terminal: true, branches: new Set(['main', 'feature/storage']) });
    expect(out).toMatchObject({ confirmed: 1, unmatched: 0 });
  });

  // `.../blob/main/x/docs/adr/0001.md` ends in `/docs/adr/0001.md` too: a copy in a subfolder, not the ADR.
  // Read as branch "main/x", it is refused because no such branch exists.
  it('does not take a file in a subfolder that ends in the same path', async () => {
    const sub = (p: string) => `${WEB}/blob/main/vendor/${p}`;
    await importDocs([{ url: sub(OLD), title: 'Vendored legacy storage' }, { url: sub(NEW), title: 'Vendored managed storage' }]);
    const out = confirmAdrGuardLinks(dbPath, [{ newer: NEW, older: OLD }], (p) => `${WEB}/blob/feature/other/${p}`, { judge: JUDGE, terminal: true, branches: new Set(['main', 'feature/other']) });
    expect(out).toMatchObject({ confirmed: 0, unmatched: 1 });
  });

  it('counts a path with no ADR row as unmatched, and does not take a section of another file', async () => {
    await importDocs([
      { url: urlFor(NEW), title: 'Use managed storage' },
      // A CLAUDE.md section is a docs row too, and its URL ends in an anchor, never in an ADR path.
      { url: `${WEB}/blob/main/CLAUDE.md#legacy-storage`, title: 'Legacy storage' },
    ]);
    const out = confirmAdrGuardLinks(dbPath, [{ newer: NEW, older: OLD }, { newer: 'docs/adr/0009-nope.md', older: NEW }], urlFor, { judge: JUDGE, terminal: true });
    expect(out).toMatchObject({ confirmed: 0, unmatched: 2 });
    expect(q("SELECT 1 FROM decision_links WHERE relation = 'supersedes'")).toHaveLength(0);
  });

  // With no remote, a URL is git://blob/<branch>/<path> and names no repository, so the same path in
  // another repo's graph rows would look like this one on another branch. Only an exact match counts.
  it('without a remote, matches the exact URL only, never another branch', async () => {
    const local = (branch: string) => (p: string) => `git://blob/${branch}/${p}`;
    await importDocs([{ url: local('other')(OLD), title: 'Use legacy storage' }, { url: local('other')(NEW), title: 'Use managed storage' }]);
    expect(confirmAdrGuardLinks(dbPath, [{ newer: NEW, older: OLD }], local('main'), { judge: JUDGE, terminal: true })).toMatchObject({ confirmed: 0, unmatched: 1 });
    // Control: the same rows on the branch being read are found.
    expect(confirmAdrGuardLinks(dbPath, [{ newer: NEW, older: OLD }], local('other'), { judge: JUDGE, terminal: true })).toMatchObject({ confirmed: 1, unmatched: 0 });
  });

  it('is idempotent', async () => {
    await importDocs([{ url: urlFor(OLD), title: 'Use legacy storage' }, { url: urlFor(NEW), title: 'Use managed storage' }]);
    confirmAdrGuardLinks(dbPath, [{ newer: NEW, older: OLD }], urlFor, { judge: JUDGE, terminal: true });
    confirmAdrGuardLinks(dbPath, [{ newer: NEW, older: OLD }], urlFor, { judge: JUDGE, terminal: true });
    expect(q("SELECT 1 FROM decision_links WHERE relation = 'supersedes'")).toHaveLength(1);
    expect(q('SELECT 1 FROM local_judgements')).toHaveLength(1);
  });

  it('writes nothing without a terminal and says so', async () => {
    await importDocs([{ url: urlFor(OLD), title: 'Use legacy storage' }, { url: urlFor(NEW), title: 'Use managed storage' }]);
    const out = confirmAdrGuardLinks(dbPath, [{ newer: NEW, older: OLD }], urlFor, { judge: JUDGE, terminal: false });
    expect(out).toMatchObject({ confirmed: 0, needsTerminal: true });
    expect(q('SELECT 1 FROM local_judgements')).toHaveLength(0);
  });
});
