import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeExists } from '../lib/claude-presence.js';

/** ALI-1779: Claude Code "exists" when its binary is on PATH or its user config is on disk. */
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
    const bin = emptyBin();
    writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    expect(claudeCodeExists({ home: home(), env: { PATH: bin }, platform: 'linux' })).toBe(true);
  });
});
