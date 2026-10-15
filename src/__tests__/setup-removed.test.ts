/**
 * `align setup` is gone. Bare `align` is the wizard now. A script that still says `align setup` must fail loudly
 * with the replacement, not run the launcher and exit 0 - the root action would otherwise take "setup" as an
 * operand and print the no-terminal hint as if nothing had changed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const runDefaultAction = vi.fn(async () => {});
vi.mock('../commands/default-action.js', () => ({ runDefaultAction }));

afterEach(() => { runDefaultAction.mockClear(); vi.restoreAllMocks(); });

async function run(argv: string[]) {
  const { buildProgram } = await import('../cli.js');
  const program = buildProgram();
  program.exitOverride();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
  await program.parseAsync(['node', 'align', ...argv]).catch(() => {});
  return { exit, stderr: vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join('\n') };
}

describe('align setup is removed', () => {
  it('align setup exits 1 and names the replacement, and does not run the launcher', async () => {
    const { exit, stderr } = await run(['setup']);
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toMatch(/setup/);
    expect(stderr).toMatch(/align/);
    expect(runDefaultAction).not.toHaveBeenCalled();
  });

  it('bare align still runs the default action (two examples: no args, and a hidden setup flag)', async () => {
    await run([]);
    expect(runDefaultAction).toHaveBeenCalledTimes(1);
    await run(['--approve']);
    expect(runDefaultAction).toHaveBeenCalledTimes(2);
  });
});
