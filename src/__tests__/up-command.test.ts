/**
 * `align up`: one command that brings the repo's decisions up to date and writes the file the agent reads.
 * Asked for by a user who keeps his agent off MCP and wants a file he controls.
 *
 * Test List:
 * 1. runs, in order: connect git, connect docs, sync, context sync - each as align itself
 * 2. stops at the first step that fails, names it, and returns its exit code
 * 3. --env reaches every step that takes it (sync has no --env: it always reads the local graph)
 */
import { describe, expect, it } from 'vitest';
import { runUp, UP_STEPS } from '../commands/up.js';

const recorder = (codes: Record<string, number> = {}) => {
  const ran: string[][] = [];
  const out: string[] = [];
  return {
    ran, out,
    deps: {
      run: async (argv: string[]) => { ran.push(argv); return codes[argv.join(' ')] ?? 0; },
      out: (l: string) => { out.push(l); },
    },
  };
};

describe('align up', () => {
  it('reads the repo, refreshes connected sources, then writes the decisions file, in that order', async () => {
    const r = recorder();
    expect(await runUp({}, r.deps)).toBe(0);
    expect(r.ran).toEqual([
      ['connect', 'git', '--approve'],
      ['connect', 'docs', '--approve'],
      ['sync'],
      ['context', 'sync'],
    ]);
    expect(UP_STEPS).toHaveLength(4);
  });

  it('stops at the first step that fails, says which, and returns its code', async () => {
    const r = recorder({ 'connect docs --approve': 3 });
    expect(await runUp({}, r.deps)).toBe(3);
    expect(r.ran.map((a) => a.join(' '))).toEqual(['connect git --approve', 'connect docs --approve']);
    expect(r.out.join('\n')).toMatch(/align up: reading the repo's docs failed \(exit 3\)\. Nothing after it ran\./);
  });

  it('passes --env to every step that takes it', async () => {
    const r = recorder();
    await runUp({ env: 'local' }, r.deps);
    expect(r.ran.map((a) => a.join(' '))).toEqual([
      'connect git --approve --env local',
      'connect docs --approve --env local',
      'sync',
      'context sync --env local',
    ]);
  });

  it('passes --limit and --out to the step that writes the file, and only to it', async () => {
    const r = recorder();
    await runUp({ limit: '40', out: 'DECISIONS.md' }, r.deps);
    expect(r.ran.map((a) => a.join(' '))).toEqual([
      'connect git --approve',
      'connect docs --approve',
      'sync',
      'context sync --limit 40 --out DECISIONS.md',
    ]);
  });
});
