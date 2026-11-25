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
import { runUp, UP_STEPS, upChildCommand } from '../commands/up.js';

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
    // No --env: the steps are pinned to the local graph, so a cloud login never has the repo's text sent to it unasked.
    expect(r.ran).toEqual([
      ['connect', 'git', '--approve', '--env', 'local'],
      ['connect', 'docs', '--approve', '--env', 'local'],
      ['sync'],
      ['context', 'sync', '--env', 'local'],
    ]);
    expect(UP_STEPS).toHaveLength(4);
  });

  it('stops at the first step that fails, says which, and returns its code', async () => {
    const r = recorder({ 'connect docs --approve --env local': 3 });
    expect(await runUp({}, r.deps)).toBe(3);
    expect(r.ran.map((a) => a.join(' '))).toEqual(['connect git --approve --env local', 'connect docs --approve --env local']);
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

  it('passes each --docs-path to the docs step, and only to it', async () => {
    const r = recorder();
    await runUp({ docsPath: ['spec/gotchas', 'spec/rules'] }, r.deps);
    expect(r.ran.map((a) => a.join(' '))).toEqual([
      'connect git --approve --env local',
      'connect docs --approve --env local --docs-path spec/gotchas --docs-path spec/rules',
      'sync',
      'context sync --env local',
    ]);
  });

  it('passes --limit and --out to the step that writes the file, and only to it', async () => {
    const r = recorder();
    await runUp({ limit: '40', out: 'DECISIONS.md' }, r.deps);
    expect(r.ran.map((a) => a.join(' '))).toEqual([
      'connect git --approve --env local',
      'connect docs --approve --env local',
      'sync',
      'context sync --env local --limit 40 --out DECISIONS.md',
    ]);
  });

  it('a failed refresh of connected sources is reported, and the file is still written from the repo', async () => {
    const r = recorder({ sync: 1 });
    expect(await runUp({}, r.deps)).toBe(0);
    expect(r.ran.map((a) => a.join(' '))).toContain('context sync --env local');
    expect(r.out.join('\n')).toMatch(/refreshing connected sources failed \(exit 1\).*carried on/s);
  });

  it('a named cloud environment is passed through as given, since naming it is the person choosing to send there', async () => {
    const r = recorder();
    await runUp({ env: 'prod' }, r.deps);
    expect(r.ran.map((a) => a.join(' '))).toEqual(['connect git --approve --env prod', 'connect docs --approve --env prod', 'context sync --env prod']);
  });

  it('an empty environment name is not a named environment: it stays local, and the refresh still runs', async () => {
    // ALIGN_ENV= (an unset variable expanded into it) must not fall through to a cloud default in the children.
    const r = recorder();
    await runUp({ env: '' }, r.deps);
    expect(r.ran.map((a) => a.join(' '))).toEqual(['connect git --approve --env local', 'connect docs --approve --env local', 'sync', 'context sync --env local']);
  });

  it('skips the local refresh when --env names another graph, and says so', async () => {
    const r = recorder();
    await runUp({ env: 'prod' }, r.deps);
    expect(r.ran.map((a) => a.join(' '))).not.toContain('sync');
    expect(r.out.join('\n')).toMatch(/skipped.*local/i);
  });

  it('a child keeps the loader flags the parent ran under (tsx in a source checkout)', () => {
    const c = upChildCommand(['connect', 'git'], { execArgv: ['--import', 'tsx'], execPath: '/node', argv1: '/src/index.ts', dist: 'npm' });
    expect(c).toEqual({ command: '/node', args: ['--import', 'tsx', '/src/index.ts', 'connect', 'git'] });
    // An installed build runs with no loader flags: the argument shape is unchanged.
    expect(upChildCommand(['sync'], { execArgv: [], execPath: '/node', argv1: '/bin/align', dist: 'npm' })).toEqual({ command: '/node', args: ['/bin/align', 'sync'] });
    // A compiled binary takes no loader flags even if the runtime reports some.
    expect(upChildCommand(['sync'], { execArgv: ['--smol'], execPath: '/usr/local/bin/align', dist: 'binary' })).toEqual({ command: '/usr/local/bin/align', args: ['sync'] });
  });
});
