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

// One replay per capture a docs cell may cite. The docs guard at the bottom runs the cited
// replays itself, so it does not depend on the other blocks having run first (a `-t` filter
// would otherwise leave it checking an empty registry).
const REPLAYS: Record<string, () => Promise<void>> = {};
const register = (names: string[], replay: () => Promise<void>): (() => Promise<void>) => {
  for (const n of names) REPLAYS[n] = replay;
  return replay;
};

/**
 * Run the plugin or extension align really writes against a capture, with a stand-in `align`
 * on PATH that records its arguments and the stdin it is given. This reads what the generated
 * handler SENDS, so a handler that stops forwarding the tool arguments, or runs another
 * command, fails here. The stub finds its record files from its own location, so no path is
 * interpolated into shell source. POSIX only: on Windows the handler spawns `cmd /c align`,
 * which a PATH stub cannot stand in for.
 */
async function sentByHandler(
  file: string,
  source: string,
  call: (mod: Record<string, unknown>) => Promise<void>,
): Promise<{ stdin: unknown; args: string[] }> {
  const work = mkdtempSync(join(tmpdir(), 'align-hook-coverage-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'align'), '#!/bin/sh\nd=$(dirname "$0")\nprintf \'%s\\0\' "$@" > "$d/args.txt"\ncat > "$d/stdin.json"\n');
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
  return {
    stdin: JSON.parse(readFileSync(join(bin, 'stdin.json'), 'utf8')),
    // NUL-separated, so an empty argument survives (a newline list with trim() would lose it).
    args: readFileSync(join(bin, 'args.txt'), 'utf8').split('\0').slice(0, -1),
  };
}
const posix = process.platform !== 'win32';

// What reaches the check, in the form the check reads: a pre-edit event with the proposed text.
const expectPreEdit = (sent: unknown, text: string): void => {
  const got = normalizeHookPayload(sent);
  expect(got?.hook_event_name).toBe('PreToolUse');
  expect(proposedChangeText(got?.tool_input)).toBe(text);
};

describe('Claude Code, headless main agent (claude -p, 2.1.326)', () => {
  const p = load('claude-code-headless-main-pre');
  const evidence = (): void => {
    expect(p['hook_event_name']).toBe('PreToolUse');
    expect(p['tool_name']).toBe('Edit');
    expect(p).not.toHaveProperty('agent_id');
  };
  it('sent a PreToolUse for the Edit, with no subagent identity', evidence);
  it('the matcher align installs accepts the tool, and the payload normalises to the proposed text', register(['claude-code-headless-main-pre'], async () => {
    evidence();
    const group = alignClaudeHooks().PreToolUse[0] as { matcher: string };
    expect(matches(group.matcher, p['tool_name'] as string)).toBe(true);
    expectPreEdit(p, 'export const A = 2;');
  }));
});

describe('Claude Code, subagent edit in a headless run (claude -p, 2.1.326)', () => {
  const p = load('claude-code-headless-subagent-pre');
  const evidence = (): void => {
    expect(p['hook_event_name']).toBe('PreToolUse');
    expect(p['tool_name']).toBe('Edit');
    expect(p['agent_id']).toMatch(/^a[0-9a-f]{8,}$/);
    expect(p['agent_id']).not.toBe(load('claude-code-headless-main-pre')['agent_id']);
    expect(p['agent_type']).toBe('general-purpose');
  };
  it('sent a PreToolUse that names the subagent that made the edit', evidence);
  it('the matcher align installs accepts the tool, and the payload normalises to the proposed text', register(['claude-code-headless-subagent-pre'], async () => {
    evidence();
    const group = alignClaudeHooks().PreToolUse[0] as { matcher: string };
    expect(matches(group.matcher, p['tool_name'] as string)).toBe(true);
    expectPreEdit(p, 'export const B = 2;');
  }));
});

// The plugin hook receives (input, output): the tool name and ids in `input`, the tool's own
// arguments in `output.args`. The captures are of that pair, so each is replayed through the
// plugin align writes.
type OcCapture = { event: string; input: { tool: string; sessionID: string; callID: string }; output: { args: Record<string, unknown> } };
const replayOpenCode = async (p: OcCapture, text: string): Promise<void> => {
  const sent = await sentByHandler('align.mjs', openCodePluginBody(), async (mod) => {
    const hooks = await (mod['AlignPlugin'] as () => Promise<Record<string, (i: unknown, o: unknown) => Promise<void>>>)();
    await hooks['tool.execute.before']!(p.input, p.output);
  });
  expect(sent.args).toEqual(['check', '--advisory', '--format', 'opencode']);
  expectPreEdit(sent.stdin, text);
};

describe.skipIf(!posix)('OpenCode, headless main agent (opencode run, 1.18.27)', () => {
  const p = load('opencode-headless-main-pre') as unknown as OcCapture;
  const evidence = (): void => {
    expect(p.event).toBe('tool.execute.before');
    expect(p.input.tool).toBe('edit');
  };
  it('was captured at tool.execute.before, the pre-edit event', evidence);
  it('the plugin sends the edit to align, and it normalises to the proposed text', register(['opencode-headless-main-pre'], async () => {
    evidence();
    await replayOpenCode(p, 'export const A = 2;');
  }));
});

describe.skipIf(!posix)('OpenCode, subagent edit in a headless run (opencode run, 1.18.27)', () => {
  const task = load('opencode-headless-subagent-task-pre') as unknown as OcCapture;
  const edit = load('opencode-headless-subagent-edit-pre') as unknown as OcCapture;
  // The capture is of the before-hook only, so it does not record which child session the task
  // call started. What it does show is an edit that reached the hook from a session other than
  // the one that called the task tool, which is what a subagent's edit looks like.
  const evidence = (): void => {
    expect(task.event).toBe('tool.execute.before');
    expect(edit.event).toBe('tool.execute.before');
    expect(task.input.tool).toBe('task');
    expect(edit.input.tool).toBe('edit');
    for (const id of [task.input.sessionID, edit.input.sessionID]) {
      expect(typeof id).toBe('string');
      expect(id).not.toBe('');
    }
    expect(edit.input.sessionID).not.toBe(task.input.sessionID);
  };
  it('both were captured at tool.execute.before, and the edit came from a session other than the one that called the task tool', evidence);
  it('the plugin sends the edit to align, and it normalises to the proposed text', register(
    ['opencode-headless-subagent-edit-pre', 'opencode-headless-subagent-task-pre'],
    async () => {
      evidence();
      await replayOpenCode(edit, 'export const B = 2;');
    },
  ));
});

describe.skipIf(!posix)('pi, headless main agent (pi -p, 1.2.0)', () => {
  const p = load('pi-headless-main-pre');
  const evidence = (): void => {
    expect(p['type']).toBe('tool_call');
    expect(p['toolName']).toBe('edit');
    const ctx = (p['_capture'] as { ctx: { mode: string; hasUI: boolean } }).ctx;
    expect(ctx).toEqual({ mode: 'print', hasUI: false });
  };
  it('was captured at tool_call, the pre-edit event, and records print mode with no UI', evidence);
  it('the extension sends the edit to align, and it normalises to the proposed text', register(['pi-headless-main-pre'], async () => {
    evidence();
    const sent = await sentByHandler('align.ts', piExtensionBody(), async (mod) => {
      const handlers = new Map<string, (e: unknown) => Promise<unknown>>();
      (mod['default'] as (pi: { on: (n: string, h: (e: unknown) => Promise<unknown>) => void }) => void)({ on: (n, h) => handlers.set(n, h) });
      await handlers.get('tool_call')!(p);
    });
    expect(sent.args).toEqual(['check', '--advisory', '--format', 'pi']);
    expectPreEdit(sent.stdin, 'export const A = 2;');
  }));
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
      for (const n of namesIn(headless!)) expect(n).toMatch(/-(headless|sdk)-main-/);
    }
  });

  // Runs the cited replays itself rather than reading what other tests did. The OpenCode and pi
  // replays need a POSIX shell for the stub, so Windows only checks that each one is registered.
  it('has a replay for every capture a cell cites, and the replay passes', async () => {
    const cited = rows.flatMap((r) => cellsOf(r).slice(1).flatMap(namesIn));
    for (const n of cited) {
      expect(REPLAYS[n], `${n} is cited but no test replays it`).toBeDefined();
      if (posix || n.startsWith('claude-code')) await REPLAYS[n]!();
    }
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
