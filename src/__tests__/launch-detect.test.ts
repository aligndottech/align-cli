import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findOnPath } from '../lib/launch/detect.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'align-detect-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const put = (name: string, mode: number) => { const p = path.join(dir, name); writeFileSync(p, '#!/bin/sh\n'); chmodSync(p, mode); return p; };

describe('findOnPath', () => {
  it('finds an executable file on PATH', () => {
    const p = put('claude', 0o755);
    expect(findOnPath('claude', { PATH: dir }, 'linux')).toBe(p);
  });
  it('does not detect a non-executable file', () => {
    put('claude', 0o644);
    expect(findOnPath('claude', { PATH: dir }, 'linux')).toBeNull();
  });
  it('does not detect an agent from its config dir alone', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'align-home-'));
    mkdirSync(path.join(home, '.claude'));
    try { expect(findOnPath('claude', { PATH: dir, HOME: home }, 'linux')).toBeNull(); }
    finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('skips a directory named like the binary', () => {
    mkdirSync(path.join(dir, 'claude'));
    expect(findOnPath('claude', { PATH: dir }, 'linux')).toBeNull();
  });
  it('resolves claude.cmd through PATHEXT on win32', () => {
    const p = put('claude.cmd', 0o644);
    expect(findOnPath('claude', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(p);
  });
  it('returns null for an empty or missing PATH', () => {
    expect(findOnPath('claude', {}, 'linux')).toBeNull();
    expect(findOnPath('claude', { PATH: '' }, 'linux')).toBeNull();
  });
});
