import { describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { loadPiSdk, npmCommand, PI_ENGINE_PACKAGES, PI_ENGINE_VERSION, type PiSdkDeps } from '../lib/agent/engines/pi-sdk.js';

// The engine is ~110 MB of provider SDKs, so it is not in the npm install (install-smoke caps that
// at 100 MB). It is bundled where it can be (the compiled binary, a dev checkout), and otherwise
// downloaded once, with the person's yes, into Align's own directory.
const SDK = { createAgentSession: vi.fn() } as never;
const missing = async () => { throw Object.assign(new Error("Cannot find package '@earendil-works/pi-coding-agent'"), { code: 'ERR_MODULE_NOT_FOUND' }); };

function deps(over: Partial<PiSdkDeps> = {}) {
  const lines: string[] = [];
  const d: PiSdkDeps = {
    engineDir: '/home/u/.align/engine/1.5.0',
    importBundled: missing,
    importInstalled: missing,
    confirm: vi.fn(async () => true),
    runNpm: vi.fn(async () => 0),
    out: (l) => lines.push(l),
    ...over,
  };
  return { d, lines };
}

describe('loadPiSdk', () => {
  it('uses the bundled engine when there is one, and downloads nothing', async () => {
    const { d } = deps({ importBundled: async () => ({ sdk: SDK, version: PI_ENGINE_VERSION }) });
    expect(await loadPiSdk(d)).toBe(SDK);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.runNpm).not.toHaveBeenCalled();
  });
  it('uses an engine downloaded before, and asks nothing', async () => {
    const importInstalled = vi.fn(async () => SDK);
    const { d } = deps({ importInstalled });
    expect(await loadPiSdk(d)).toBe(SDK);
    expect(importInstalled).toHaveBeenCalledWith('/home/u/.align/engine/1.5.0');
    expect(d.confirm).not.toHaveBeenCalled();
  });
  it('asks once, then installs the exact pinned versions into the engine directory', async () => {
    let installed = false;
    const runNpm = vi.fn(async () => { installed = true; return 0; });
    const { d } = deps({ runNpm, importInstalled: async () => { if (!installed) return missing(); return SDK; } });
    expect(await loadPiSdk(d)).toBe(SDK);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    const args = runNpm.mock.calls[0]![0] as string[];
    expect(args.slice(0, 3)).toEqual(['install', '--prefix', '/home/u/.align/engine/1.5.0']);
    for (const name of PI_ENGINE_PACKAGES) {
      expect(args).toContain(`${name}@${(pkg.devDependencies as Record<string, string>)[name]}`);
    }
  });
  it('downloads nothing on a no, and says why it cannot run', async () => {
    const { d } = deps({ confirm: vi.fn(async () => false) });
    await expect(loadPiSdk(d)).rejects.toThrow(/not downloaded/);
    expect(d.runNpm).not.toHaveBeenCalled();
  });
  it('fails with the reason when npm fails', async () => {
    const { d } = deps({ runNpm: vi.fn(async () => 1) });
    await expect(loadPiSdk(d)).rejects.toThrow(/download failed/);
  });
  it('pins every engine package exactly in devDependencies, so the download matches what was tested', () => {
    for (const name of PI_ENGINE_PACKAGES) expect((pkg.devDependencies as Record<string, string>)[name]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(pkg.dependencies)).not.toEqual(expect.arrayContaining([...PI_ENGINE_PACKAGES]));
  });
});

describe('loadPiSdk: a different Pi on the machine', () => {
  it('ignores a bundled Pi of another version and uses the pinned download', async () => {
    const pinnedSdk = { pinned: true } as never;
    const { d } = deps({ importBundled: async () => ({ sdk: { old: true } as never, version: '0.74.0' }), importInstalled: async () => pinnedSdk });
    expect(await loadPiSdk(d)).toBe(pinnedSdk);
  });
});

describe('npmCommand', () => {
  const dir = 'C:\\Users\\Jo Smith\\.align\\engine\\1.5.0';
  it('quotes a path with a space for cmd.exe on Windows', () => {
    const c = npmCommand('win32', ['install', '--prefix', dir]);
    expect(c).toMatchObject({ cmd: 'npm.cmd', shell: true });
    expect(c.args).toEqual(['install', '--prefix', `"${dir}"`]);
  });
  it('passes arguments untouched elsewhere, with no shell', () => {
    expect(npmCommand('linux', ['install', '--prefix', '/home/jo smith/.align'])).toEqual({ cmd: 'npm', args: ['install', '--prefix', '/home/jo smith/.align'], shell: false });
  });
});
