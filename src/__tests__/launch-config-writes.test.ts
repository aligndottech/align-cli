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
 *  5. the hint line (once), a linked agent dir refused, a refusal remembered, the invalid-JSON advice
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

describe('applyConfigWrite: hint, symlinked dirs, remembered refusals', () => {
  it('prints the hint line once, after the first write only', () => {
    const f = path.join(dir, 'mcp.json');
    const w = { ...entryWrite(f), hint: 'Approve it once: agent mcp enable align-local' };
    applyConfigWrite(w, note);
    expect(lines[lines.length - 1]).toBe('Approve it once: agent mcp enable align-local');
    lines.length = 0;
    applyConfigWrite(w, note);
    expect(lines).toEqual([]);
  });

  it('refuses a linked agent dir (this machine\'s ~/.pi/agent -> ~/.clank/agent), naming the link', () => {
    const real = path.join(dir, 'clank-agent');
    put(path.join(real, 'mcp.json'), '{"mcpServers":{"clank":{}}}');
    symlinkSync(real, path.join(dir, 'agent'));
    applyConfigWrite({ ...entryWrite(path.join(dir, 'agent', 'mcp.json')), root: dir }, note);
    expect(readFileSync(path.join(real, 'mcp.json'), 'utf8')).toBe('{"mcpServers":{"clank":{}}}');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(path.join(dir, 'agent'));
  });

  it('remembers a refused write: the second launch is silent and does not even look (two launches)', () => {
    const real = path.join(dir, 'other.json');
    put(real, '{}');
    const link = path.join(dir, 'mcp.json');
    symlinkSync(real, link);
    const seen = new Set<string>();
    const memo = { has: (f: string) => seen.has(f), add: (f: string) => { seen.add(f); } };
    applyConfigWrite(entryWrite(link), note, memo);
    applyConfigWrite(entryWrite(link), note, memo);
    applyConfigWrite(entryWrite(link), note, memo);
    expect(lines).toHaveLength(1);
    expect(seen.has(link)).toBe(true);
  });

  it('a write that was NOT refused is not remembered', () => {
    const seen = new Set<string>();
    applyConfigWrite(entryWrite(path.join(dir, 'ok.json')), note, { has: () => false, add: (f) => { seen.add(f); } });
    expect(seen.size).toBe(0);
  });

  it('the invalid-JSON error does not send the user to `align mcp --setup`', () => {
    const f = path.join(dir, 'mcp.json');
    put(f, '{ nope');
    expect(() => applyConfigWrite(entryWrite(f), note)).toThrow(/then run align again/);
    expect(() => applyConfigWrite(entryWrite(f), note)).not.toThrow(/mcp --setup/);
  });
});
