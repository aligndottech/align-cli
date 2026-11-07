import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type * as LocalMode from '../lib/local-mode.js';

const connectDetectedAgents = vi.hoisted(() => vi.fn(async () => ({ detected: 0, connected: 0, wired: [] })));
vi.mock('../commands/connect-agents.js', () => ({ connectDetectedAgents }));
vi.mock('../lib/local-mode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalMode>()),
  initLocalMode: vi.fn(async () => ({ dbPath: '/tmp/align-test/local.db' })),
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
}));

import { registerLocalCommand } from '../commands/local.js';

// Nobody has said yes on this path, unlike setup, so connectDetectedAgents must do the asking.
// Passing approved here would write every agent's user-wide config unasked.
describe('align local start', () => {
  it('connects agents without claiming a prior yes', async () => {
    const program = new Command();
    registerLocalCommand(program);
    await program.parseAsync(['node', 'align', 'local', 'start']);
    expect(connectDetectedAgents).toHaveBeenCalledTimes(1);
    const calls = connectDetectedAgents.mock.calls as unknown as [string, { approved?: boolean }?][];
    expect(calls[0]![0]).toBe('local');
    expect(calls[0]![1]?.approved).not.toBe(true);
  });
});
