import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeMcpConfig, writeMcpConfig } from '../lib/mcp-setup.js';

/**
 * ALI-776. Setup wires detected agents automatically rather than asking, on the grounds that
 * the write is additive and an agent reading your graph is the whole product. That trade only
 * holds if there is a real undo - "you can hand-edit the JSON" is not one.
 */
describe('removeMcpConfig', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-rm-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const jsonTarget = (name: string, format: 'mcpServers' | 'vscode' | 'zed' = 'mcpServers') =>
    ({ name, configPath: path.join(dir, `${name}.json`), format }) as never;

  it('removes only our entry and leaves every other server alone', () => {
    const t = jsonTarget('cursor');
    fs.writeFileSync(t.configPath, JSON.stringify({
      mcpServers: {
        github: { command: 'gh-mcp' },
        postgres: { command: 'pg-mcp', args: ['--dsn', 'x'] },
      },
      someOtherSetting: true,
    }, null, 2));

    writeMcpConfig(t, 'local');
    expect(Object.keys(JSON.parse(fs.readFileSync(t.configPath, 'utf8')).mcpServers)).toContain('align');

    const removed = removeMcpConfig(t);
    expect(removed).toBe(true);
    const after = JSON.parse(fs.readFileSync(t.configPath, 'utf8'));
    expect(after.mcpServers).toEqual({
      github: { command: 'gh-mcp' },
      postgres: { command: 'pg-mcp', args: ['--dsn', 'x'] },
    });
    // Everything outside our key survives - this is the promise that makes an automatic
    // write acceptable in the first place.
    expect(after.someOtherSetting).toBe(true);
  });

  it('reports false when there is nothing of ours to remove', () => {
    const t = jsonTarget('cursor');
    fs.writeFileSync(t.configPath, JSON.stringify({ mcpServers: { github: { command: 'gh' } } }));
    expect(removeMcpConfig(t)).toBe(false);
  });

  it('reports false rather than throwing when the file does not exist', () => {
    expect(removeMcpConfig(jsonTarget('nope'))).toBe(false);
  });

  it('uses the right top-level key per format', () => {
    for (const [format, key] of [['vscode', 'servers'], ['zed', 'context_servers']] as const) {
      const t = jsonTarget(`x-${format}`, format);
      writeMcpConfig(t, 'local');
      expect(JSON.parse(fs.readFileSync(t.configPath, 'utf8'))[key].align).toBeTruthy();
      expect(removeMcpConfig(t)).toBe(true);
      expect(JSON.parse(fs.readFileSync(t.configPath, 'utf8'))[key].align).toBeUndefined();
    }
  });

  it('splices the fenced block out of a codex TOML and keeps the rest', () => {
    const t = { name: 'Codex', configPath: path.join(dir, 'config.toml'), format: 'codex' } as never;
    fs.writeFileSync(t.configPath, 'model = "gpt-5"\n');
    writeMcpConfig(t, 'local');
    expect(fs.readFileSync(t.configPath, 'utf8')).toMatch(/align/);

    expect(removeMcpConfig(t)).toBe(true);
    const after = fs.readFileSync(t.configPath, 'utf8');
    expect(after).toMatch(/model = "gpt-5"/);
    expect(after).not.toMatch(/align/);
  });

  // Refusing to touch a file we cannot parse is the same rule writeJsonConfig follows: a
  // remove that rewrote a broken config would destroy whatever the user was mid-way through.
  it('throws rather than rewriting a config it cannot parse', () => {
    const t = jsonTarget('broken');
    fs.writeFileSync(t.configPath, '{ this is not json');
    expect(() => removeMcpConfig(t)).toThrow();
    expect(fs.readFileSync(t.configPath, 'utf8')).toBe('{ this is not json');
  });
});
