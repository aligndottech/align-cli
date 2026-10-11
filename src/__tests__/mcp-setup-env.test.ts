import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type * as McpSetup from '../lib/mcp-setup.js';

/** `align mcp --setup --env <name>` writes the name into an agent's config, so it has to be a name that means something. */
const disk = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('conf', () => ({
  default: class {
    constructor(opts: { defaults?: Record<string, unknown> }) {
      for (const [k, v] of Object.entries(opts.defaults ?? {})) if (!(k in disk.store)) disk.store[k] = v;
    }
    get(k: string) { return disk.store[k]; }
    set(k: string, v: unknown) { disk.store[k] = v; }
    has(k: string) { return k in disk.store; }
    delete(k: string) { delete disk.store[k]; }
    clear() { disk.store = {}; }
  },
}));
vi.mock('../lib/mcp-setup.js', async (importOriginal) => ({ ...(await importOriginal<typeof McpSetup>()), detectEditors: () => [] }));
const warned: string[] = [];
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(), isCancel: () => false, multiselect: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: (m: string) => warned.push(m) },
}));

import { createConfigStore } from '../lib/config.js';
import { registerMcpCommand } from '../commands/mcp.js';

async function setup(env: string): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerMcpCommand(program);
  await program.parseAsync(['node', 'align', 'mcp', '--setup', '--env', env]);
}

beforeEach(() => {
  disk.store = {}; warned.length = 0;
  for (const k of ['ALIGN_ENV', 'ALIGN_TOKEN', 'ALIGN_GATEWAY_URL']) vi.stubEnv(k, '');
});
afterEach(() => vi.unstubAllEnvs());

describe('align mcp --setup --env', () => {
  it('a saved team destination is written into the config the user is handed', async () => {
    createConfigStore().saveTeamDestination('acme', { gatewayUrl: 'https://api.acme.example', appUrl: 'https://align.acme.example', authToken: 'x'.repeat(12), tenantId: 'T' });
    await setup('acme');
    expect(warned.join('\n')).toContain('"--env","acme"');
  });

  it('a name that is not a saved destination stops: nothing is handed over', async () => {
    await expect(setup('acmee')).rejects.toThrow(/Unknown environment/);
    expect(warned).toEqual([]);
  });

  it('a builtin still works', async () => {
    await setup('preview');
    expect(warned.join('\n')).toContain('"--env","preview"');
  });
});
