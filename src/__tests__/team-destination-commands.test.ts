import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createConfigStore } from '../lib/config.js';

/**
 * Join plan C6: the commands that used to assume prod|preview|local. Real config store over a conf stand-in,
 * real commander registration, no network.
 */
// One store that outlives each createConfigStore() call, like the file the real conf reads: a command builds its own store.
const disk = vi.hoisted(() => ({ store: {} as Record<string, unknown>, seed: undefined as Record<string, unknown> | undefined }));
vi.mock('conf', () => ({
  default: class {
    private defaults: Record<string, unknown>;
    constructor(opts: { defaults?: Record<string, unknown> }) {
      this.defaults = opts.defaults ?? {};
      for (const [k, v] of Object.entries(this.defaults)) if (!(k in disk.store)) disk.store[k] = v;
      if (disk.seed) disk.store['environments'] = disk.seed;
    }
    get(k: string) { return disk.store[k]; }
    set(k: string, v: unknown) { disk.store[k] = v; }
    has(k: string) { return k in disk.store; }
    delete(k: string) { delete disk.store[k]; }
    clear() { disk.store = { ...this.defaults }; }
  },
}));
vi.mock('../lib/read-value-rollup.js', () => ({ readValueRollup: vi.fn(async () => ({ mode: 'cloud', rollup: {} })) }));
vi.mock('../lib/value-rollup.js', () => ({ renderValueReadout: () => 'READOUT' }));
vi.mock('ora', () => ({ default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn() })) }));

import { registerEnvCommand } from '../commands/env.js';
import { registerLoginCommands } from '../commands/login.js';
import { registerStatusCommand } from '../commands/status.js';

const PROD = ['al', 'prod', 'tok'].join('_');
const ACME_TOKEN = ['al', 'acme', 'tok'].join('_');
const ACME = { gatewayUrl: 'https://api.acme.example', appUrl: 'https://align.acme.example', authToken: ACME_TOKEN, tenantId: 'T-acme', orgNameClaimed: 'Acme' };

const lines: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`process.exit(${c})`); }) as never);

async function run(register: (p: Command) => void, args: string[]): Promise<void> {
  lines.length = 0;
  const program = new Command();
  program.exitOverride();
  register(program);
  try { await program.parseAsync(['node', 'align', ...args]); } catch (e) { if (!/process\.exit/.test((e as Error).message)) throw e; }
}

function fresh() {
  const c = createConfigStore();
  c.setAuthToken('prod', PROD);
  c.saveTeamDestination('acme', ACME);
  c.saveTeamDestination('beta', { ...ACME, gatewayUrl: 'https://api.beta.example', appUrl: 'https://align.beta.example', authToken: ['al', 'beta'].join('_') });
  c.setShareDestination('acme');
  return c;
}

beforeEach(() => {
  disk.store = {};
  disk.seed = undefined;
  for (const k of ['ALIGN_ENV', 'ALIGN_TOKEN', 'ALIGN_TENANT_ID', 'ALIGN_GATEWAY_URL']) vi.stubEnv(k, '');
});
afterEach(() => vi.unstubAllEnvs());

describe('align logout --env <destination>', () => {
  it('clears that destination\'s token only: prod, the other destination and the destination itself survive', async () => {
    fresh();
    await run(registerLoginCommands, ['logout', '--env', 'acme']);
    const c = createConfigStore();
    expect(c.getEnvironment('prod').authToken).toBe(PROD);
    expect(c.getEnvironment('beta').authToken).toBe(['al', 'beta'].join('_'));
    expect(c.getEnvironment('acme').authToken).toBeNull();
    expect(c.hasTeamDestination('acme')).toBe(true);
    expect(c.getEnvironment('acme').gatewayUrl).toBe('https://api.acme.example');
    expect(lines.join('\n')).toContain('Logged out of acme');
  });

  it('logout of prod leaves a team destination alone', async () => {
    fresh();
    await run(registerLoginCommands, ['logout', '--env', 'prod']);
    const c = createConfigStore();
    expect(c.getEnvironment('prod').authToken).toBeNull();
    expect(c.getEnvironment('acme').authToken).toBe(ACME_TOKEN);
  });

  it('an unknown name fails closed and touches nothing', async () => {
    fresh();
    await run(registerLoginCommands, ['logout', '--env', 'acmee']).catch(() => undefined);
    const c = createConfigStore();
    expect(c.getEnvironment('prod').authToken).toBe(PROD);
    expect(c.getEnvironment('acme').authToken).toBe(ACME_TOKEN);
  });
});

describe('align login --env <destination> --token', () => {
  it('without a terminal it is refused and the token is unchanged (second review N2)', async () => {
    fresh();
    await run(registerLoginCommands, ['login', '--env', 'acme', '--token', ['al', 'renewed', 'tok'].join('_')]);
    const c = createConfigStore();
    expect(c.getEnvironment('acme').authToken).toBe(ACME_TOKEN);
    expect(lines.join('\n')).toMatch(/terminal/);
  });

  it('at a terminal, a token the destination verifies is saved with its tenant, and prod is untouched', async () => {
    fresh();
    const renewed = ['al', 'renewed', 'tok'].join('_');
    const ttyIn = process.stdin.isTTY; const ttyOut = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: { email: 'a@acme.example' }, tenant: { id: 'T-renewed', name: 'Acme' } }), { status: 200 })));
    try {
      await run(registerLoginCommands, ['login', '--env', 'acme', '--token', renewed]);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: ttyIn, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: ttyOut, configurable: true });
      vi.unstubAllGlobals();
    }
    const c = createConfigStore();
    expect(c.getEnvironment('acme')).toMatchObject({ authToken: renewed, tenantId: 'T-renewed', gatewayUrl: 'https://api.acme.example', kind: 'team' });
    expect(c.getEnvironment('prod').authToken).toBe(PROD);
  });
});

describe('align env list', () => {
  it('names every destination with both hosts, and marks the share destination', async () => {
    fresh();
    await run(registerEnvCommand, ['env', 'list']);
    const text = lines.join('\n');
    expect(text).toMatch(/acme .*api\.acme\.example.*align\.acme\.example/);
    expect(text).toMatch(/beta .*api\.beta\.example.*align\.beta\.example/);
    expect(text).toMatch(/acme.*share destination/);
    expect(text).not.toMatch(/beta.*share destination/);
    expect(text).toContain('prod');
    expect(text).not.toContain(ACME_TOKEN);
  });

  it('with no destinations it lists only the builtins', async () => {
    await run(registerEnvCommand, ['env', 'list']);
    expect(lines.join('\n')).not.toContain('share destination');
  });

  it('a punycode destination host is shown in its raw form with the decoded form beside it', async () => {
    const c = createConfigStore();
    c.saveTeamDestination('idn', { ...ACME, gatewayUrl: 'https://xn--pple-43d.example' });
    await run(registerEnvCommand, ['env', 'list']);
    expect(lines.join('\n')).toContain('xn--pple-43d.example (shown as аpple.example)');
  });
});

describe('align status lists the destinations', () => {
  it('prints them under the readout when there are any, with both hosts', async () => {
    fresh();
    await run(registerStatusCommand, ['status']);
    const text = lines.join('\n');
    expect(text).toContain('READOUT');
    expect(text).toMatch(/acme .*api\.acme\.example.*align\.acme\.example/);
  });
  it('prints nothing extra when there are none', async () => {
    createConfigStore().setAuthToken('prod', PROD);
    await run(registerStatusCommand, ['status']);
    expect(lines.join('\n')).not.toContain('Team destinations');
  });
});

describe('a destination the transport rule refuses does not break the listing', () => {
  it('env list names it as unreadable and still lists the others', async () => {
    disk.seed = {
      evil: { kind: 'team', gatewayUrl: 'http://api.evil.example', appUrl: 'https://align.evil.example', authToken: 'x', mode: 'auth' },
      ok: { kind: 'team', gatewayUrl: 'https://api.acme.example', appUrl: 'https://align.acme.example', authToken: 'x', mode: 'auth' },
    };
    await run(registerEnvCommand, ['env', 'list']);
    const text = lines.join('\n');
    expect(text).toMatch(/evil .*unreadable.*https/);
    expect(text).toMatch(/ok .*api\.acme\.example/);
  });
});

describe('a hand-edited config cannot smuggle a hostile name into a command line', () => {
  it('a destination key that is not a valid name is not a destination', () => {
    disk.seed = {
      'a;b': { kind: 'team', gatewayUrl: 'https://api.acme.example', appUrl: 'https://align.acme.example', authToken: 'x', mode: 'auth' },
      ok: { kind: 'team', gatewayUrl: 'https://api.acme.example', appUrl: 'https://align.acme.example', authToken: 'x', mode: 'auth' },
    };
    const c = createConfigStore();
    expect(c.hasTeamDestination('a;b')).toBe(false);
    expect(c.hasTeamDestination('ok')).toBe(true);
    expect(c.listTeamDestinationNames()).toEqual(['ok']);
  });
  it('a stored URL that is not acceptable makes the destination unreadable instead of used', () => {
    disk.seed = { evil: { kind: 'team', gatewayUrl: 'http://api.evil.example', appUrl: 'https://align.evil.example', authToken: 'x', mode: 'auth' } };
    const c = createConfigStore();
    expect(() => c.getEnvironment('evil' as never)).toThrow(/https/);
  });
});
