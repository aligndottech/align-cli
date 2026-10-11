import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
// The embed call records what it was asked to embed: the vector must not be built from a raw secret either.
const embedded: string[] = [];
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async (t: string) => { embedded.push(t); return new Float32Array(384).fill(0.1); }),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { dispatchTool } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';
import { applyJudgement } from '../lib/curation/mark.js';
import { takeRedactionNotice } from '../lib/redaction-notice.js';
import { rmDir } from './helpers/rm-dir.js';

// Fixtures are assembled from pieces so no literal credential shape sits in this file. Never edit .gitleaks.toml.
const fx = (...parts: string[]): string => parts.join('');
const GH = fx('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const SK = fx('sk', '_live_', 'Ab12Cd34Ef56Gh78Ij90');
const PEM_BODY = fx('MIIEow', 'IBAAKCAQEA7xQ');
const PEM = fx('-----BEGIN ', 'RSA PRIVATE', ' KEY-----\n', PEM_BODY, '\n-----END ', 'RSA PRIVATE', ' KEY-----');
const URL_SECRET = fx('a8Kd92', 'jfLq0Zx7Pw');
const RAWS = [GH, SK, PEM_BODY, URL_SECRET];

let dir: string;
let dbPath: string;
let client: ReturnType<typeof createLocalGatewayClient>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-redact-'));
  dbPath = path.join(dir, 'local.db');
  client = createLocalGatewayClient(dbPath);
  embedded.length = 0;
  takeRedactionNotice(); // a clean run counter for each test
});
afterEach(() => {
  client.close();
  rmDir(dir);
});

/** Every text column of the graph, so an assertion covers wherever ingest might have put the text. */
function allStoredText(): string {
  const db = new DatabaseSync(dbPath);
  try {
    const d = db.prepare('SELECT title, summary, COALESCE(source_url, \'\') AS u FROM decisions').all() as Array<Record<string, string>>;
    const j = db.prepare('SELECT COALESCE(note, \'\') AS note FROM local_judgements').all() as Array<Record<string, string>>;
    return [...d.flatMap((r) => [r['title'], r['summary'], r['u']]), ...j.map((r) => r['note'])].join('\n');
  } finally {
    db.close();
  }
}
/** The raw bytes of the database and its WAL: a secret must not be there in any form SQLite wrote. */
function fileBytes(): string {
  return ['', '-wal'].map((s) => (fs.existsSync(`${dbPath}${s}`) ? fs.readFileSync(`${dbPath}${s}`).toString('latin1') : '')).join('');
}
const noRawSecret = (): void => {
  const text = allStoredText();
  const bytes = fileBytes();
  for (const raw of RAWS) {
    expect(text).not.toContain(raw);
    expect(bytes).not.toContain(raw);
  }
  for (const e of embedded) for (const raw of RAWS) expect(e).not.toContain(raw);
};

describe('local capture never stores a raw secret', () => {
  it('align capture (captureDecision): the token becomes its placeholder and the result says how many', async () => {
    const r = await client.captureDecision(`Rotate ${GH} after the incident`);
    expect(r.summary).toBe('Rotate <GITHUB_TOKEN> after the incident');
    expect(r.title).toBe('Rotate <GITHUB_TOKEN> after the incident');
    expect(r.secretsRedacted).toBe(1);
    // Positive control: the row really landed, so the absence checks below are not vacuous.
    expect(allStoredText()).toContain('<GITHUB_TOKEN>');
    noRawSecret();
  });

  it('a capture with no secret stores the text unchanged and reports nothing', async () => {
    const r = await client.captureDecision('We chose Postgres over MySQL');
    expect(r.summary).toBe('We chose Postgres over MySQL');
    expect(r.secretsRedacted).toBeUndefined();
    expect(takeRedactionNotice()).toBeNull();
  });
});

describe('every import path (ingestBatch: git, github, jira, confluence, notion, linear, docs, sync) redacts before the write', () => {
  it('title, body and source URL are each redacted; the run counter sums them', async () => {
    await client.ingestBatch([
      { raw_text: `Deploy key:\n${PEM}\nkept in the runbook`, title: `Use ${SK} for billing`, source_url: fx('https://example.com/doc/1?to', 'ken=', URL_SECRET), platform: 'confluence' },
      { raw_text: `old token ${GH}`, title: 'Rotate the CI token', source_url: 'https://github.com/a/b/pull/2', platform: 'github' },
    ], { classify: false, keyed: true });
    const text = allStoredText();
    expect(text).toContain('<PRIVATE_KEY>');
    expect(text).toContain('<STRIPE_KEY>');
    expect(text).toContain('<URL_SECRET_PARAM>');
    expect(text).toContain('<GITHUB_TOKEN>');
    noRawSecret();
    expect(takeRedactionNotice()).toMatch(/\b4 secrets\b/);
  });

  it('the notice is given once per run: a second read is empty until something new is redacted', async () => {
    await client.ingestBatch([{ raw_text: `x ${GH}`, title: 't', platform: 'git' }]);
    expect(takeRedactionNotice()).toMatch(/\b1 secret\b/);
    expect(takeRedactionNotice()).toBeNull();
  });
});

describe('the session importer (confirmSessionDecision) redacts', () => {
  it('stores the placeholder, never the token', async () => {
    await client.confirmSessionDecision({ source_url: 'session://abc/1', raw_text: `the agent pasted ${GH} into the plan`, title: `Plan ${SK}` }, 'me');
    expect(allStoredText()).toContain('<GITHUB_TOKEN>');
    expect(allStoredText()).toContain('<STRIPE_KEY>');
    noRawSecret();
  });
});

describe('MCP align_capture redacts and tells the agent how many', () => {
  const local: EnvironmentConfig = { gatewayUrl: '', authToken: null, tenantId: null, mode: 'local-embedded' };
  it('returns secretsRedacted and stores only the placeholder', async () => {
    const r = await dispatchTool('align_capture', { input: `We moved off ${SK}` }, client as never, local) as { secretsRedacted?: number; summary: string };
    expect(r.secretsRedacted).toBe(1);
    expect(r.summary).toBe('We moved off <STRIPE_KEY>');
    noRawSecret();
  });
});

describe('align mark notes are redacted before they are stored', () => {
  it('the note holds the placeholder and the outcome says one secret was replaced', async () => {
    const { id } = await client.captureDecision('We chose Postgres');
    const out = applyJudgement({ dbPath, judge: { judgeId: 'me', judgeLabel: null }, origin: { via: 'cli' } }, { action: 'note', id, text: `ask ops, key ${GH}` });
    expect(allStoredText()).toContain('ask ops, key <GITHUB_TOKEN>');
    expect(out.text).toMatch(/1 secret was replaced with a placeholder/);
    noRawSecret();
  });
  it('a note with no secret says nothing about secrets', async () => {
    const { id } = await client.captureDecision('We chose Postgres');
    const out = applyJudgement({ dbPath, judge: { judgeId: 'me', judgeLabel: null }, origin: { via: 'cli' } }, { action: 'note', id, text: 'ask ops first' });
    expect(out.text).not.toMatch(/secret/);
  });
});
