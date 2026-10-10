import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { canPty, childEnv, productPaths, ROOT } from './helpers/share-harness.js';
import { LEAD_CONSENT_VERSION } from '../lib/lead-prompt.js';

/**
 * The real binary on a real pseudo-terminal, against a fake gateway on loopback, with no team login.
 * POSIX only, like share-pty.test.ts: the Windows console path is the same code behind ttyAsk's CONIN$ branch,
 * and the unit suite covers the rest. HOME and USERPROFILE point at a scratch directory and the product's own
 * path helpers say where its config lives. A preload refuses any non-loopback connection in the child.
 */
vi.setConfig({ testTimeout: 90_000 });
const ADDRESS = 'Pat.Unique@PtyLead.Example';
interface Rig { dir: string; base: string; leads: Array<{ url: string; body: string }>; other: string[]; reply: { status: number; location?: string }; configFile: string; stateDir: string; configDir: string; env: Record<string, string | undefined>; close: () => void }
let rig: Rig;

async function makeRig(): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-lead-pty-'));
  const env = childEnv(dir);
  for (const k of Object.keys(env)) if (/^(CI|GITHUB_.*|RUNNER_.*|BUILD_ID|BUILD_NUMBER|RUN_ID|CONTINUOUS_INTEGRATION|ALIGN_TOKEN|ALIGN_GATEWAY_URL|ALIGN_ENV|ALIGN_TENANT_ID|ALIGN_WRAPPED|ALIGN_NO_LEAD_PROMPT)$/.test(k)) delete env[k];
  const found = productPaths(env);
  fs.mkdirSync(found.configDir, { recursive: true });
  fs.writeFileSync(path.join(found.configDir, 'config.json'), JSON.stringify({ environments: { local: { mode: 'local-embedded', localDbPath: path.join(found.configDir, 'local.db') } }, defaultEnv: 'prod' }));
  const leads: Rig['leads'] = []; const other: string[] = []; const reply: Rig['reply'] = { status: 202 };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/leads/team-interest') {
        leads.push({ url: req.url, body });
        res.statusCode = reply.status; if (reply.location) res.setHeader('location', reply.location);
        return res.end('{"status":"pending_confirmation"}');
      }
      other.push(`${req.method} ${req.url}`); res.statusCode = 404; res.end('{}');
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const preload = path.join(__dirname, 'helpers', 'loopback-only.cjs');
  const rewrite = path.join(__dirname, 'helpers', 'hosted-rewrite.cjs');
  env['ALIGN_TEST_HOSTED_REWRITE'] = base; // the hosted URL is the default prod gateway; the child's fetch is sent to the loopback fake
  env['NODE_OPTIONS'] = `${process.env['NODE_OPTIONS'] ?? ''} --require ${preload} --require ${rewrite}`.trim();
  const configFile = path.join(found.configDir, 'config.json');
  return { dir, base, leads, other, reply, configFile, stateDir: found.stateDir, configDir: found.configDir, env, close: () => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function pty(steps: Array<[string, string]>, extra: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const cmd = [path.join(ROOT, 'node_modules/.bin/tsx'), path.join(ROOT, 'src/index.ts'), 'share', 'any-id'];
  return new Promise((resolve) => {
    const p = spawn('python3', [path.join(__dirname, 'helpers/pty-run.py'), JSON.stringify(cmd), JSON.stringify(steps)], { env: { ...rig.env, ...extra } });
    let out = ''; p.stdout.on('data', (b) => (out += b));
    p.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop()!)));
  });
}
function plain(extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'src/index.ts'), 'share', 'any-id'], { detached: true, env: { ...rig.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout!.on('data', (b) => (out += b)); p.stderr!.on('data', (b) => (out += b));
    p.on('close', (code) => resolve({ code, out }));
  });
}
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const config = (): Record<string, unknown> => JSON.parse(fs.readFileSync(rig.configFile, 'utf8')) as Record<string, unknown>;

beforeEach(async () => { rig = await makeRig(); });
afterEach(() => rig.close());

describe.skipIf(!canPty)('a person on a real terminal with no team login', () => {
  it('is offered the email, types an address, and the server sees the contract body while the disk sees only a timestamp', async () => {
    const r = await pty([['Work email', `${ADDRESS}\r`], ['confirmation email', '']]);
    expect(r.out).toContain('Bring this to your team. Book a 30-minute call');
    expect(r.out).toContain('Want an email when your team can join Align, or to set up a call?');
    expect(r.out).toContain('https://align.tech/privacy');
    expect(r.out).toContain('We sent a confirmation email to Pat.Unique@ptylead.example. Check your inbox.');
    expect(r.code).toBe(1); // the share itself still did not happen
    expect(rig.leads).toHaveLength(1);
    expect(rig.other).toEqual([]);
    const body = JSON.parse(rig.leads[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['cli_version', 'consent_version', 'email', 'os', 'source']);
    expect(body).toMatchObject({ email: 'Pat.Unique@ptylead.example', source: 'cli-share', consent_version: LEAD_CONSENT_VERSION });
    const c = config();
    expect(c['leadPromptOutcome']).toBe('submitted');
    expect(c['leadPromptVersion']).toBe(LEAD_CONSENT_VERSION);
    expect(Date.parse(String(c['leadEmailSubmittedAt']))).not.toBeNaN();
    const files = walk(rig.dir).filter((f) => !f.includes('node_modules'));
    expect(files.some((f) => f === rig.configFile)).toBe(true); // positive control: the scan covers the config file
    for (const f of files) {
      const text = fs.readFileSync(f, 'latin1').toLowerCase();
      expect(text, f).not.toContain('ptylead.example');
      expect(text, f).not.toContain('pat.unique');
    }
  });
  it('STATED LIMIT: a process on its own pseudo-terminal with no ALIGN_WRAPPED sees the prompt, exactly like a person (the server double opt-in is the backstop)', async () => {
    const r = await pty([['Work email', '\r']]);
    expect(r.out).toContain('Work email');
  });
  it('asks once: a second share from the same install does not prompt and sends nothing more', async () => {
    await pty([['Work email', `${ADDRESS}\r`], ['confirmation email', '']]);
    const again = await pty([]);
    expect(again.out).not.toContain('Work email');
    expect(again.out).toContain('Book a 30-minute call');
    expect(rig.leads).toHaveLength(1);
  });
  it('Enter skips, sends nothing, and is not asked again', async () => {
    const r = await pty([['Work email', '\r']]);
    expect(r.out).toContain('Work email');
    expect(rig.leads).toHaveLength(0);
    expect(config()['leadPromptOutcome']).toBe('skipped');
    expect(config()['leadEmailSubmittedAt']).toBeUndefined();
    expect((await pty([])).out).not.toContain('Work email');
  });
  it('a bad address gets one retry, and a second bad one skips', async () => {
    const r = await pty([['Work email', 'nope\r'], ['Try once more', ''], ['Work email (press Enter to skip): ', 'still nope\r']]);
    expect(r.out).toContain('That does not look like an email address');
    expect(rig.leads).toHaveLength(0);
    expect((await pty([])).out).not.toContain('Work email');
  });
  it('a redirect from the server is refused, nothing is marked, and the next share asks again', async () => {
    rig.reply.status = 307; rig.reply.location = `${rig.base}/elsewhere`;
    const r = await pty([['Work email', `${ADDRESS}\r`], ['nothing was sent', '']]);
    expect(r.out).toContain('Could not reach the server. Nothing was sent.');
    expect(rig.other).toEqual([]); // the redirect target was never requested
    expect(config()['leadEmailSubmittedAt']).toBeUndefined();
    expect(config()['leadPromptShownAt']).toBeUndefined();
    rig.reply.status = 202; delete rig.reply.location;
    const again = await pty([['Work email', '\r']]);
    expect(again.out).toContain('Work email');
  });
  it('ALIGN_WRAPPED, ALIGN_NO_LEAD_PROMPT and CI each suppress the prompt on a real terminal', async () => {
    for (const extra of [{ ALIGN_WRAPPED: '1' }, { ALIGN_NO_LEAD_PROMPT: '1' }, { CI: 'true' }]) {
      const r = await pty([], extra);
      expect(r.out, JSON.stringify(extra)).not.toContain('Work email');
      expect(r.out).toContain('Book a 30-minute call');
    }
    expect(rig.leads).toHaveLength(0);
    expect(config()['leadPromptShownAt']).toBeUndefined();
  });
});

describe.skipIf(!canPty)('a gateway that is not Align\'s hosted one', () => {
  it.each([['a loopback self-host', () => rig.base], ['a self-host name', () => 'https://align.corp.example']])('%s: no prompt, no request, nothing marked', async (_n, url) => {
    const r = await pty([], { ALIGN_GATEWAY_URL: url() });
    expect(r.out).toContain('Book a 30-minute call');
    expect(r.out).not.toContain('Work email');
    expect(rig.leads).toHaveLength(0);
    expect(config()['leadPromptShownAt']).toBeUndefined();
  });
});

describe.skipIf(!canPty)('with no terminal at all', () => {
  it('piped stdin and output never prompt, never send, and mark nothing', async () => {
    const r = await plain();
    expect(r.out).toContain('Book a 30-minute call');
    expect(r.out).not.toContain('Work email');
    expect(rig.leads).toHaveLength(0);
    expect(config()['leadPromptShownAt']).toBeUndefined();
  });
});

describe('the loopback-only preload', () => {
  it('refuses a non-loopback connection and allows loopback (positive control for every child above)', async () => {
    const preload = path.join(__dirname, 'helpers', 'loopback-only.cjs');
    const run = (host: string): Promise<string> => new Promise((resolve) => {
      const p = spawn(process.execPath, ['--require', preload, '-e', `require('node:net').connect({host:${JSON.stringify(host)},port:9}).on('error',()=>console.log('ERRORED')); console.log('CALLED')`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; p.stdout.on('data', (b) => (out += b)); p.stderr.on('data', (b) => (out += b));
      p.on('close', () => resolve(out));
    });
    expect(await run('192.0.2.1')).toContain('refused a connection to 192.0.2.1');
    expect(await run('127.0.0.1')).toContain('CALLED');
  });
});
