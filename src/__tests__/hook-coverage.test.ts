import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// Every "fires" test records the capture it replayed, so the docs guard below can require that
// a cited capture was actually replayed and not merely present on disk.
const replayed = new Set<string>();

/**
 * Run the plugin or extension align really writes against a capture, with a stand-in `align`
 * on PATH that records the stdin it is given. This reads what the generated handler SENDS,
 * so a handler that stops forwarding the tool arguments fails here. POSIX only: on Windows the
 * handler spawns `cmd /c align`, which a PATH stub cannot stand in for.
 */
async function sentByHandler(file: string, source: string, call: (mod: Record<string, unknown>) => Promise<void>): Promise<unknown> {
  const work = mkdtempSync(join(tmpdir(), 'align-hook-coverage-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  const record = join(work, 'stdin.json');
  writeFileSync(join(bin, 'align'), `#!/bin/sh\ncat > '${record}'\n`);
  chmodSync(join(bin, 'align'), 0o755);
  const plugin = join(work, file);
  writeFileSync(plugin, source);
  const savedPath = process.env['PATH'];
  process.env['PATH'] = `${bin}${delimiter}${savedPath ?? ''}`;
  try {
    await call((await import(/* @vite-ignore */ pathToFileURL(plugin).href)) as Record<string, unknown>);
  } finally {
    process.env['PATH'] = savedPath;
  }
  return JSON.parse(readFileSync(record, 'utf8'));
}
const posix = process.platform !== 'win32';

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
    replayed.add('claude-code-headless-main-pre');
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
    replayed.add('claude-code-headless-subagent-pre');
  });
});

// The plugin hook receives (input, output): the tool name and ids in `input`, the tool's own
// arguments in `output.args`. The captures are of that pair, so each is replayed through the
// plugin align writes.
type OcCapture = { event: string; input: { tool: string; sessionID: string; callID: string }; output: { args: Record<string, unknown> } };
const replayOpenCode = async (file: string, p: OcCapture): Promise<unknown> =>
  sentByHandler('align.mjs', openCodePluginBody(), async (mod) => {
    const hooks = await (mod['AlignPlugin'] as () => Promise<Record<string, (i: unknown, o: unknown) => Promise<void>>>)();
    await hooks['tool.execute.before']!(p.input, p.output);
  }).then((sent) => {
    replayed.add(file);
    return sent;
  });

describe.skipIf(!posix)('OpenCode, headless main agent (opencode run, 1.18.27)', () => {
  const p = load('opencode-headless-main-pre') as unknown as OcCapture;
  it('was captured at tool.execute.before, the pre-edit event', () => {
    expect(p.event).toBe('tool.execute.before');
  });
  it('the plugin sends the edit to align, and it normalises to the proposed text', async () => {
    const sent = await replayOpenCode('opencode-headless-main-pre', p);
    expect(proposedChangeText(normalizeHookPayload(sent)?.tool_input)).toBe('export const A = 2;');
  });
});

describe.skipIf(!posix)('OpenCode, subagent edit in a headless run (opencode run, 1.18.27)', () => {
  const task = load('opencode-headless-subagent-task-pre') as unknown as OcCapture;
  const edit = load('opencode-headless-subagent-edit-pre') as unknown as OcCapture;
  it('both were captured at tool.execute.before', () => {
    expect(task.event).toBe('tool.execute.before');
    expect(edit.event).toBe('tool.execute.before');
  });
  // The capture is of the before-hook only, so it does not record which child session the task
  // call started. What it does show is an edit that reached the hook from a session other than
  // the one that called the task tool, which is what a subagent's edit looks like.
  it('the edit came from a session other than the one that called the task tool', () => {
    expect(task.input.tool).toBe('task');
    expect(task.input.sessionID).not.toBe('');
    expect(edit.input.sessionID).not.toBe('');
    expect(edit.input.sessionID).not.toBe(task.input.sessionID);
  });
  it('the plugin sends the edit to align, and it normalises to the proposed text', async () => {
    const sent = await replayOpenCode('opencode-headless-subagent-edit-pre', edit);
    expect(proposedChangeText(normalizeHookPayload(sent)?.tool_input)).toBe('export const B = 2;');
    replayed.add('opencode-headless-subagent-task-pre');
  });
});

describe.skipIf(!posix)('pi, headless main agent (pi -p, 1.2.0)', () => {
  const p = load('pi-headless-main-pre');
  it('was captured at tool_call, the pre-edit event, and records print mode with no UI', () => {
    expect(p['type']).toBe('tool_call');
    const ctx = (p['_capture'] as { ctx: { mode: string; hasUI: boolean } }).ctx;
    expect(ctx).toEqual({ mode: 'print', hasUI: false });
  });
  it('the extension sends the edit to align, and it normalises to the proposed text', async () => {
    const sent = await sentByHandler('align.ts', piExtensionBody(), async (mod) => {
      const handlers = new Map<string, (e: unknown) => Promise<unknown>>();
      (mod['default'] as (pi: { on: (n: string, h: (e: unknown) => Promise<unknown>) => void }) => void)({ on: (n, h) => handlers.set(n, h) });
      await handlers.get('tool_call')!(p);
    });
    expect(proposedChangeText(normalizeHookPayload(sent)?.tool_input)).toBe('export const A = 2;');
    replayed.add('pi-headless-main-pre');
  });
});

describe('docs/hook-coverage.md only claims what a capture proves', () => {
  const docs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'hook-coverage.md'), 'utf8');
  const hosts = ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'pi', 'OpenCode'];
  const lines = docs.split('\n');
  const rows = lines.filter((l) => /^\| \*\*/.test(l));
  const cellsOf = (row: string): string[] => row.split('|').slice(1, -1).map((c) => c.trim());
  const namesIn = (c: string): string[] => [...c.matchAll(/by-cell\/([a-z0-9-]+)\.json/g)].map((m) => m[1]!);
  const hostOf = (name: string): string => (load(name)['_capture'] as { host: string }).host;

  it('has the expected column order, so the tests below can read columns by position', () => {
    const header = lines.find((l) => l.startsWith('| Host |'));
    expect(cellsOf(header!)).toEqual(['Host', 'Main agent, interactive session', 'Subagent', 'Headless or SDK run']);
  });

  it('has one row per host and three cells after the name', () => {
    expect(rows.map((r) => cellsOf(r)[0]?.replace(/\*/g, ''))).toEqual(hosts);
    for (const r of rows) expect(cellsOf(r)).toHaveLength(4);
  });

  it('opens every cell with fires, does not fire or not tested', () => {
    for (const r of rows) for (const c of cellsOf(r).slice(1)) expect(c).toMatch(/^(fires|does not fire|not tested)\b/);
  });

  it('cites an existing capture of the row host for every fires cell, and none for the others', () => {
    for (const r of rows) {
      const [host, ...cells] = cellsOf(r);
      for (const c of cells) {
        const cited = namesIn(c);
        if (c.startsWith('fires')) {
          expect(cited.length, `${c} cites no capture`).toBeGreaterThan(0);
          for (const f of cited) {
            expect(existsSync(join(dir, `${f}.json`)), `${f} is missing`).toBe(true);
            expect(hostOf(f), `${f} is a capture of another host`).toBe(host!.replace(/\*/g, ''));
          }
        } else {
          expect(cited, `${c} cites a capture but is not a fires cell`).toEqual([]);
        }
      }
    }
  });

  // The columns are actors and run modes, so a capture has to sit under the column it proves.
  // The interactive column has no capture today: add one only together with a change to this check.
  it('keeps each capture under its own column', () => {
    for (const r of rows) {
      const [, interactive, subagent, headless] = cellsOf(r);
      expect(namesIn(interactive!), 'no interactive capture exists yet').toEqual([]);
      for (const n of namesIn(subagent!)) expect(n).toContain('-subagent-');
      for (const n of namesIn(headless!)) expect(n).toContain('-headless-main-');
    }
  });

  // Skipped on Windows with the handler replays, so only assert it where they ran.
  it.skipIf(!posix)('replayed every capture a cell cites', () => {
    const cited = rows.flatMap((r) => cellsOf(r).slice(1).flatMap(namesIn));
    for (const n of cited) expect(replayed.has(n), `${n} is cited but no test replayed it`).toBe(true);
  });

  it('cites every capture file in a table cell, so none sits unexplained', () => {
    const cited = new Set(rows.flatMap((r) => cellsOf(r).slice(1).flatMap(namesIn)));
    const onDisk = readdirSync(dir).filter((x) => x.endsWith('.json')).map((x) => x.replace(/\.json$/, ''));
    expect([...cited].sort()).toEqual(onDisk.sort());
  });

  it('names the PR check as the fallback', () => {
    expect(docs).toMatch(/PR check/);
  });
});
