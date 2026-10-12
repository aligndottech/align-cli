import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTrustedAlignBin } from '../trusted-align-bin.js';

// ALI-1515: the MCP command handed to an agent was a bare `align`, found through the AGENT's own PATH, which can hold
// relative or empty entries (`.`, `node_modules/.bin`) so a repo could shadow `align`. The trusted path is resolved by
// align itself, from absolute PATH entries only, and never from inside the directory align was started in.
let root: string;
let home: string;
let cwd: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-trusted-')));
  home = path.join(root, 'home');
  cwd = path.join(root, 'home', 'repo');
  fs.mkdirSync(cwd, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const bin = (dir: string, name = 'align'): string => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, '#!/bin/sh\n');
  fs.chmodSync(f, 0o755);
  return f;
};
const run = (entries: string[], opts: { platform?: typeof process.platform; cwd?: string } = {}) =>
  resolveTrustedAlignBin({ pathEnv: entries.join(path.delimiter), cwd: opts.cwd ?? cwd, home, platform: opts.platform ?? 'linux' });

describe('resolveTrustedAlignBin', () => {
  it('returns the first absolute PATH entry that holds align', () => {
    const a = bin(path.join(root, 'usr', 'bin'));
    bin(path.join(root, 'opt', 'bin'));
    expect(run([path.join(root, 'usr', 'bin'), path.join(root, 'opt', 'bin')])).toBe(a);
  });

  it('skips relative and empty entries, which a repo can plant', () => {
    bin(path.join(cwd, 'node_modules', '.bin'));
    const real = bin(path.join(root, 'usr', 'bin'));
    expect(run(['', '.', 'node_modules/.bin', path.join(root, 'usr', 'bin')])).toBe(real);
  });

  it('skips an ABSOLUTE entry inside the directory align was started in (what npx adds)', () => {
    bin(path.join(cwd, 'node_modules', '.bin'));
    const real = bin(path.join(root, 'usr', 'bin'));
    expect(run([path.join(cwd, 'node_modules', '.bin'), path.join(root, 'usr', 'bin')])).toBe(real);
  });

  it('accepts an entry inside the cwd when cwd is an ancestor of home (running from / is not a repo)', () => {
    const f = bin(path.join(home, '.local', 'bin'));
    expect(run([path.join(home, '.local', 'bin')], { cwd: root })).toBe(f);
  });

  it('returns null when the only copies are relative or inside the cwd', () => {
    bin(path.join(cwd, 'bin'));
    expect(run(['', '.', path.join(cwd, 'bin')])).toBeNull();
  });

  it('ignores a directory that happens to be called align', () => {
    fs.mkdirSync(path.join(root, 'usr', 'bin', 'align'), { recursive: true });
    const real = bin(path.join(root, 'opt', 'bin'));
    expect(run([path.join(root, 'usr', 'bin'), path.join(root, 'opt', 'bin')])).toBe(real);
  });

  it('on Windows finds align.cmd (the npm shim), and prefers align.exe when both exist', () => {
    const cmd = bin(path.join(root, 'npm'), 'align.cmd');
    expect(run([path.join(root, 'npm')], { platform: 'win32' })).toBe(cmd);
    const exe = bin(path.join(root, 'npm'), 'align.exe');
    expect(run([path.join(root, 'npm')], { platform: 'win32' })).toBe(exe);
  });

  it.skipIf(process.platform === 'win32')('keeps the symlink path, so an upgrade that retargets the link keeps working', () => {
    const target = bin(path.join(root, 'lib', 'node_modules', '.bin'), 'align-real');
    const linkDir = path.join(root, 'usr', 'bin');
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, 'align');
    fs.symlinkSync(target, link);
    expect(run([linkDir])).toBe(link);
  });
});
