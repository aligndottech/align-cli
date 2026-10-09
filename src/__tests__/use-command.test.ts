import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runUse, type UseDeps } from '../commands/use.js';
import { safeWriteJson, setWriteRecorder, type WrittenConfig } from '../lib/safe-config-write.js';

function harness(stored?: string, onPath: Record<string, string> = { claude: '/usr/bin/claude' }, manifest: Record<string, WrittenConfig> = {}) {
  let current = stored;
  let written = manifest;
  const out: string[] = [];
  const err: string[] = [];
  const clearAgent = vi.fn(() => { current = undefined; });
  const setAgent = vi.fn((a: string) => { current = a; });
  const setLaunchOff = vi.fn();
  const deps: UseDeps = {
    config: { getAgent: () => current, setAgent, clearAgent, setLaunchOff },
    writtenConfigs: { get: () => written, clear: () => { written = {}; } },
    findOnPath: (bin) => onPath[bin] ?? null,
    env: {},
    platform: 'linux',
    log: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, out, err, setAgent, clearAgent, setLaunchOff, current: () => current, manifest: () => written };
}

describe('align use', () => {
  it('stores claude-code when it is on PATH', async () => {
    const h = harness();
    expect(await runUse('claude-code', h.deps)).toBe(0);
    expect(h.setAgent).toHaveBeenCalledExactlyOnceWith('claude-code');
    expect(h.out.join('\n')).toContain('Claude Code');
  });
  it('refuses claude-code when it is not on PATH: exit 1, config unchanged, install hint', async () => {
    const h = harness('claude-code', {});
    expect(await runUse('claude-code', h.deps)).toBe(1);
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('npm i -g @anthropic-ai/claude-code');
  });
  it.each(['codex'])('reports %s as coming soon and stores nothing', async (name) => {
    const h = harness('claude-code', { codex: '/bin/codex', opencode: '/bin/opencode', claude: '/bin/claude' });
    expect(await runUse(name, h.deps)).toBe(1);
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.current()).toBe('claude-code');
    expect(h.err.join('\n')).toMatch(/coming soon/);
  });
  it('stores opencode when it is on PATH, and refuses it when it is not (C2)', async () => {
    const on = harness('claude-code', { opencode: '/bin/opencode', claude: '/bin/claude' });
    expect(await runUse('opencode', on.deps)).toBe(0);
    expect(on.setAgent).toHaveBeenCalledExactlyOnceWith('opencode');
    const off = harness('claude-code', { claude: '/bin/claude' });
    expect(await runUse('opencode', off.deps)).toBe(1);
    expect(off.setAgent).not.toHaveBeenCalled();
    expect(off.err.join('\n')).toContain('npm i -g opencode-ai');
  });
  it('rejects an unknown name, listing the valid ones, and stores nothing', async () => {
    const h = harness();
    expect(await runUse('emacs', h.deps)).toBe(1);
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('claude-code');
    expect(h.err.join('\n')).toContain('codex');
  });
  it('with no argument prints the current choice', async () => {
    const h = harness('claude-code');
    expect(await runUse(undefined, h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('claude-code');
    expect(h.setAgent).not.toHaveBeenCalled();
  });
  it('with no argument and nothing chosen says so and how it gets chosen', async () => {
    const h = harness(undefined);
    expect(await runUse(undefined, h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/No agent chosen/);
  });

  it('--none clears the choice, so bare `align` picks again', async () => {
    const h = harness('claude-code');
    expect(await runUse(undefined, h.deps, { none: true })).toBe(0);
    expect(h.clearAgent).toHaveBeenCalledTimes(1);
    expect(h.current()).toBeUndefined();
    expect(h.out.join('\n')).toMatch(/cleared/i);
  });
  it('--none with an agent name is a usage error and changes nothing', async () => {
    const h = harness('claude-code');
    expect(await runUse('claude-code', h.deps, { none: true })).toBe(2);
    expect(h.clearAgent).not.toHaveBeenCalled();
    expect(h.setAgent).not.toHaveBeenCalled();
  });
  it('without --none nothing is ever cleared', async () => {
    const h = harness('claude-code');
    await runUse('claude-code', h.deps);
    await runUse(undefined, h.deps);
    await runUse('codex', h.deps);
    expect(h.clearAgent).not.toHaveBeenCalled();
  });
});

describe('align use --undo (C4)', () => {
  it('restores every recorded file byte-identical and clears the manifest (two files)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'align-undo-'));
    try {
      const manifest: Record<string, WrittenConfig> = {};
      setWriteRecorder((f, e) => { manifest[f] = e; });
      const a = path.join(dir, 'a.json');
      const b = path.join(dir, 'b.json');
      writeFileSync(a, '{ "a":1 }');
      writeFileSync(b, '{"b":2}\n');
      safeWriteJson(a, (c) => ({ ...c, align: 1 }), { note: () => {} });
      safeWriteJson(b, (c) => ({ ...c, align: 1 }), { note: () => {} });
      setWriteRecorder(undefined);
      const h = harness(undefined, {}, manifest);
      expect(await runUse(undefined, h.deps, { undo: true })).toBe(0);
      expect(readFileSync(a, 'utf8')).toBe('{ "a":1 }');
      expect(readFileSync(b, 'utf8')).toBe('{"b":2}\n');
      expect(h.manifest()).toEqual({});
      expect(h.out.join('\n')).toContain(`Restored ${a}`);
      expect(h.out).toContain('Restored 2 files. align will not open an agent until you run `align use <agent>`.');
      expect(h.clearAgent).toHaveBeenCalledOnce();
      expect(h.setLaunchOff).toHaveBeenCalledExactlyOnceWith(true);
      expect(h.current()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with an empty manifest it is a no-op that says so', async () => {
    const h = harness('claude-code');
    expect(await runUse(undefined, h.deps, { undo: true })).toBe(0);
    expect(h.out.join('\n')).toContain('Nothing to undo');
    expect(h.clearAgent).not.toHaveBeenCalled();
    expect(h.setLaunchOff).not.toHaveBeenCalled();
    expect(h.current()).toBe('claude-code');
    expect(h.err).toEqual([]);
  });

  it('reports a file it could not restore, exits 1, and still clears the manifest', async () => {
    const h = harness(undefined, {}, { '/nope/missing.json': { created: false, sha256: 'x' } });
    expect(await runUse(undefined, h.deps, { undo: true })).toBe(1);
    expect(h.err.join('\n')).toContain('/nope/missing.json: no backup found');
    expect(h.manifest()).toEqual({});
    expect(h.setLaunchOff).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([['pi', {}], [undefined, { none: true }]])('refuses to combine with an agent name or --none (%s)', async (name, extra) => {
    const h = harness(undefined, {}, { '/x.json': { created: true, sha256: 'x' } });
    expect(await runUse(name, h.deps, { undo: true, ...extra })).toBe(2);
    expect(h.manifest()).not.toEqual({});
    expect(h.setLaunchOff).not.toHaveBeenCalled();
  });
});
