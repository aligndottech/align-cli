import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore, type LeadPromptOutcome, type LeadState } from '../lib/config.js';
import {
  LEAD_CONSENT_LINE, LEAD_CONSENT_VERSION, LEAD_INPUT_PROMPT, LEAD_QUESTION_LINE, leadBody, leadPromptDecision, maybeAskLead,
  normaliseEmail, postLead, PRIVACY_URL, type LeadDeps, type LeadGateInput, type LeadSendOutcome,
} from '../lib/lead-prompt.js';

/**
 * Test List, the work-email prompt at the share moment:
 * - Gate (pure decision table): a person at a terminal with no login and no earlier ask is asked; each of
 *   wrapped, CI, ALIGN_NO_LEAD_PROMPT, no terminal, has a login, already asked this version refuses, and a NEW
 *   consent version asks again.
 * - Flow: Enter and end of input are skipped and counted as asked; "no" is declined; a bad address gets ONE retry then
 *   skips; a good address is posted once and stored only as a timestamp; a failed send forgets the ask.
 * - Wire: the POST body is exactly the contract's fields; redirects are refused; 202/422/429/500/hang/huge body each
 *   map to one outcome.
 * - Disk: after a submit the address is in no file under the config or state directories.
 */
const person: LeadGateInput = { env: {}, tty: true, hasLogin: false, inCi: false, state: {} };
const asked = (over: Partial<LeadState> = {}): LeadState => ({ shownAt: '2026-10-10T10:00:00.000Z', version: LEAD_CONSENT_VERSION, outcome: 'skipped', ...over });

describe('who is asked (the decision table)', () => {
  it('asks a person at a terminal with no login who has not been asked', () => {
    expect(leadPromptDecision(person)).toBeNull();
  });
  it.each([
    ['piped or captured streams', { tty: false }, 'not-a-terminal'],
    ['an agent align launched (ALIGN_WRAPPED)', { env: { ALIGN_WRAPPED: '1' } }, 'wrapped'],
    ['CI', { inCi: true }, 'ci'],
    ['ALIGN_NO_LEAD_PROMPT', { env: { ALIGN_NO_LEAD_PROMPT: '1' } }, 'suppressed'],
    ['a team login', { hasLogin: true }, 'has-login'],
    ['already asked for this consent version', { state: asked() }, 'already-asked'],
  ] as Array<[string, Partial<LeadGateInput>, string]>)('never asks: %s', (_n, over, why) => {
    expect(leadPromptDecision({ ...person, ...over })).toBe(why);
  });
  it('asks again when the consent version changed since the last ask', () => {
    expect(leadPromptDecision({ ...person, state: asked({ version: '2026-01-older' }) })).toBeNull();
  });
  it('an empty ALIGN_WRAPPED or ALIGN_NO_LEAD_PROMPT does not count as set', () => {
    expect(leadPromptDecision({ ...person, env: { ALIGN_WRAPPED: '', ALIGN_NO_LEAD_PROMPT: '' } })).toBeNull();
  });
  it('ALIGN_NO_LEAD_PROMPT=0 still suppresses (any value is a choice not to be asked)', () => {
    expect(leadPromptDecision({ ...person, env: { ALIGN_NO_LEAD_PROMPT: '0' } })).toBe('suppressed');
  });
});

describe('the address check', () => {
  it.each([
    ['a@b.co', 'a@b.co'], ['  Dan@Acme.COM  ', 'Dan@acme.com'], ['first.last+tag@sub.example.org', 'first.last+tag@sub.example.org'],
  ])('accepts %j as %j (domain lowercased, local part kept)', (raw, want) => {
    expect(normaliseEmail(raw)).toBe(want);
  });
  it.each([
    [''], ['   '], ['plain'], ['a@b'], ['a@@b.co'], ['a@b@c.co'], ['@b.co'], ['a@.co'], ['a@b..co'], ['a@b.'], ['a b@c.co'], ['a@b.co\n'.replace('\n', '\u0007')],
    ['a@b.co‮'], ['a​@b.co'], ['a@b.co,c@d.co'], ['<a@b.co>'], ['a@b.co;x'], ['x'.repeat(65) + '@b.co'], [`a@${'x'.repeat(250)}.co`], ['a\u0000@b.co'], ['a @b.co'],
  ])('refuses %j', (raw) => {
    expect(normaliseEmail(raw)).toBeNull();
  });
  it('accepts exactly 254 characters and refuses 255', () => {
    const dom = `${'d'.repeat(63)}.${'d'.repeat(63)}.`;
    const ok = `${'l'.repeat(64)}@${dom}${'e'.repeat(254 - 64 - 1 - dom.length)}`;
    expect(ok.length).toBe(254);
    expect(normaliseEmail(ok)).toBe(ok);
    expect(normaliseEmail(`${ok}e`)).toBeNull();
  });
});

interface Fx { deps: LeadDeps; out: string[]; shown: string[]; questions: string[]; posts: string[]; state: LeadState & {}; calls: string[] }
function fixture(lines: Array<string | null>, send: LeadSendOutcome = { kind: 'accepted' }, over: Partial<LeadDeps> = {}): Fx {
  const f = { out: [] as string[], shown: [] as string[], questions: [] as string[], posts: [] as string[], calls: [] as string[], state: {} as LeadState };
  const queue = [...lines];
  const deps: LeadDeps = {
    store: {
      getLeadState: () => ({ ...f.state }),
      markLeadPromptShown: (v) => { f.calls.push('mark'); f.state = { ...f.state, shownAt: 'now', version: v, outcome: 'skipped' }; },
      setLeadOutcome: (o: LeadPromptOutcome) => { f.calls.push(`outcome:${o}`); f.state = { ...f.state, outcome: o, ...(o === 'submitted' ? { submittedAt: 'now' } : {}) }; },
      clearLeadPromptShown: () => { f.calls.push('clear'); f.state = { ...f.state, shownAt: undefined, version: undefined, outcome: undefined }; },
    },
    env: {}, hasLogin: false, inCi: false, tty: true,
    ask: async (shown, q, onShown) => { f.shown.push(shown); f.questions.push(q); if (queue.length === 0) return null; onShown(); return queue.shift()!; },
    post: async (e) => { f.posts.push(e); return send; },
    out: (l) => f.out.push(l),
    ...over,
  };
  return Object.assign(f, { deps });
}

describe('the prompt', () => {
  it('shows the question, then the consent line with the privacy URL, then asks for the address', async () => {
    const f = fixture(['']);
    await maybeAskLead(f.deps);
    expect(f.shown[0]).toBe(`${LEAD_QUESTION_LINE}\n${LEAD_CONSENT_LINE}`);
    expect(f.questions[0]).toBe(LEAD_INPUT_PROMPT);
    expect(LEAD_QUESTION_LINE).toBe('Want an email when your team can join Align, or to set up a call?');
    expect(LEAD_INPUT_PROMPT).toBe('Work email (press Enter to skip):');
    expect(LEAD_CONSENT_LINE).toBe(`We will store it to email you about team plans. One confirmation email, unsubscribe any time. Details: ${PRIVACY_URL}.`);
    expect(PRIVACY_URL).toBe('https://align.tech/privacy');
    expect(`${LEAD_QUESTION_LINE}${LEAD_CONSENT_LINE}${LEAD_INPUT_PROMPT}`).not.toMatch(/—/);
  });
  it('Enter is skipped, counts as asked, sends nothing; a second run does not ask', async () => {
    const f = fixture(['']);
    expect(await maybeAskLead(f.deps)).toBe('skipped');
    expect(f.state).toMatchObject({ outcome: 'skipped', version: LEAD_CONSENT_VERSION });
    expect(f.posts).toEqual([]);
    expect(await maybeAskLead(f.deps)).toBe('skipped-by-gate');
    expect(f.shown).toHaveLength(1);
  });
  it('end of input or Ctrl-C (an empty answer after the prompt was shown) counts as asked too', async () => {
    const f = fixture(['']);
    await maybeAskLead(f.deps);
    expect(f.calls[0]).toBe('mark');
  });
  it('typing no is declined, and is not asked again', async () => {
    const f = fixture(['no']);
    expect(await maybeAskLead(f.deps)).toBe('declined');
    expect(f.state.outcome).toBe('declined');
    expect(f.posts).toEqual([]);
    expect(await maybeAskLead(f.deps)).toBe('skipped-by-gate');
  });
  it('a new consent version asks again after a decline', async () => {
    const f = fixture(['n']);
    f.state = asked({ version: '2026-01-older', outcome: 'declined' });
    expect(await maybeAskLead(f.deps)).toBe('declined');
    expect(f.shown).toHaveLength(1);
  });
  it('a good address is posted once, lowercased in the domain, and echoed back once', async () => {
    const f = fixture(['  Dan@Acme.COM ']);
    expect(await maybeAskLead(f.deps)).toBe('submitted');
    expect(f.posts).toEqual(['Dan@acme.com']);
    expect(f.out).toEqual(['We sent a confirmation email to Dan@acme.com. Check your inbox.']);
    expect(f.state).toMatchObject({ outcome: 'submitted', submittedAt: 'now' });
  });
  it('a bad address gets one retry; a good second one is sent', async () => {
    const f = fixture(['not-an-email', 'ok@b.co']);
    expect(await maybeAskLead(f.deps)).toBe('submitted');
    expect(f.out[0]).toBe('That does not look like an email address. Try once more, or press Enter to skip.');
    expect(f.posts).toEqual(['ok@b.co']);
    expect(f.questions).toHaveLength(2);
  });
  it('two bad addresses skip: one retry only, nothing sent, and the bad text is never printed back', async () => {
    const f = fixture(['bad one', 'still bad']);
    expect(await maybeAskLead(f.deps)).toBe('skipped');
    expect(f.questions).toHaveLength(2);
    expect(f.posts).toEqual([]);
    expect(f.out.join('\n')).not.toMatch(/bad one|still bad/);
    expect(await maybeAskLead(f.deps)).toBe('skipped-by-gate');
  });
  it('a retry answered with Enter skips', async () => {
    const f = fixture(['bad', '']);
    expect(await maybeAskLead(f.deps)).toBe('skipped');
    expect(f.posts).toEqual([]);
  });
  it('no controlling terminal: nothing shown, nothing marked, so a later share can ask', async () => {
    const f = fixture([]);
    expect(await maybeAskLead(f.deps)).toBe('no-terminal');
    expect(f.calls).toEqual([]);
    expect(f.state.shownAt).toBeUndefined();
  });
  it('a failed send says nothing was sent and forgets the ask', async () => {
    const f = fixture(['a@b.co'], { kind: 'failed' });
    expect(await maybeAskLead(f.deps)).toBe('not-sent');
    expect(f.out).toEqual(['Could not reach the server; nothing was sent.']);
    expect(f.state.shownAt).toBeUndefined();
    expect(f.state.submittedAt).toBeUndefined();
    expect(await maybeAskLead({ ...f.deps, ask: async (_s, _q, on) => { on(); return ''; } })).toBe('skipped');
  });
  it('a rate-limited send says so, sent nothing as submitted, and forgets the ask', async () => {
    const f = fixture(['a@b.co'], { kind: 'rate-limited' });
    expect(await maybeAskLead(f.deps)).toBe('not-sent');
    expect(f.out[0]).toMatch(/Too many requests/);
    expect(f.state.outcome).toBeUndefined();
  });
  it('a 422 from the server is not stored as submitted, and counts as asked', async () => {
    const f = fixture(['a@b.co'], { kind: 'invalid' });
    expect(await maybeAskLead(f.deps)).toBe('skipped');
    expect(f.state.outcome).toBe('skipped');
    expect(f.state.submittedAt).toBeUndefined();
    expect(f.out[0]).toMatch(/did not accept/);
  });
  it.each([
    ['wrapped', { env: { ALIGN_WRAPPED: '1' } }], ['CI', { inCi: true }], ['no terminal streams', { tty: false }], ['a login', { hasLogin: true }],
    ['the opt-out env', { env: { ALIGN_NO_LEAD_PROMPT: '1' } }],
  ] as Array<[string, Partial<LeadDeps>]>)('%s: the terminal is never touched', async (_n, over) => {
    const f = fixture(['a@b.co'], { kind: 'accepted' }, over);
    expect(await maybeAskLead(f.deps)).toBe('skipped-by-gate');
    expect(f.shown).toEqual([]);
    expect(f.posts).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it('a store that throws costs the prompt, never the command', async () => {
    const f = fixture(['a@b.co'], { kind: 'accepted' }, { store: { getLeadState: () => { throw new Error('disk'); }, markLeadPromptShown: () => undefined, setLeadOutcome: () => undefined, clearLeadPromptShown: () => undefined } });
    await expect(maybeAskLead(f.deps)).resolves.toBe('skipped-by-gate');
    expect(f.posts).toEqual([]);
  });
});

describe('what goes over the wire', () => {
  let server: http.Server; let base: string;
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  let reply: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_q, r) => { r.statusCode = 202; r.end('{"status":"pending_confirmation"}'); };
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', () => { seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }); reply(req, res); });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.closeAllConnections(); server.close(); });
  beforeEach(() => { seen.length = 0; reply = (_q, r) => { r.statusCode = 202; r.end('{"status":"pending_confirmation"}'); }; });

  it('POSTs /leads/team-interest with exactly the contract fields and nothing else', async () => {
    expect(await postLead('a@b.co', base)).toEqual({ kind: 'accepted' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/leads/team-interest');
    expect(seen[0]!.headers['content-type']).toBe('application/json');
    expect(seen[0]!.headers['authorization']).toBeUndefined();
    expect(seen[0]!.headers['cookie']).toBeUndefined();
    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['cli_version', 'consent_version', 'email', 'os', 'source']);
    expect(body).toMatchObject({ email: 'a@b.co', source: 'cli-share', consent_version: LEAD_CONSENT_VERSION });
    expect(['darwin', 'linux', 'win32']).toContain(body['os']);
    expect(String(body['cli_version'])).toMatch(/^\d+\.\d+\.\d+/);
    for (const banned of [os.hostname(), os.homedir(), os.userInfo().username]) if (banned.length > 3) expect(seen[0]!.body).not.toContain(banned);
  });
  it('leaves os out on a platform the contract does not list', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    try { expect(Object.keys(leadBody('a@b.co'))).not.toContain('os'); } finally { Object.defineProperty(process, 'platform', real); }
  });
  it.each([[202, 'accepted'], [422, 'invalid'], [429, 'rate-limited'], [500, 'failed'], [404, 'failed'], [200, 'failed']])('status %i is %s', async (status, kind) => {
    reply = (_q, r) => { r.statusCode = status; r.end('{}'); };
    expect(await postLead('a@b.co', base)).toEqual({ kind });
  });
  it('refuses a redirect and never follows it', async () => {
    reply = (q, r) => { if (q.url === '/leads/team-interest') { r.statusCode = 307; r.setHeader('location', `${base}/elsewhere`); r.end(); } else { r.statusCode = 202; r.end('{}'); } };
    expect(await postLead('a@b.co', base)).toEqual({ kind: 'failed' });
    expect(seen.map((s) => s.url)).toEqual(['/leads/team-interest']);
  });
  it('gives up after the time cap on a server that never answers', async () => {
    reply = () => undefined;
    const t = Date.now();
    expect(await postLead('a@b.co', base, 150)).toEqual({ kind: 'failed' });
    expect(Date.now() - t).toBeLessThan(2000);
  });
  it('a network failure is a failed outcome, not a throw', async () => {
    expect(await postLead('a@b.co', 'http://127.0.0.1:1')).toEqual({ kind: 'failed' });
  });
  it('does not read an endless body: a huge answer still resolves from the status', async () => {
    reply = (_q, r) => { r.statusCode = 202; r.write('x'.repeat(10_000)); r.write('y'.repeat(10_000)); /* never ends */ };
    const t = Date.now();
    expect(await postLead('a@b.co', base, 3000)).toEqual({ kind: 'accepted' });
    expect(Date.now() - t).toBeLessThan(2500);
  });
});

describe('on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-lead-disk-'));
    for (const k of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA']) vi.stubEnv(k, path.join(dir, k));
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
  const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

  it('the config keeps a timestamp and an outcome, and the address is in no file anywhere', async () => {
    const config = createConfigStore();
    const ADDRESS = 'zed.unique.marker@lead-disk-test.example';
    const f = fixture([ADDRESS], { kind: 'accepted' }, { store: config });
    expect(await maybeAskLead(f.deps)).toBe('submitted');
    const s = config.getLeadState();
    expect(s.outcome).toBe('submitted');
    expect(s.version).toBe(LEAD_CONSENT_VERSION);
    expect(Date.parse(s.submittedAt ?? '')).not.toBeNaN();
    const files = walk(dir);
    // Positive control: the scan reaches the config file that holds the timestamp.
    const withTimestamp = files.filter((p) => fs.readFileSync(p, 'utf8').includes('leadEmailSubmittedAt'));
    expect(withTimestamp).toHaveLength(1);
    for (const p of files) {
      const text = fs.readFileSync(p, 'utf8');
      expect(text, p).not.toContain(ADDRESS);
      expect(text, p).not.toContain('lead-disk-test.example');
    }
  });
  it('a failed send leaves no trace that it asked, so the next share can ask', async () => {
    const config = createConfigStore();
    const f = fixture(['a@b.co'], { kind: 'failed' }, { store: config });
    await maybeAskLead(f.deps);
    expect(config.getLeadState()).toEqual({ shownAt: undefined, version: undefined, outcome: undefined, submittedAt: undefined });
  });
});

vi.setConfig({ testTimeout: 15_000 });
