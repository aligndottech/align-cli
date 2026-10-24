import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeExists } from '../lib/claude-presence.js';

/** Claude Code "exists" when its binary is on PATH or its user config is on disk. */
describe('claudeCodeExists', () => {
  const home = () => mkdtempSync(path.join(tmpdir(), 'cc-home-'));
  const emptyBin = () => mkdtempSync(path.join(tmpdir(), 'cc-bin-'));

  it('false with no binary and no config', () => {
    expect(claudeCodeExists({ home: home(), env: { PATH: emptyBin() }, platform: 'linux' })).toBe(false);
  });
  it('true when ~/.claude.json exists', () => {
    const h = home();
    writeFileSync(path.join(h, '.claude.json'), '{}');
    expect(claudeCodeExists({ home: h, env: { PATH: emptyBin() }, platform: 'linux' })).toBe(true);
  });
  it('true when ~/.claude/ exists', () => {
    const h = home();
    mkdirSync(path.join(h, '.claude'));
    expect(claudeCodeExists({ home: h, env: { PATH: emptyBin() }, platform: 'linux' })).toBe(true);
  });
  it('true when `claude` is an executable on PATH', () => {
    // The platform under test is the real one, so the Windows runner exercises its own rules:
    // there an npm global install is claude.cmd and a bare `claude` file is not executable.
    const win = process.platform === 'win32';
    const bin = emptyBin();
    writeFileSync(path.join(bin, win ? 'claude.cmd' : 'claude'), win ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
    expect(claudeCodeExists({ home: home(), env: { PATH: bin }, platform: process.platform })).toBe(true);
  });
  it('win32: finds claude.cmd when PATHEXT lists .CMD', () => {
    const bin = emptyBin();
    writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\n');
    expect(claudeCodeExists({ home: home(), env: { PATH: bin, PATHEXT: '.COM;.EXE;.CMD' }, platform: 'win32' })).toBe(true);
  });
  it('win32: does not find claude.cmd when PATHEXT omits .CMD', () => {
    const bin = emptyBin();
    writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\n');
    expect(claudeCodeExists({ home: home(), env: { PATH: bin, PATHEXT: '.EXE' }, platform: 'win32' })).toBe(false);
  });
  it('win32: a bare `claude` file with no extension is not an executable', () => {
    const bin = emptyBin();
    writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    expect(claudeCodeExists({ home: home(), env: { PATH: bin }, platform: 'win32' })).toBe(false);
  });
});
