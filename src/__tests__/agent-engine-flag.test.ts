import { afterEach, describe, expect, it, vi } from 'vitest';

const runDefaultAction = vi.fn(async (_opts: Record<string, unknown>) => {});
vi.mock('../commands/default-action.js', () => ({ runDefaultAction }));

afterEach(() => { runDefaultAction.mockClear(); vi.restoreAllMocks(); });

async function run(argv: string[]) {
  const { buildProgram } = await import('../cli.js');
  const program = buildProgram();
  program.exitOverride();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await program.parseAsync(['node', 'align', ...argv]).catch(() => {});
}

describe('align --engine', () => {
  it('hands the engine to the default action', async () => {
    await run(['--engine', 'claude']);
    expect(runDefaultAction.mock.calls[0]?.[0]).toMatchObject({ engine: 'claude' });
    await run(['--engine', 'align']);
    expect(runDefaultAction.mock.calls[1]?.[0]).toMatchObject({ engine: 'align' });
  });
  it('refuses an engine Align does not have, before anything runs', async () => {
    await run(['--engine', 'codex']);
    expect(runDefaultAction).not.toHaveBeenCalled();
  });
});
