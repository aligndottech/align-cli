/**
 * Test-only: the REAL `align join` (tsx, real readline, real loopback callback server, real `open`) on a real pty, against a fake
 * gateway on 127.0.0.1. The browser is a script named in $BROWSER (the bundled xdg-open honours it) that does what the join page
 * does: reads cli_port, cli_nonce and cli_gw out of the URL and POSTs a token to the loopback. Nothing here injects a prompt:
 * the answers are typed at the terminal, which is the point (a join test that fakes the prompt cannot see a broken prompt).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { childEnv, productPaths, ROOT } from './share-harness.js';

export const TOKEN = 'ab'.repeat(32);
export const MINTED = ['algt', 'e'.repeat(40)].join('_');

const FAKE_BROWSER = `#!/usr/bin/env python3
import json, os, sys, urllib.parse as u, urllib.request as r, threading, time
url = sys.argv[1]
q = u.parse_qs(u.urlparse(url).query)
log = os.environ['FAKE_BROWSER_LOG']
open(log, 'a').write(url + '\\n')
body = json.dumps({'token': os.environ['FAKE_BROWSER_TOKEN'], 'cli_nonce': q['cli_nonce'][0], 'expires_at': '2027-01-08T00:00:00.000Z'}).encode()
def post():
    time.sleep(0.3)
    req = r.Request('http://127.0.0.1:%s/callback' % q['cli_port'][0], data=body, headers={'content-type': 'text/plain;charset=UTF-8'})
    try: r.urlopen(req, timeout=5).read()
    except Exception as e: open(log, 'a').write('POST FAILED %s\\n' % e)
t = threading.Thread(target=post); t.start(); t.join()
`;

export interface JoinPtyHarness {
  base: string;
  host: string;
  link: string;
  dir: string;
  configFile: string;
  opened: () => string[];
  requests: Array<{ url: string; auth: string | undefined }>;
  /** The saved config, parsed. */
  config: () => { environments?: Record<string, Record<string, unknown>>; shareDestination?: string };
  seedConfig: (c: Record<string, unknown>) => void;
  pty: (args: string[], steps: Array<[string, string]>, extraEnv?: Record<string, string>) => Promise<{ code: number; out: string }>;
  plain: (args: string[], extraEnv?: Record<string, string>) => Promise<{ code: number | null; out: string }>;
  close: () => Promise<void>;
}

export async function startJoinHarness(): Promise<JoinPtyHarness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-join-pty-'));
  const env0 = childEnv(dir);
  delete env0['ALIGN_WRAPPED'];
  const found = productPaths(env0);
  fs.mkdirSync(found.configDir, { recursive: true });
  const configFile = path.join(found.configDir, 'config.json');
  const browser = path.join(dir, 'fake-browser.py');
  fs.writeFileSync(browser, FAKE_BROWSER, { mode: 0o755 });
  const log = path.join(dir, 'browser.log');
  const requests: JoinPtyHarness['requests'] = [];
  let base = '';
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/auth/invite-peek')) return void res.end(JSON.stringify({ org_name: 'Pty Org', has_email_restriction: false, app_url: base, gateway_url: base }));
    if (req.url === '/auth/me') return void res.end(JSON.stringify({ user: { id: 'u1', email: 'dev@pty.example', role: 'member' }, tenant: { id: 'tenant-pty', name: 'Pty Org' } }));
    res.statusCode = 404; res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env: Record<string, string | undefined> = { ...env0, BROWSER: browser, FAKE_BROWSER_LOG: log, FAKE_BROWSER_TOKEN: MINTED, ALIGN_ENV: undefined, ALIGN_TOKEN: undefined, ALIGN_GATEWAY_URL: undefined, ALIGN_TENANT_ID: undefined };
  // The bundled xdg-open hands the URL to the desktop when it detects one; with none it uses $BROWSER, which is our fake page.
  for (const k of ['XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'DESKTOP_SESSION', 'GNOME_DESKTOP_SESSION_ID', 'KDE_FULL_SESSION', 'MATE_DESKTOP_SESSION_ID', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) env[k] = undefined;
  // xdg-open also asks the session bus whether GNOME is running; no bus, so it cannot hand the URL to a real browser.
  env['DBUS_SESSION_BUS_ADDRESS'] = 'disabled:';
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const cmd = [path.join(ROOT, 'node_modules/.bin/tsx'), path.join(ROOT, 'src/index.ts'), 'join'];
  const host = new URL(base).host;
  return {
    base, host, dir, configFile, requests,
    link: `${base}/join?token=${TOKEN}&gw=${encodeURIComponent(base)}`,
    opened: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    config: () => (fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {}),
    seedConfig: (c) => fs.writeFileSync(configFile, JSON.stringify(c)),
    pty: (args, steps, extraEnv) => new Promise((resolve) => {
      const p = spawn('python3', [path.join(__dirname, 'pty-run.py'), JSON.stringify([...cmd, ...args]), JSON.stringify(steps)], { env: { ...env, ...extraEnv } });
      let out = ''; p.stdout.on('data', (b) => (out += b));
      p.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop()!)));
    }),
    plain: (args, extraEnv) => new Promise((resolve) => {
      const p = spawn(cmd[0]!, [...cmd.slice(1), ...args], { detached: true, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; p.stdout!.on('data', (b) => (out += b)); p.stderr!.on('data', (b) => (out += b));
      p.on('close', (code) => resolve({ code, out }));
    }),
    close: async () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
