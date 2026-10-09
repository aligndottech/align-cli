import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { type InstallOfferDeps, installText, offerInstall } from '../lib/launch/install.js';
import { specByName } from '../lib/launch/registry/index.js';
import type { AgentSpec } from '../lib/launch/registry/types.js';

/**
 * Decision 4: offer to run a package-manager install, only on a TTY, only after an explicit
 * yes, default No, as an argv with no shell. A script or URL installer is printed, never run.
 */
const codex = specByName('codex')!;
const gemini = specByName('gemini-cli')!;
const cursor = specByName('cursor')!;
const pi = specByName('pi')!;

function fakeChildExiting(code: number) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit('exit', code, null));
  return child;
}

function deps(over: Partial<InstallOfferDeps> = {}) {
  const said: string[] = [];
  const d: InstallOfferDeps = {
    isTTY: true,
    platform: 'linux',
    confirm: vi.fn(async () => true),
    spawn: vi.fn(() => fakeChildExiting(0) as never),
    onPath: vi.fn(() => '/usr/bin/npm'),
    say: (l) => said.push(l),
    ...over,
  };
  return { d, said };
}

describe('installText', () => {
  it('renders an npm install as its argv and a docs install as its URL (both kinds)', () => {
    expect(installText(codex.install)).toBe('npm i -g @openai/codex');
    expect(installText(cursor.install)).toBe('https://cursor.com/cli');
  });
});

describe('offerInstall: an npm installer', () => {
  it('asks first, naming the exact command, with No as the default', async () => {
    const { d } = deps();
    await offerInstall(codex, d);
    expect(d.confirm).toHaveBeenCalledExactlyOnceWith('Install Codex now? (runs: npm i -g @openai/codex)');
  });
  it('on yes, runs exactly the shown argv without a shell, output visible, and reports installed (two agents)', async () => {
    for (const spec of [codex, gemini]) {
      const { d } = deps();
      expect(await offerInstall(spec, d)).toBe('installed');
      const argv = (spec.install as { argv: string[] }).argv;
      // The npm that was found on PATH, by its absolute path: the one the question named.
      expect(d.spawn).toHaveBeenCalledExactlyOnceWith('/usr/bin/npm', argv.slice(1), expect.objectContaining({ shell: false, stdio: 'inherit' }));
      expect(d.onPath).toHaveBeenCalledWith(argv[0]);
    }
  });
  it('on Windows, npm.cmd runs through the quoted cmd.exe line the launcher uses, still with shell: false', async () => {
    const { d } = deps({ platform: 'win32', onPath: vi.fn(() => 'C:\\nodejs\\npm.cmd') });
    expect(await offerInstall(codex, d)).toBe('installed');
    expect(d.spawn).toHaveBeenCalledExactlyOnceWith(
      'cmd.exe',
      ['/d', '/s', '/c', '""C:\\nodejs\\npm.cmd" "i" "-g" "@openai/codex""'],
      expect.objectContaining({ shell: false, stdio: 'inherit', windowsVerbatimArguments: true }),
    );
  });
  it('on Linux the same pick runs npm itself, with no verbatim-arguments flag', async () => {
    const { d } = deps();
    await offerInstall(codex, d);
    expect((d.spawn as ReturnType<typeof vi.fn>).mock.calls[0]![2]).not.toHaveProperty('windowsVerbatimArguments');
  });
  it('runs whichever npm the PATH scan resolved, not the bare name (two paths)', async () => {
    for (const npm of ['/opt/node/bin/npm', '/home/u/.nvm/versions/node/v22/bin/npm']) {
      const { d } = deps({ onPath: vi.fn(() => npm) });
      await offerInstall(codex, d);
      expect((d.spawn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(npm);
    }
  });
  it('Ctrl-C at the question (confirm resolves null) reports cancelled and spawns nothing', async () => {
    const { d } = deps({ confirm: vi.fn(async () => null) });
    expect(await offerInstall(codex, d)).toBe('cancelled');
    expect(d.spawn).not.toHaveBeenCalled();
  });
  it('a Windows npm path holding a cmd.exe metacharacter fails cleanly after yes: no throw, no spawn, one clear line', async () => {
    const { d, said } = deps({ platform: 'win32', onPath: vi.fn(() => 'C:\\Tools & Co\\npm.cmd') });
    expect(await offerInstall(codex, d)).toBe('failed');
    expect(d.spawn).not.toHaveBeenCalled();
    expect(said.join('\n')).toMatch(/Could not run npm i -g @openai\/codex .*shell character &.*Codex is not installed\./);
  });
  it('on no, spawns nothing and reports declined', async () => {
    const { d } = deps({ confirm: vi.fn(async () => false) });
    expect(await offerInstall(codex, d)).toBe('declined');
    expect(d.spawn).not.toHaveBeenCalled();
  });
  it('a non-zero npm exit reports failed and says so', async () => {
    const { d, said } = deps({ spawn: vi.fn(() => fakeChildExiting(1) as never) });
    expect(await offerInstall(codex, d)).toBe('failed');
    expect(said.join('\n')).toContain('exited 1');
  });
  it('without a TTY it never asks and never spawns: it prints the command (two agents)', async () => {
    for (const spec of [codex, gemini]) {
      const { d, said } = deps({ isTTY: false });
      expect(await offerInstall(spec, d)).toBe('manual');
      expect(d.confirm).not.toHaveBeenCalled();
      expect(d.spawn).not.toHaveBeenCalled();
      expect(said.join('\n')).toContain(installText(spec.install));
    }
  });
  it('when npm itself is not on PATH it prints the command instead of offering', async () => {
    const { d, said } = deps({ onPath: vi.fn(() => null) });
    expect(await offerInstall(codex, d)).toBe('manual');
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.spawn).not.toHaveBeenCalled();
    expect(said.join('\n')).toContain('npm i -g @openai/codex');
  });
});

describe('offerInstall: a script or URL installer', () => {
  it.each([cursor, pi] as AgentSpec[])('never offers to run it: no confirm, no spawn, the docs are printed ($label)', async (spec) => {
    const { d, said } = deps();
    expect(await offerInstall(spec, d)).toBe('manual');
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.spawn).not.toHaveBeenCalled();
    expect(said.join('\n')).toContain(installText(spec.install));
  });
});
