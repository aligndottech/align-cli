import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHookPayload } from '../lib/hook-payload.js';
import { proposedChangeText } from '../lib/agent/edit-text.js';
import { alignClaudeHooks, openCodePluginBody, piExtensionBody } from '../lib/agent-rules.js';

/**
 * Where does the pre-edit check fire? One test per cell of docs/hook-coverage.md that says
 * "fires". The evidence for each cell is a payload the host really sent, captured with a
 * `tee` style hook or a recording plugin (see _capture in each file). A cell with no capture
 * is "not tested" in the docs and has no test here: the last describe block fails the build if
 * the docs claim "fires" for a cell that has no capture file, or if a capture is not cited.
 *
 * "Fires" is asserted in three parts, because a payload alone proves the host called a hook
 * and nothing about whether align would act on it:
 *   1. the host sent the payload for the right actor (main agent, or a subagent),
 *   2. the matcher or tool filter align installs for that host accepts the tool,
 *   3. the payload the shim pipes normalises to non-empty proposed text.
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hook-payloads', 'by-cell');
const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Record<string, unknown>;
const matches = (matcher: string, tool: string): boolean => new RegExp(`^(?:${matcher})$`).test(tool);
const setOf = (body: string): string[] => {
  const m = /MUTATING_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(body);
  if (!m) throw new Error('no MUTATING_TOOLS in the shim body');
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
};

describe('Claude Code, headless main agent (claude -p, 2.1.326)', () => {
  const p = load('claude-code-headless-main-pre');
  it('sent a PreToolUse for the Edit, with no subagent identity', () => {
    expect(p['hook_event_name']).toBe('PreToolUse');
    expect(p['tool_name']).toBe('Edit');
    expect(p).not.toHaveProperty('agent_id');
  });
  it("the matcher align installs accepts the tool", () => {
    const group = alignClaudeHooks().PreToolUse[0] as { matcher: string };
    expect(matches(group.matcher, p['tool_name'] as string)).toBe(true);
  });
  it('normalises to the proposed text', () => {
    expect(proposedChangeText(normalizeHookPayload(p)?.tool_input)).toBe('export const A = 2;');
  });
});

describe('Claude Code, subagent edit in a headless run (claude -p, 2.1.326)', () => {
  const p = load('claude-code-headless-subagent-pre');
  it('sent a PreToolUse that names the subagent that made the edit', () => {
    expect(p['hook_event_name']).toBe('PreToolUse');
    expect(p['tool_name']).toBe('Edit');
    expect(p['agent_id']).toMatch(/^a[0-9a-f]{8,}$/);
    expect(p['agent_id']).not.toBe((load('claude-code-headless-main-pre'))['agent_id']);
    expect(p['agent_type']).toBe('general-purpose');
  });
  it('the matcher align installs accepts the tool', () => {
    const group = alignClaudeHooks().PreToolUse[0] as { matcher: string };
    expect(matches(group.matcher, p['tool_name'] as string)).toBe(true);
  });
  it('normalises to the proposed text', () => {
    expect(proposedChangeText(normalizeHookPayload(p)?.tool_input)).toBe('export const B = 2;');
  });
});

// The plugin hook receives (input, output): the tool name and ids in `input`, the tool's own
// arguments in `output.args`. The shim pipes {type, tool, args} to align (openCodePluginBody).
const opencodePiped = (p: Record<string, unknown>) => {
  const input = p['input'] as { tool: string };
  const output = p['output'] as { args: Record<string, unknown> };
  return { type: 'tool.execute.before', tool: input.tool, args: output.args };
};

describe('OpenCode, headless main agent (opencode run, 1.18.27)', () => {
  const p = load('opencode-headless-main-pre');
  it('the shim filter accepts the tool, and the payload normalises to the proposed text', () => {
    expect(setOf(openCodePluginBody())).toContain((p['input'] as { tool: string }).tool);
    expect(proposedChangeText(normalizeHookPayload(opencodePiped(p))?.tool_input)).toBe('export const A = 2;');
  });
});

describe('OpenCode, subagent edit in a headless run (opencode run, 1.18.27)', () => {
  const task = load('opencode-headless-subagent-task-pre');
  const edit = load('opencode-headless-subagent-edit-pre');
  it('the edit ran in a different session from the one that called the task tool', () => {
    expect((task['input'] as { tool: string }).tool).toBe('task');
    const parent = (task['input'] as { sessionID: string }).sessionID;
    const child = (edit['input'] as { sessionID: string }).sessionID;
    expect(child).not.toBe(parent);
  });
  it('the plugin hook still fired for it: the shim filter accepts the tool and the text normalises', () => {
    expect(setOf(openCodePluginBody())).toContain((edit['input'] as { tool: string }).tool);
    expect(proposedChangeText(normalizeHookPayload(opencodePiped(edit))?.tool_input)).toBe('export const B = 2;');
  });
});

describe('pi, headless main agent (pi -p, 1.2.0)', () => {
  const p = load('pi-headless-main-pre');
  it('the extension ran in print mode with no UI', () => {
    const ctx = (p['_capture'] as { ctx: { mode: string; hasUI: boolean } }).ctx;
    expect(ctx).toEqual({ mode: 'print', hasUI: false });
  });
  it('the shim filter accepts the tool, and the payload normalises to the proposed text', () => {
    expect(setOf(piExtensionBody())).toContain(p['toolName'] as string);
    const piped = { type: p['type'], toolName: p['toolName'], input: p['input'] };
    expect(proposedChangeText(normalizeHookPayload(piped)?.tool_input)).toBe('export const A = 2;');
  });
});

describe('docs/hook-coverage.md only claims what a capture proves', () => {
  const docs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'hook-coverage.md'), 'utf8');
  const hosts = ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'pi', 'OpenCode'];
  const rows = docs.split('\n').filter((l) => /^\| \*\*/.test(l));
  const cellsOf = (row: string): string[] => row.split('|').slice(1, -1).map((c) => c.trim());

  it('has one row per host and three cells after the name', () => {
    expect(rows.map((r) => cellsOf(r)[0]?.replace(/\*/g, ''))).toEqual(hosts);
    for (const r of rows) expect(cellsOf(r)).toHaveLength(4);
  });

  it('opens every cell with fires, does not fire or not tested', () => {
    for (const r of rows) for (const c of cellsOf(r).slice(1)) expect(c).toMatch(/^(fires|does not fire|not tested)\b/);
  });

  it('cites an existing capture for every fires cell, and none for the others', () => {
    for (const r of rows) {
      for (const c of cellsOf(r).slice(1)) {
        const cited = [...c.matchAll(/by-cell\/([a-z0-9-]+)\.json/g)].map((m) => m[1]!);
        if (c.startsWith('fires')) {
          expect(cited.length, `${c} cites no capture`).toBeGreaterThan(0);
          for (const f of cited) expect(existsSync(join(dir, `${f}.json`)), `${f} is missing`).toBe(true);
        } else {
          expect(cited, `${c} cites a capture but is not a fires cell`).toEqual([]);
        }
      }
    }
  });

  // The columns are actors and run modes, so a capture has to sit under the column it proves.
  it('keeps each capture under its own column', () => {
    for (const r of rows) {
      const [, interactive, subagent, headless] = cellsOf(r);
      const names = (c: string): string[] => [...c.matchAll(/by-cell\/([a-z0-9-]+)\.json/g)].map((m) => m[1]!);
      expect(names(interactive!), 'no interactive capture exists').toEqual([]);
      for (const n of names(subagent!)) expect(n).toContain('-subagent-');
      for (const n of names(headless!)) expect(n).toContain('-headless-main-');
    }
  });

  it('cites every capture file, so none sits unexplained', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) expect(docs).toContain(`by-cell/${f}`);
  });

  it('names the PR check as the fallback', () => {
    expect(docs).toMatch(/PR check/);
  });
});
