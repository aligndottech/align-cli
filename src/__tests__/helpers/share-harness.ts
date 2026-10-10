/** A real CLI process against a fake gateway on loopback, with a seeded local graph. Test-only. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../../lib/local-db.js';

export const ROOT = path.resolve(__dirname, '../../..');
export const canPty = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty']).status === 0;

export interface Harness {
  posts: Array<{ url: string; body: string }>;
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
  close(): Promise<void>;
}

export async function startHarness(seed: (db: ReturnType<typeof createLocalDb>) => string[]): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-share-pty-'));
  const cfg = path.join(dir, 'cfg', 'align-cli');
  fs.mkdirSync(cfg, { recursive: true });
  const dbPath = path.join(cfg, 'local.db');
  const db = createLocalDb(dbPath); const ids = seed(db); db.close();
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ environments: { local: { mode: 'local-embedded', localDbPath: dbPath } }, defaultEnv: 'prod' }));
  const h = { posts: [] as Harness['posts'], reply: { batch: (n: number): unknown => ({ snapshots: Array.from({ length: n }, (_, i) => ({ id: `R${i}`, request_index: i, is_new: true })) }) }, team: { current: { title: 'Team title', summary: 'Team summary', decision_json: {} } as Record<string, unknown> } };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/auth/me') return res.end(JSON.stringify({ user: { id: 'u', email: 'me@acme.test', role: 'org_admin' }, tenant: { id: 'T1', name: 'Acme' } }));
      if (req.url?.startsWith('/snapshots/')) return res.end(JSON.stringify(h.team.current));
      h.posts.push({ url: req.url ?? '', body });
      const n = (JSON.parse(body || '{}') as { decisions?: unknown[] }).decisions?.length ?? 0;
      res.end(JSON.stringify(h.reply.batch(n)));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'cfg'), XDG_STATE_HOME: path.join(dir, 'state'), HOME: dir, ALIGN_ENV: 'prod', ALIGN_TOKEN: 'tok', ALIGN_TENANT_ID: 'T1', ALIGN_GATEWAY_URL: base, ALIGN_TELEMETRY: '0', DO_NOT_TRACK: '1' };
  const cmd = [path.join(ROOT, 'node_modules/.bin/tsx'), path.join(ROOT, 'src/index.ts'), 'share'];
  return {
    ...h, ids, dir, env, base, dbPath,
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
