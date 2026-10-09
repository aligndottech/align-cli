import { describe, expect, it } from 'vitest';
import { isCanonicalLocalEntry, stripJsonComments } from '../lib/launch/strict-entry.js';

/*
 * Wave A review fix: a server counts as "Align is already here" ONLY when it is exactly align's
 * own local shape. Anything else in a repo file is untrusted input. Shapes per host:
 *  - mcpServers (Gemini): { command, args } and nothing else
 *  - codex: the same, plus `enabled = true` (enabled = false is not running)
 *  - copilot: { type: local|stdio, command, args, tools: ['*'] }
 * win32: only the `cmd /c align ...` wrapper (a bare `align` cannot spawn align.cmd).
 */
const LOCAL = ['mcp', '--env', 'local'];
const linux = { localIsDefault: false, platform: 'linux' };
const canon = (e: unknown, o: Partial<{ localIsDefault: boolean; platform: string; host: 'mcpServers' | 'codex' | 'copilot' }> = {}) =>
  isCanonicalLocalEntry(e, { ...linux, host: 'mcpServers', ...o });

describe('isCanonicalLocalEntry', () => {
  it('align mcp --env local is canonical; align mcp only when local is this machine\'s default', () => {
    expect(canon({ command: 'align', args: LOCAL })).toBe(true);
    expect(canon({ command: 'align', args: ['mcp'] })).toBe(false);
    expect(canon({ command: 'align', args: ['mcp'] }, { localIsDefault: true })).toBe(true);
  });

  it('another graph, extra args or a different command are not canonical', () => {
    expect(canon({ command: 'align', args: ['mcp', '--env', 'prod'] })).toBe(false);
    expect(canon({ command: 'align', args: [...LOCAL, '--verbose'] })).toBe(false);
    expect(canon({ command: 'sh', args: ['-c', 'evil', 'align', 'mcp'] }, { localIsDefault: true })).toBe(false);
    expect(canon({ command: '/tmp/align', args: LOCAL })).toBe(false);
  });

  it.each([['env', { PATH: 'x' }], ['cwd', '/x'], ['url', 'https://e.test'], ['envFile', '.env'], ['timeout', 5]])('an extra %s key is not canonical', (k, v) => {
    expect(canon({ command: 'align', args: LOCAL, [k]: v })).toBe(false);
  });

  it('win32: only the cmd /c wrapper counts; a bare align (the committed .mcp.json shape) does not', () => {
    const win = { platform: 'win32' };
    expect(canon({ command: 'cmd', args: ['/c', 'align', ...LOCAL] }, win)).toBe(true);
    expect(canon({ command: 'align', args: LOCAL }, win)).toBe(false);
    expect(canon({ command: 'cmd', args: ['/c', 'align', ...LOCAL] }, linux)).toBe(false);
  });

  it('codex: enabled = true is fine, enabled = false is not running', () => {
    expect(canon({ command: 'align', args: LOCAL, enabled: true }, { host: 'codex' })).toBe(true);
    expect(canon({ command: 'align', args: LOCAL, enabled: false }, { host: 'codex' })).toBe(false);
    expect(canon({ command: 'align', args: LOCAL, enabled: true }, { host: 'mcpServers' })).toBe(false);
  });

  it('copilot: needs type local (or stdio) and tools exactly ["*"]', () => {
    const cp = { host: 'copilot' as const };
    expect(canon({ type: 'local', command: 'align', args: LOCAL, tools: ['*'] }, cp)).toBe(true);
    expect(canon({ type: 'stdio', command: 'align', args: LOCAL, tools: ['*'] }, cp)).toBe(true);
    expect(canon({ type: 'http', command: 'align', args: LOCAL, tools: ['*'] }, cp)).toBe(false);
    expect(canon({ type: 'local', command: 'align', args: LOCAL, tools: ['align_ask'] }, cp)).toBe(false);
    expect(canon({ type: 'local', command: 'align', args: LOCAL }, cp)).toBe(false);
  });

  it('non-objects are not canonical', () => {
    for (const e of [null, undefined, 'align mcp', ['align', 'mcp'], 1]) expect(canon(e)).toBe(false);
  });
});

describe('stripJsonComments (Gemini parses its JSON files through strip-json-comments)', () => {
  it('removes line and block comments', () => {
    expect(JSON.parse(stripJsonComments('// head\n{ "a": 1, /* mid */ "b": 2 } // tail'))).toEqual({ a: 1, b: 2 });
  });
  it('keeps comment-like text inside strings, including after an escaped quote', () => {
    expect(JSON.parse(stripJsonComments('{ "u": "http://x/*y*/", "q": "a\\"//b" } // c'))).toEqual({ u: 'http://x/*y*/', q: 'a"//b' });
  });
  it('leaves plain JSON byte-identical', () => {
    const plain = '{ "a": [1, 2], "b": "c" }';
    expect(stripJsonComments(plain)).toBe(plain);
  });
});
