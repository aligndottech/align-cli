import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const { relink, hasProvider } = vi.hoisted(() => ({
  relink: vi.fn(),
  hasProvider: vi.fn(() => true),
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({ getEnvironment: () => ({ mode: 'local-embedded', localDbPath: '/nonexistent/test-relink.db' }) }),
}));
vi.mock('../lib/local-relink.js', () => ({ relinkWithV1: relink }));
vi.mock('../lib/local-llm.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), hasConfiguredProvider: hasProvider }));

import { registerLocalCommand } from '../commands/local.js';

const out: string[] = [];
const err: string[] = [];
const run = (args: string[]) => {
  const program = new Command();
  program.exitOverride();
  registerLocalCommand(program);
  return program.parseAsync(['node', 'align', 'local', 'relink', ...args]);
};
const report = { sources: 1, remainingSources: 0, calls: 1, changes: [{ sourceId: 'n', targetId: 'a', from: 'conflicts_with', to: 'refines' }], unchanged: 2, written: 0, failed: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  out.length = 0; err.length = 0;
  process.exitCode = undefined;
  hasProvider.mockReturnValue(true);
  relink.mockResolvedValue(report);
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
});
afterEach(() => { process.exitCode = undefined; vi.mocked(console.log).mockRestore(); vi.mocked(console.error).mockRestore(); });

describe('align local relink: refusals', () => {
  it('--detector v0 is refused, naming v1; nothing runs', async () => {
    await run(['--detector', 'v0']);
    expect(process.exitCode).toBe(2);
    expect(err.join('\n')).toMatch(/--detector v1/);
    expect(relink).not.toHaveBeenCalled();
  });

  it('--replace without --apply is refused', async () => {
    await run(['--detector', 'v1', '--replace']);
    expect(process.exitCode).toBe(2);
    expect(relink).not.toHaveBeenCalled();
  });

  it('--dry-run with --apply is refused', async () => {
    await run(['--detector', 'v1', '--dry-run', '--apply']);
    expect(process.exitCode).toBe(2);
    expect(relink).not.toHaveBeenCalled();
  });

  it('with no AI provider configured, nothing runs', async () => {
    hasProvider.mockReturnValue(false);
    await run(['--detector', 'v1']);
    expect(process.exitCode).toBe(1);
    expect(relink).not.toHaveBeenCalled();
  });
});

describe('align local relink: runs', () => {
  it('no flag is a dry run: apply false, and it says nothing was written', async () => {
    await run(['--detector', 'v1']);
    expect(relink).toHaveBeenCalledWith('/nonexistent/test-relink.db', { apply: false, replace: false }, undefined);
    expect(out.join('\n')).toMatch(/Dry run/);
    expect(out.join('\n')).toContain('conflicts_with -> refines');
  });

  it('--dry-run explicitly is the same', async () => {
    await run(['--detector', 'v1', '--dry-run']);
    expect(relink.mock.calls[0]![1]).toEqual({ apply: false, replace: false });
  });

  it('--apply --replace --limit 3 passes all three through', async () => {
    await run(['--detector', 'v1', '--apply', '--replace', '--limit', '3']);
    expect(relink.mock.calls[0]![1]).toEqual({ apply: true, replace: true, limit: 3 });
  });
});
