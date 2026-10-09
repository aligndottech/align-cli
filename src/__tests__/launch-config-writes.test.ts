import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyConfigWrite, type ConfigWrite } from '../lib/launch/config-writes.js';
import { BACKUP_SUFFIX } from '../lib/safe-config-write.js';

/*
 * C4 Test List (the one place pi / Cursor config is written):
 *  1. mcp-entry into a missing file: created, one disclosure line naming file, backup path and --undo
 *  2. mcp-entry into an existing file: other servers kept, original in .align-backup
 *  3. entry already present (ours, edited by the user): untouched, no line, no backup (two shapes)
 *  4. a symlinked file (the pi case): one line naming link and target, target bytes untouched
 *  5. cursor-hooks: written once into hooks.json with the user's hook kept; a team hook is left alone with the notice
 */
let dir: string;
let lines: string[];
const note = (l: string) => lines.push(l);
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'align-cw-')); lines = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const entryWrite = (file: string): ConfigWrite => ({ kind: 'mcp-entry', file, topKey: 'mcpServers', name: 'align-local', entry: { command: 'align', args: ['mcp', '--env', 'local'] } });
const put = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

describe('applyConfigWrite: mcp-entry', () => {
  it('creates a missing file and says what it did and how to undo it', () => {
    const f = path.join(dir, 'agent', 'mcp.json');
    applyConfigWrite(entryWrite(f), note);
    expect(JSON.parse(readFileSync(f, 'utf8')).mcpServers['align-local'].args).toEqual(['mcp', '--env', 'local']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(f);
    expect(lines[0]).toContain(`${f}${BACKUP_SUFFIX}`);
    expect(lines[0]).toContain('align use --undo');
  });

  it('keeps the other servers and the original bytes in the backup', () => {
    const f = path.join(dir, 'mcp.json');
    const original = '{ "mcpServers": { "linear": { "command": "l" } }, "settings": { "x": 1 } }\n';
    put(f, original);
    applyConfigWrite(entryWrite(f), note);
    const now = JSON.parse(readFileSync(f, 'utf8'));
    expect(Object.keys(now.mcpServers).sort()).toEqual(['align-local', 'linear']);
    expect(now.settings).toEqual({ x: 1 });
    expect(readFileSync(f + BACKUP_SUFFIX, 'utf8')).toBe(original);
  });

  it.each([
    ['their edited entry', JSON.stringify({ mcpServers: { 'align-local': { command: 'custom' } } })],
    ['an empty entry', JSON.stringify({ mcpServers: { 'align-local': {} } })],
  ])('never touches an entry that is already there (%s)', (_n, text) => {
    const f = path.join(dir, 'mcp.json');
    put(f, text);
    applyConfigWrite(entryWrite(f), note);
    expect(readFileSync(f, 'utf8')).toBe(text);
    expect(lines).toEqual([]);
    expect(() => readFileSync(f + BACKUP_SUFFIX)).toThrow();
  });

  it('refuses a symlinked mcp.json (pi\'s case): one line naming link and target, target untouched', () => {
    const real = path.join(dir, 'clank', 'mcp.json');
    put(real, '{"mcpServers":{"clank":{}}}');
    const link = path.join(dir, 'pi', 'agent', 'mcp.json');
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(real, link);
    applyConfigWrite(entryWrite(link), note);
    expect(readFileSync(real, 'utf8')).toBe('{"mcpServers":{"clank":{}}}');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(link);
    expect(lines[0]).toContain(real);
  });

  it('throws on a file that is not JSON and leaves it alone', () => {
    const f = path.join(dir, 'mcp.json');
    put(f, '{ nope');
    expect(() => applyConfigWrite(entryWrite(f), note)).toThrow('invalid JSON');
    expect(readFileSync(f, 'utf8')).toBe('{ nope');
  });
});

describe('applyConfigWrite: cursor-hooks', () => {
  it('adds the pre and post check once, keeps the user\'s hook, backs up', () => {
    const f = path.join(dir, 'hooks.json');
    const original = JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'mine' }] } });
    put(f, original);
    applyConfigWrite({ kind: 'cursor-hooks', file: f }, note);
    const hooks = JSON.parse(readFileSync(f, 'utf8')).hooks;
    expect(hooks.preToolUse.map((h: { command: string }) => h.command)).toEqual(['mine', 'align check --advisory --format cursor --env local']);
    expect(hooks.postToolUse).toHaveLength(1);
    expect(readFileSync(f + BACKUP_SUFFIX, 'utf8')).toBe(original);
    expect(lines.join('\n')).toContain('align use --undo');
  });

  it('leaves a team hook alone and says how to change it', () => {
    const f = path.join(dir, 'hooks.json');
    const team = JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'align check --advisory --format cursor' }] } });
    put(f, team);
    applyConfigWrite({ kind: 'cursor-hooks', file: f }, note);
    expect(readFileSync(f, 'utf8')).toBe(team);
    expect(lines.join('\n')).toContain('Left the existing align entry');
    expect(lines.join('\n')).not.toContain('Added');
  });
});
