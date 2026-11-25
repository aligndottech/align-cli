/**
 * `align context sync` / `align up` with no terminal must not edit the user's CLAUDE.md unasked.
 * Reproduced on a tracked CLAUDE.md with stdin not a TTY: it printed "Added @DECISIONS.md import to CLAUDE.md" and edited it.
 * Test List:
 * 1. no terminal, no --approve: CLAUDE.md is byte-identical, the decisions file is still written, and the output says what
 *    would change and how to allow it
 * 2. no terminal, --approve: CLAUDE.md gains the import line
 * 3. a terminal, no --approve: CLAUDE.md gains the import line, as before
 * 4. no terminal, import already there: nothing to say, nothing changed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockListDecisions } = vi.hoisted(() => ({ mockListDecisions: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ listDecisions: mockListDecisions })) }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn(() => ({ mode: 'local-embedded', gatewayUrl: 'http://localhost:0' })) })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'local'), resolveImportEnv: vi.fn(() => 'local') }));
import { registerContextCommand } from '../commands/context.js';

const ROWS = [{ id: '1', title: 'Use Postgres instead of MySQL for the event store', summary: '', platform: 'docs', status: 'active', source_url: 'https://github.com/acme/api/blob/main/docs/adr/1.md' }];
const CLAUDE = '# Rules\n\nBe kind.\n';
const run = (...args: string[]) => { const p = new Command(); p.exitOverride(); registerContextCommand(p); return p.parseAsync(['node', 'align', 'context', 'sync', ...args]); };
const setTty = (v: boolean) => {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
};

let repo: string; let prevCwd: string; let logs: string[]; const prevIn = process.stdin.isTTY; const prevOut = process.stdout.isTTY;
const claudeMd = () => fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-notty-'));
  prevCwd = process.cwd(); process.chdir(repo);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  mockListDecisions.mockReset().mockResolvedValue(ROWS);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), CLAUDE);
  process.exitCode = undefined;
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: prevIn, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: prevOut, configurable: true });
  process.exitCode = undefined; process.chdir(prevCwd); fs.rmSync(repo, { recursive: true, force: true }); vi.restoreAllMocks();
});

describe('align context sync and CLAUDE.md', () => {
  it('with no terminal and no --approve leaves CLAUDE.md alone, still writes the file, and says how to allow the edit', async () => {
    setTty(false);
    await run();
    expect(claudeMd()).toBe(CLAUDE);
    expect(fs.existsSync(path.join(repo, '.align/decisions.md'))).toBe(true);
    const said = logs.join('\n');
    expect(said).not.toMatch(/Added/);
    expect(said).toContain('@.align/decisions.md');
    expect(said).toMatch(/CLAUDE\.md.*not changed|not changed.*CLAUDE\.md/is);
    expect(said).toContain('--approve');
  });

  it('with no terminal and --approve adds the import line', async () => {
    setTty(false);
    await run('--approve');
    expect(claudeMd()).toContain('@.align/decisions.md');
  });

  it('with a terminal and no flag adds the import line, as before', async () => {
    setTty(true);
    await run();
    expect(claudeMd()).toContain('@.align/decisions.md');
  });

  it('with no terminal and the import already there says nothing about an edit and changes nothing', async () => {
    setTty(false);
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), `${CLAUDE}\n@.align/decisions.md\n`);
    await run();
    expect(claudeMd()).toBe(`${CLAUDE}\n@.align/decisions.md\n`);
    expect(logs.join('\n')).not.toContain('--approve');
  });
});
