import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const runStale = vi.fn();
vi.mock('../lib/stale-run.js', () => ({ runStale: (...a: unknown[]) => runStale(...a) }));
vi.mock('../lib/config.js', () => ({ createConfigStore: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => { throw new Error('cloud client must not be built'); }) }));

import { createConfigStore } from '../lib/config.js';
import { registerStaleCommand } from '../commands/stale.js';
import { renderReport } from '../lib/stale-render.js';

/** After `align local start` the default env is still a cloud one; bare `align stale` must use the local graph like ask/search/check. */
describe('align stale with only a local graph set up', () => {
  const orig = process.env['ALIGN_ENV'];
  afterEach(() => { vi.clearAllMocks(); if (orig === undefined) delete process.env['ALIGN_ENV']; else process.env['ALIGN_ENV'] = orig; });

  const setup = (defaultEnv: string) => {
    delete process.env['ALIGN_ENV'];
    const envs: Record<string, object> = {
      local: { mode: 'local-embedded', authToken: null },
      [defaultEnv]: { mode: 'auth', authToken: null },
    };
    (createConfigStore as ReturnType<typeof vi.fn>).mockReturnValue({ getDefaultEnv: () => defaultEnv, getEnvironment: (e: string) => envs[e] ?? envs['local'] });
    runStale.mockResolvedValue({ report: {}, loadNotes: [], result: { ok: true } });
  };

  for (const def of ['prod', 'preview']) {
    it(`resolves the local graph when the default is ${def} with no login`, async () => {
      setup(def);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const program = new Command();
      registerStaleCommand(program);
      await program.parseAsync(['node', 'align', 'stale', '--json']);
      log.mockRestore();
      expect(runStale).toHaveBeenCalledTimes(1);
      expect((runStale.mock.calls[0] as unknown[])[0]).toMatchObject({ mode: 'local-embedded' });
      expect((runStale.mock.calls[0] as unknown[])[1]).toBeNull();
    });
  }
});

describe('the stale hint for a person-only mark', () => {
  it('tells an agent to run align mark in the person\'s own terminal', async () => {
    const { LOCAL_EMPTY_NOTE } = await import('../lib/stale-links.js');
    expect(LOCAL_EMPTY_NOTE).toContain('`align mark <new> replaces <old>` in your own terminal');
    expect(typeof renderReport).toBe('function');
  });
});
