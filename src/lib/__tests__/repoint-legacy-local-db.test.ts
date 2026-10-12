import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repointLegacyLocalDb } from '../local-mode.js';

// An upgraded user's config stores an ABSOLUTE localDbPath, and every command opens that path. After the move to
// ~/.align the copied graph sits there unused unless the saved path is repointed. Only a path that points at a legacy
// graph location is repointed; a path the user chose is left alone.
let root: string;
let legacy: string;
let home: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'align-repoint-'));
  legacy = path.join(root, 'legacy');
  home = path.join(root, '.align');
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fakeConfig(env: { mode?: string; localDbPath?: string }) {
  const saved = { ...env };
  return {
    saved,
    getEnvironment: () => saved as { mode: string; localDbPath?: string },
    setLocalMode: (p: string) => { saved.mode = 'local-embedded'; saved.localDbPath = p; },
  };
}

describe('repointLegacyLocalDb', () => {
  it('repoints a saved path that points at a legacy graph, once the copy exists in ~/.align', () => {
    fs.writeFileSync(path.join(home, 'local.db'), 'copied');
    const cfg = fakeConfig({ mode: 'local-embedded', localDbPath: path.join(legacy, 'local.db') });
    expect(repointLegacyLocalDb(cfg, [legacy], home)).toBe(true);
    expect(cfg.saved.localDbPath).toBe(path.join(home, 'local.db'));
  });

  it('matches either of two legacy directories', () => {
    const legacy2 = path.join(root, 'legacy2');
    fs.writeFileSync(path.join(home, 'local.db'), 'copied');
    const cfg = fakeConfig({ mode: 'local-embedded', localDbPath: path.join(legacy2, 'local.db') });
    expect(repointLegacyLocalDb(cfg, [legacy, legacy2], home)).toBe(true);
  });

  it('leaves a path the user chose alone', () => {
    fs.writeFileSync(path.join(home, 'local.db'), 'copied');
    const custom = path.join(root, 'my-graphs', 'local.db');
    const cfg = fakeConfig({ mode: 'local-embedded', localDbPath: custom });
    expect(repointLegacyLocalDb(cfg, [legacy], home)).toBe(false);
    expect(cfg.saved.localDbPath).toBe(custom);
  });

  it('does not repoint at a graph that was never copied (the saved path keeps working)', () => {
    const cfg = fakeConfig({ mode: 'local-embedded', localDbPath: path.join(legacy, 'local.db') });
    expect(repointLegacyLocalDb(cfg, [legacy], home)).toBe(false);
    expect(cfg.saved.localDbPath).toBe(path.join(legacy, 'local.db'));
  });

  it('does nothing when the environment is not a local graph', () => {
    fs.writeFileSync(path.join(home, 'local.db'), 'copied');
    const cfg = fakeConfig({ mode: 'auth', localDbPath: path.join(legacy, 'local.db') });
    expect(repointLegacyLocalDb(cfg, [legacy], home)).toBe(false);
  });

  it('a different file name in a legacy folder is not the graph, so it is left alone', () => {
    fs.writeFileSync(path.join(home, 'local.db'), 'copied');
    const other = path.join(legacy, 'notes.db');
    const cfg = fakeConfig({ mode: 'local-embedded', localDbPath: other });
    expect(repointLegacyLocalDb(cfg, [legacy], home)).toBe(false);
    expect(cfg.saved.localDbPath).toBe(other);
  });
});
