/** A real CLI process against a fake gateway on loopback, with a seeded local graph. Test-only. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../../lib/local-db.js';

export const ROOT = path.resolve(__dirname, '../../..');
export const canPty = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty']).status === 0;

export interface Harness {
  posts: Array<{ url: string; body: string }>;
  /**
   * The fake gateway's share-request routes (ALI-1540). `mode` null answers the config route 404, like an older gateway.
   * `states` is the status the next polls return, in order (the last one repeats). Calls to these routes are logged
   * in `requests`, NOT in `posts`, so "zero POSTs" assertions about /ingest/batch keep their meaning.
   */
  share: { mode: 'off' | 'available' | 'required' | null; states: string[]; staged: Array<{ id: string; body: Record<string, unknown> }> };
  requests: Array<{ method: string; url: string; body: string; auth: string | undefined }>;
  reply: { batch: (n: number) => unknown };
  team: { current: Record<string, unknown> };
  ids: string[];
  dir: string;
  env: Record<string, string | undefined>;
  base: string;
  /** Plain spawn, own session (no controlling terminal), stdin from /dev/null. */
  plain(args: string[], extraEnv?: Record<string, string>): Promise<{ code: number | null; out: string }>;
  /** A real pty: type `send` once `expect` appears. */
  pty(args: string[], steps: Array<[string, string]>): Promise<{ code: number; out: string }>;
  /** Like pty but for any align subcommand (args are the whole command line after `align`). */
  ptyAlign(args: string[], steps: Array<[string, string]>): Promise<{ code: number; out: string }>;
  dbPath: string;
  /** The product's own private state directory under the child's env (holds share-salt, pending-shares). */
  stateDir: string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Child sees the macOS layout: XDG_* unset, process.platform = darwin (a path-layout simulation only). */
  simulateMac?: boolean;
  /** TEST OF THE TEST: seed where Linux XDG would put the graph instead of asking the product. */
  seedAtXdgGuess?: boolean;
}

/** The scratch home and the env every child gets. HOME and USERPROFILE point at it so env-paths resolves inside it. */
export function childEnv(dir: string, opts: HarnessOptions = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: path.join(dir, 'state'), ALIGN_TELEMETRY: '0', DO_NOT_TRACK: '1' };
  if (opts.simulateMac) {
    delete env['XDG_CONFIG_HOME']; delete env['XDG_DATA_HOME'];
    env['NODE_OPTIONS'] = `${process.env['NODE_OPTIONS'] ?? ''} --require ${path.join(__dirname, 'fake-darwin.cjs')}`.trim();
  } else {
    env['XDG_CONFIG_HOME'] = path.join(dir, 'cfg'); env['XDG_DATA_HOME'] = path.join(dir, 'data');
  }
  return env;
}

/** Where the PRODUCT puts its graph, config and state under `env`: asked of the product, in a child, never guessed. */
export function productPaths(env: Record<string, string | undefined>): { dbPath: string; configDir: string; stateDir: string } {
  const r = spawnSync(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(__dirname, 'print-paths.ts')], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`print-paths failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!) as { dbPath: string; configDir: string; stateDir: string | null };
  if (!parsed.stateDir) throw new Error('the product has no private state directory under this env');
  return { dbPath: parsed.dbPath, configDir: parsed.configDir, stateDir: parsed.stateDir };
}

export async function startHarness(seed: (db: ReturnType<typeof createLocalDb>) => string[], opts: HarnessOptions = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-share-pty-'));
  const base0 = childEnv(dir, opts);
  const found = productPaths(base0);
  const cfg = opts.seedAtXdgGuess ? path.join(dir, 'cfg', 'align-cli') : found.configDir;
  fs.mkdirSync(cfg, { recursive: true });
  const dbPath = path.join(cfg, 'local.db');
  const db = createLocalDb(dbPath); const ids = seed(db); db.close();
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ environments: { local: { mode: 'local-embedded', localDbPath: dbPath } }, defaultEnv: 'prod' }));
  const h = { posts: [] as Harness['posts'], requests: [] as Harness['requests'], share: { mode: null, states: ['pending'], staged: [] } as Harness['share'], reply: { batch: (n: number): unknown => ({ snapshots: Array.from({ length: n }, (_, i) => ({ id: `R${i}`, request_index: i, is_new: true })) }) }, team: { current: { title: 'Team title', summary: 'Team summary', decision_json: {} } as Record<string, unknown> } };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/auth/me') return res.end(JSON.stringify({ user: { id: 'u', email: 'me@acme.test', role: 'org_admin' }, tenant: { id: 'T1', name: 'Acme' } }));
      if (req.url?.startsWith('/snapshots/')) return res.end(JSON.stringify(h.team.current));
      if (req.url?.startsWith('/share-requests')) {
        h.requests.push({ method: req.method ?? '', url: req.url, body, auth: req.headers.authorization });
        const url = req.url;
        if (url === '/share-requests/config') {
          if (h.share.mode === null) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
          return res.end(JSON.stringify({ mode: h.share.mode, pending_ttl_s: 900, complete_ttl_s: 600 }));
        }
        if (req.method === 'POST' && url === '/share-requests') {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          h.share.staged.push({ id: String(parsed['envelope_id']), body: parsed });
          res.statusCode = 201;
          const rowId = crypto.randomUUID();
          return res.end(JSON.stringify({ id: rowId, user_code: 'KJ4M-9XQT', expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), approve_path: `/share/approve/${rowId}` }));
        }
        if (req.method === 'GET') {
          const next = h.share.states.length > 1 ? h.share.states.shift()! : h.share.states[0]!;
          return res.end(JSON.stringify({ state: next }));
        }
        if (url.endsWith('/cancel')) return res.end('{}');
        if (url.endsWith('/complete')) {
          const n = (JSON.parse(Buffer.from((JSON.parse(body) as { payload_b64: string }).payload_b64, 'base64').toString('utf8')) as { decisions?: unknown[] }).decisions?.length ?? 0;
          return res.end(JSON.stringify(h.reply.batch(n)));
        }
        res.statusCode = 404; return res.end('{}');
      }
      h.posts.push({ url: req.url ?? '', body });
      const n = (JSON.parse(body || '{}') as { decisions?: unknown[] }).decisions?.length ?? 0;
      res.end(JSON.stringify(h.reply.batch(n)));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env: Record<string, string | undefined> = { ...base0, ALIGN_ENV: 'prod', ALIGN_TOKEN: 'tok', ALIGN_TENANT_ID: 'T1', ALIGN_GATEWAY_URL: base };
  const cmd = [path.join(ROOT, 'node_modules/.bin/tsx'), path.join(ROOT, 'src/index.ts'), 'share'];
  return {
    ...h, ids, dir, env, base, dbPath, stateDir: found.stateDir,
    ptyAlign: (args, steps) => new Promise((resolve) => {
      const p = spawn('python3', [path.join(__dirname, 'pty-run.py'), JSON.stringify([...cmd.slice(0, 2), ...args]), JSON.stringify(steps)], { env });
      let out = ''; p.stdout.on('data', (b) => (out += b));
      p.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop()!)));
    }),
    plain: (args, extraEnv) => new Promise((resolve) => {
      const p = spawn(cmd[0]!, [...cmd.slice(1), ...args], { detached: true, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; p.stdout!.on('data', (b) => (out += b)); p.stderr!.on('data', (b) => (out += b));
      p.on('close', (code) => resolve({ code, out }));
    }),
    pty: (args, steps) => new Promise((resolve) => {
      const p = spawn('python3', [path.join(__dirname, 'pty-run.py'), JSON.stringify([...cmd, ...args]), JSON.stringify(steps)], { env });
      let out = ''; p.stdout.on('data', (b) => (out += b));
      p.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop()!)));
    }),
    close: async () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
