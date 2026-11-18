import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeGeminiHooks, writeOpenCodePlugin, writePiExtension } from '../lib/agent-rules.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'align-hooks-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const read = (rel: string): string => readFileSync(join(dir, rel), 'utf8');
const readJson = (rel: string): any => JSON.parse(read(rel));

describe('writePiExtension', () => {
  it('writes .pi/extensions/align.ts, where pi auto-discovers project extensions', () => {
    writePiExtension(dir);
    expect(read('.pi/extensions/align.ts')).toContain('export default');
  });

  // pre-check on tool_call, non-blocking delivery on tool_result: tool_call's only
  // channel is `block`, so the finding has to be replayed into the result content.
  it('subscribes to both tool_call and tool_result', () => {
    writePiExtension(dir);
    const ext = read('.pi/extensions/align.ts');
    expect(ext).toContain('"tool_call"');
    expect(ext).toContain('"tool_result"');
  });

  it('only fires on the file-mutating tools, not on reads or greps', () => {
    writePiExtension(dir);
    const ext = read('.pi/extensions/align.ts');
    expect(ext).toContain('edit');
    expect(ext).toContain('write');
    expect(ext).not.toContain('"grep"');
    expect(ext).not.toContain('"read"');
  });

  it('invokes the advisory check in pi output format', () => {
    writePiExtension(dir);
    const ext = read('.pi/extensions/align.ts');
    expect(ext).toContain('"--advisory"');
    expect(ext).toContain('"--format"');
    expect(ext).toContain('"pi"');
  });

  it('omits the default prod env so the committed extension stays portable', () => {
    writePiExtension(dir, 'prod');
    expect(read('.pi/extensions/align.ts')).not.toContain('--env');
  });

  it('encodes a non-prod env into the spawned args', () => {
    writePiExtension(dir, 'local');
    const ext = read('.pi/extensions/align.ts');
    expect(ext).toContain('"--env"');
    expect(ext).toContain('"local"');
  });

  it('is fully managed - a re-run replaces it rather than appending', () => {
    writePiExtension(dir);
    const first = read('.pi/extensions/align.ts');
    writePiExtension(dir);
    expect(read('.pi/extensions/align.ts')).toBe(first);
  });
});

describe('writeGeminiHooks', () => {
  it('registers BeforeTool and AfterTool in .gemini/settings.json', () => {
    writeGeminiHooks(dir);
    const hooks = readJson('.gemini/settings.json').hooks;
    expect(hooks.BeforeTool).toBeDefined();
    expect(hooks.AfterTool).toBeDefined();
  });

  it('matches only the file-mutating built-in tools', () => {
    writeGeminiHooks(dir);
    const matcher = readJson('.gemini/settings.json').hooks.BeforeTool[0].matcher;
    expect(matcher).toContain('write_file');
    expect(matcher).toContain('replace');
  });

  it('runs the advisory check in gemini output format', () => {
    writeGeminiHooks(dir);
    const cmd = readJson('.gemini/settings.json').hooks.AfterTool[0].hooks[0].command;
    expect(cmd).toContain('align check --advisory');
    expect(cmd).toContain('--format gemini');
  });

  it('preserves unrelated Gemini settings and other hook events', () => {
    mkdirSync(join(dir, '.gemini'), { recursive: true });
    writeFileSync(
      join(dir, '.gemini', 'settings.json'),
      JSON.stringify({ theme: 'Dracula', hooks: { SessionStart: [{ matcher: 'x' }] } }),
    );
    writeGeminiHooks(dir);
    const cfg = readJson('.gemini/settings.json');
    expect(cfg.theme).toBe('Dracula');
    expect(cfg.hooks.SessionStart[0]).toEqual({ matcher: 'x' });
    expect(cfg.hooks.BeforeTool).toBeDefined();
  });

  // Gemini's reference page (read 2026-11-18): SessionStart source is startup, resume or
  // clear, lifecycle matchers are exact strings, additionalContext is injected as the first turn.
  // There is no compact source and PreCompress cannot inject, so no compaction case exists.
  it('registers one exact-matcher SessionStart group per source, running `align context inject --format gemini`', () => {
    writeGeminiHooks(dir);
    const groups = readJson('.gemini/settings.json').hooks.SessionStart;
    expect(groups.map((g: any) => g.matcher)).toEqual(['startup', 'resume', 'clear']);
    for (const g of groups) expect(g.hooks[0].command).toBe('align context inject --format gemini');
  });

  it('keeps a user handler added beside ours, and a user\'s own bare `align context inject`', () => {
    writeGeminiHooks(dir);
    const cfg = readJson('.gemini/settings.json');
    cfg.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'my-own-linter' });
    const bare = { matcher: 'startup', hooks: [{ type: 'command', command: 'align context inject' }] };
    cfg.hooks.SessionStart.push(bare);
    writeFileSync(join(dir, '.gemini', 'settings.json'), JSON.stringify(cfg));
    writeGeminiHooks(dir);
    const groups = readJson('.gemini/settings.json').hooks.SessionStart;
    expect(groups.some((g: any) => g.hooks.some((h: any) => h.command === 'my-own-linter'))).toBe(true);
    expect(groups).toContainEqual(bare);
    const ours = groups.flatMap((g: any) => g.hooks).filter((h: any) => h.command === 'align context inject --format gemini');
    expect(ours).toHaveLength(3);
  });

  it('a re-run leaves the same three session groups and keeps the user\'s own', () => {
    mkdirSync(join(dir, '.gemini'), { recursive: true });
    writeFileSync(join(dir, '.gemini', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'x' }] } }));
    writeGeminiHooks(dir);
    writeGeminiHooks(dir, 'preview');
    const groups = readJson('.gemini/settings.json').hooks.SessionStart;
    expect(groups.map((g: any) => g.matcher)).toEqual(['x', 'startup', 'resume', 'clear']);
  });

  it('is idempotent - a re-run leaves exactly one align hook per event', () => {
    writeGeminiHooks(dir);
    writeGeminiHooks(dir);
    const hooks = readJson('.gemini/settings.json').hooks;
    expect(hooks.BeforeTool).toHaveLength(1);
    expect(hooks.AfterTool).toHaveLength(1);
  });

  it('replaces a stale align hook rather than stacking a second one on re-run', () => {
    writeGeminiHooks(dir, 'local');
    writeGeminiHooks(dir, 'preview');
    const before = readJson('.gemini/settings.json').hooks.BeforeTool;
    expect(before).toHaveLength(1);
    expect(before[0].hooks[0].command).toContain('--env preview');
  });

  it('omits the default prod env from the committed command', () => {
    writeGeminiHooks(dir, 'prod');
    expect(readJson('.gemini/settings.json').hooks.AfterTool[0].hooks[0].command).not.toContain('--env');
  });

  it('throws rather than clobbering a settings.json containing invalid JSON', () => {
    mkdirSync(join(dir, '.gemini'), { recursive: true });
    writeFileSync(join(dir, '.gemini', 'settings.json'), 'not json{{{');
    expect(() => writeGeminiHooks(dir)).toThrow('invalid JSON');
    expect(read('.gemini/settings.json')).toBe('not json{{{');
  });
});

// The extension ships as a string literal, so a syntax error in it would surface only
// inside a user's pi session, at load, taking the session with it. Parse it here.
describe('the generated pi extension is valid TypeScript', () => {
  it('parses with zero syntactic diagnostics', async () => {
    const ts = (await import('typescript')).default;
    writePiExtension(dir, 'local');
    const source = read('.pi/extensions/align.ts');
    const sf = ts.createSourceFile('align.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    // Positive control: the same parser MUST report a problem on known-broken input,
    // or "zero diagnostics" only proves the check is inert.
    const broken = ts.createSourceFile('b.ts', 'export default function ( {', ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    expect((broken as any).parseDiagnostics.length, 'positive control').toBeGreaterThan(0);
    expect((sf as any).parseDiagnostics).toEqual([]);
  });
});

describe('writeOpenCodePlugin', () => {
  it('writes .opencode/plugins/align.js, where OpenCode auto-discovers project plugins', () => {
    writeOpenCodePlugin(dir);
    expect(read('.opencode/plugins/align.js')).toContain('export const');
  });

  // before blocks by THROWING (it runs ahead of item.execute); after mutates the result
  // object the caller returns to the model. Both halves are needed.
  it('subscribes to both tool.execute.before and tool.execute.after', () => {
    writeOpenCodePlugin(dir);
    const p = read('.opencode/plugins/align.js');
    expect(p).toContain('"tool.execute.before"');
    expect(p).toContain('"tool.execute.after"');
  });

  it('only fires on the file-mutating tools', () => {
    writeOpenCodePlugin(dir);
    const p = read('.opencode/plugins/align.js');
    expect(p).toContain('edit');
    expect(p).toContain('write');
    expect(p).toContain('apply_patch');
    expect(p).not.toContain('"grep"');
    expect(p).not.toContain('"webfetch"');
  });

  it('invokes the advisory check in opencode output format', () => {
    writeOpenCodePlugin(dir);
    const p = read('.opencode/plugins/align.js');
    expect(p).toContain('--advisory');
    expect(p).toContain('opencode');
  });

  it('omits the default prod env so the committed plugin stays portable', () => {
    writeOpenCodePlugin(dir, 'prod');
    expect(read('.opencode/plugins/align.js')).not.toContain('--env');
  });

  it('encodes a non-prod env into the spawned args', () => {
    writeOpenCodePlugin(dir, 'local');
    const p = read('.opencode/plugins/align.js');
    expect(p).toContain('--env');
    expect(p).toContain('local');
  });

  it('is fully managed - a re-run replaces it rather than appending', () => {
    writeOpenCodePlugin(dir);
    const first = read('.opencode/plugins/align.js');
    writeOpenCodePlugin(dir);
    expect(read('.opencode/plugins/align.js')).toBe(first);
  });
});

// Same reasoning as the pi extension: it ships as a string literal, so a syntax error
// would surface only inside a user's OpenCode session, at plugin load.
describe('the generated OpenCode plugin is valid JavaScript', () => {
  it('parses with zero syntactic diagnostics', async () => {
    const ts = (await import('typescript')).default;
    writeOpenCodePlugin(dir, 'local');
    const source = read('.opencode/plugins/align.js');
    const sf = ts.createSourceFile('align.js', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const broken = ts.createSourceFile('b.js', 'export const X = async ({ => {', ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    expect((broken as any).parseDiagnostics.length, 'positive control').toBeGreaterThan(0);
    expect((sf as any).parseDiagnostics).toEqual([]);
  });
});
