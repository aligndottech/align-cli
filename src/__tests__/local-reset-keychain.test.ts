import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type * as ConfigModule from '../lib/config.js';
import { createTokenVault, selectBackend, type TokenVault } from '../lib/token-store.js';
import { fakeTool, type FakeTool } from './helpers/fake-os-secret-tools.js';

// The real config store over an in-memory conf and a fake keychain: nothing about forgetting is mocked away.
const disk = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
const holder = vi.hoisted(() => ({ vault: undefined as unknown }));
vi.mock('conf', () => ({
  default: class {
    constructor(opts: Record<string, unknown>) {
      const defaults = JSON.parse(JSON.stringify(opts['defaults'] ?? {})) as Record<string, unknown>;
      for (const [k, v] of Object.entries(defaults)) if (!(k in disk.data)) disk.data[k] = v;
    }
    get(k: string) { return disk.data[k]; }
    set(k: string, v: unknown) { disk.data[k] = JSON.parse(JSON.stringify(v)); }
    has(k: string) { return k in disk.data; }
    delete(k: string) { delete disk.data[k]; }
  },
}));
vi.mock('../lib/config.js', async (orig) => {
  const real = await orig<typeof ConfigModule>();
  return { ...real, createConfigStore: () => real.createConfigStore({ vault: holder.vault as TokenVault }) };
});
vi.mock('@clack/prompts', () => ({ intro: () => undefined, confirm: async () => true }));

import { createConfigStore } from '../lib/config.js';
import { registerLocalCommand } from '../commands/local.js';

let tool: FakeTool;
const vaultOn = (): TokenVault => createTokenVault({ selection: selectBackend({ platform: 'linux', run: tool.run }), notify: () => undefined });
const run = (args: string[]) => {
  const program = new Command();
  program.exitOverride();
  registerLocalCommand(program);
  return program.parseAsync(['node', 'align', ...args]);
};

beforeEach(() => {
  disk.data = {};
  tool = fakeTool('secret-tool');
  holder.vault = vaultOn();
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('align local reset and the keychain', () => {
  it('says it could not remove the token and exits 1 when the keychain is unreachable, keeping the record', async () => {
    createConfigStore().saveConnectorFields('local', 'github', { token: 'ghp_x' });
    tool.breakIt('locked');
    holder.vault = vaultOn();
    const err: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    await run(['local', 'reset']);
    expect(err.join('\n')).toMatch(/could not remove/i);
    expect(process.exitCode).toBe(1);
    expect(tool.store.get('local:github')).toBe('ghp_x');
    expect((disk.data['keychainTokens'] as Record<string, number>)['local:github']).toBeDefined();
  });

  it('removes the token and exits clean when the keychain answers', async () => {
    createConfigStore().saveConnectorFields('local', 'github', { token: 'ghp_x' });
    await run(['local', 'reset']);
    expect(tool.store.size).toBe(0);
    expect(process.exitCode).toBeUndefined();
  });
});
