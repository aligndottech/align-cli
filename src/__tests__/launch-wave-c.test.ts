import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgents } from '../commands/agents.js';
import { runUse } from '../commands/use.js';
import { ALIGN_NUDGE_START } from '../lib/agent-rules.js';
import { supportedAgents } from '../lib/launch/agents.js';
import { readAuggieState } from '../lib/launch/auggie-state.js';
import { readClineState } from '../lib/launch/cline-state.js';
import { applyConfigWrite, type RefusedMemo } from '../lib/launch/config-writes.js';
import { findOnPath } from '../lib/launch/detect.js';
import { readGooseState } from '../lib/launch/goose-state.js';
import { writeIfChanged } from '../lib/launch/launch-files.js';
import { type LaunchDeps, launchIfChosen } from '../lib/launch/launch.js';
import { pickAgent } from '../lib/launch/pick-agent.js';
import { AGENT_REGISTRY } from '../lib/launch/registry/index.js';
import { runAgent } from '../lib/launch/run-agent.js';
import { mergeWrittenConfig, setWriteRecorder, undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';
import { prependPath, writeFakeAgent } from './helpers/fake-agent.js';

/*
 * Wave C wiring: Goose, Auggie, Continue CLI, Cline and Aider are launch targets. Each launches
 * with ALIGN_WRAPPED, writes nothing to stdout, shows in the picker and in `align agents` (Aider
 * as instructions only), and a written-once write (Auggie, Cline) is written once and undone
 * exactly. Continue's `cn` is gated like Grok Build's `grok`, so its harness supplies `acceptsBin`'s
 * evidence (a cn inside @continuedev/cli).
 */
const HOST = process.platform;
const WAVE_C = { goose: 'goose', auggie: 'auggie', continue: 'cn', cline: 'cline', aider: 'aider' } as const;

let root: string, home: string, cwd: string, cnPath: string, goosePath: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-wave-c-')));
  home = path.join(root, 'home');
  cwd = path.join(root, 'repo');
  mkdirSync(home);
  mkdirSync(cwd);
  // npm's layout, so isContinueBin accepts it: <prefix>/cn.cmd beside <prefix>/node_modules/@continuedev/cli
  // on Windows, a cn that resolves into that package elsewhere.
  const pkg = path.join(root, 'npm', 'node_modules', '@continuedev', 'cli');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'cn.js'), '');
  cnPath = HOST === 'win32' ? path.join(root, 'npm', 'cn.cmd') : path.join(pkg, 'cn.js');
  if (HOST === 'win32') writeFileSync(cnPath, '');
  // Block's installer location (download_cli.sh), so isGooseBin accepts it.
  mkdirSync(gooseDir(), { recursive: true });
  goosePath = path.join(gooseDir(), HOST === 'win32' ? 'goose.exe' : 'goose');
  writeFileSync(goosePath, '');
});
/** Where Block's installer puts goose: ~/.local/bin, or %USERPROFILE%\goose on Windows. */
const gooseDir = () => (HOST === 'win32' ? path.join(home, 'goose') : path.join(home, '.local', 'bin'));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const binPath = (b: string) => (b === 'cn' ? cnPath : b === 'goose' ? goosePath : `/usr/bin/${b}`);

function harness(over: Partial<LaunchDeps> & { stored?: string; bins?: Record<string, string> } = {}) {
  const err: string[] = [];
  const runAgentMock = vi.fn().mockResolvedValue(0);
  const applied: unknown[] = [];
  const bins = over.bins ?? {};
  const deps: Partial<LaunchDeps> = {
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    argv: ['node', 'align'],
    cwd,
    home,
    platform: HOST,
    isTTY: true,
    config: { getAgent: () => over.stored, setAgent: () => {} },
    findOnPath: (bin) => bins[bin] ?? null,
    cacheDir: () => path.join(root, 'cache'),
    writeIfChanged: () => true,
    pruneLaunchFiles: () => {},
    applyConfigWrite: (w) => { applied.push(w); },
    runAgent: runAgentMock,
    record: vi.fn(),
    pick: vi.fn(async () => null),
    err: (l) => err.push(l),
    now: () => 1,
    ...over,
  };
  return { deps, err, runAgentMock, applied };
}

describe('wave C: each launches with Align wired in', () => {
  it.each(Object.entries(WAVE_C))('%s: runs %s with ALIGN_WRAPPED=1, writes nothing to stdout', async (name, bin) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const h = harness({ stored: name, bins: { [bin]: binPath(bin) } });
      expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
      const spec = h.runAgentMock.mock.calls[0]![0];
      expect(spec.bin).toBe(binPath(bin));
      expect(spec.env['ALIGN_WRAPPED']).toBe('1');
      const all = JSON.stringify({ spec, applied: h.applied });
      // Every graph agent carries align-local; Aider has no MCP, so it carries the instructions file.
      expect(all).toContain(name === 'aider' ? 'aider-align-instructions.md' : 'align-local');
      expect(log).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
  });

  it('per-session ones write nothing to the user\'s config; written-once ones (Auggie, Cline) ask for exactly one write', async () => {
    for (const [name, bin] of Object.entries(WAVE_C)) {
      const h = harness({ stored: name, bins: { [bin]: binPath(bin) } });
      await launchIfChosen(h.deps);
      expect(h.applied, name).toHaveLength(['auggie', 'cline'].includes(name) ? 1 : 0);
    }
  });

  it('no registry spec defines a server named `align`: every injected server is align-local', async () => {
    for (const [name, bin] of Object.entries(WAVE_C)) {
      const h = harness({ stored: name, bins: { [bin]: binPath(bin) } });
      await launchIfChosen(h.deps);
      const all = JSON.stringify({ spec: h.runAgentMock.mock.calls[0]![0], applied: h.applied });
      expect(all, name).not.toMatch(/"align":|name: align\n|'align:|"align:/);
    }
  });

  it('win32: the resolved .cmd shim is what runs, with the injected flags kept (goose, cn)', async () => {
    const g = harness({ stored: 'goose', platform: 'win32', env: { USERPROFILE: 'C:\\Users\\u' }, bins: { goose: 'C:\\Users\\u\\goose\\goose.exe' } });
    await launchIfChosen(g.deps);
    expect(g.runAgentMock.mock.calls[0]![0]).toMatchObject({ bin: 'C:\\Users\\u\\goose\\goose.exe', args: ['session', '--with-extension', expect.stringMatching(/^align-local:/)] });
    const a = harness({ stored: 'aider', platform: 'win32', bins: { aider: 'C:\\py\\Scripts\\aider.exe' } });
    await launchIfChosen(a.deps);
    expect(a.runAgentMock.mock.calls[0]![0]).toMatchObject({ bin: 'C:\\py\\Scripts\\aider.exe', args: ['--read', expect.stringContaining('aider-align-instructions.md')] });
  });

  it('aider: `align -- --read AGENTS.md` with Align\'s general block in AGENTS.md still gets the Aider file first', async () => {
    writeFileSync(path.join(cwd, 'AGENTS.md'), `# x\n${ALIGN_NUDGE_START}\nuse align_check_alignment\n`);
    const h = harness({ stored: 'aider', bins: { aider: '/usr/bin/aider' }, argv: ['node', 'align', '--', '--read', 'AGENTS.md'] });
    await launchIfChosen(h.deps);
    expect(h.runAgentMock.mock.calls[0]![0].args).toEqual(['--read', path.join(root, 'cache', 'aider-align-instructions.md'), '--read', 'AGENTS.md']);
  });

  it('an ALIGN_WRAPPED session never launches another (nested align)', async () => {
    const h = harness({ stored: 'goose', bins: { goose: goosePath }, env: { ALIGN_WRAPPED: '1' } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(h.runAgentMock).not.toHaveBeenCalled();
  });

  it('a `cn` that is not Continue CLI\'s own is not installed: a stored choice says so', async () => {
    const other = path.join(root, 'cn');
    writeFileSync(other, '');
    const h = harness({ stored: 'continue', bins: { cn: other }, argv: ['node', 'align', '--'] });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 127 });
    expect(h.runAgentMock).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('Continue CLI is not installed any more');
  });
});

describe('Goose: pressly/goose (the Go migration CLI) is never taken for Block\'s', () => {
  // `go install github.com/pressly/goose/v3/cmd/goose` puts it in ~/go/bin.
  const pressly = () => {
    const f = path.join(home, 'go', 'bin', HOST === 'win32' ? 'goose.exe' : 'goose');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, '');
    return f;
  };
  it('launcher: a stored Goose with only pressly\'s goose on PATH is not installed, and nothing runs', async () => {
    const h = harness({ stored: 'goose', bins: { goose: pressly() }, argv: ['node', 'align', '--'] });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 127 });
    expect(h.runAgentMock).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('Goose is not installed any more');
  });
  it('picker: pressly\'s goose leaves Goose marked not installed; Block\'s marks it installed', async () => {
    const labelOf = (d: Partial<LaunchDeps>) => ((d.pick as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<{ value: string; label: string }>).find((o) => o.value === 'goose')!.label;
    const p = harness({ bins: { goose: pressly() } });
    await launchIfChosen(p.deps);
    expect(labelOf(p.deps)).toBe('Goose (not installed)');
    const b = harness({ bins: { goose: goosePath } });
    await launchIfChosen(b.deps);
    expect(labelOf(b.deps)).toBe('Goose');
  });
  it('`align use goose` refuses pressly\'s goose and takes Block\'s', async () => {
    const use = async (found: string) => {
      const config = { getAgent: () => undefined, setAgent: vi.fn(), clearAgent: vi.fn(), setLaunchOff: vi.fn(), clearRefusedWrites: vi.fn() };
      const code = await runUse('goose', { config, findOnPath: () => found, writtenConfigs: { get: () => ({}), drop: () => {} }, env: { HOME: home, USERPROFILE: home }, platform: HOST, log: () => {}, err: () => {} });
      return { code, set: config.setAgent.mock.calls.length };
    };
    expect(await use(pressly())).toEqual({ code: 1, set: 0 });
    expect(await use(goosePath)).toEqual({ code: 0, set: 1 });
  });
  it('`align agents`: pressly\'s goose is "no", Block\'s is "yes"', () => {
    const row = (found: string) => {
      const out: string[] = [];
      runAgents({ json: true }, { specs: AGENT_REGISTRY, findOnPath: (b) => (b === 'goose' ? found : null), env: { HOME: home, USERPROFILE: home }, platform: HOST, out: (l) => out.push(l), err: () => {} });
      return (JSON.parse(out.join('\n')) as Array<Record<string, unknown>>).find((r) => r['id'] === 'goose')!['installed'];
    };
    expect(row(pressly())).toBe(false);
    expect(row(goosePath)).toBe(true);
  });
});

describe('the picker and `align agents` list wave C honestly', () => {
  it('picker: every wave C agent with its install text; Aider says it is instructions only', async () => {
    const h = harness();
    await launchIfChosen(h.deps);
    const opts = (h.deps.pick as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<{ value: string; label: string; hint?: string }>;
    const opt = (v: string) => opts.find((o) => o.value === v)!;
    expect(opt('auggie').hint).toBe('install: npm i -g @augmentcode/auggie');
    expect(opt('continue').hint).toBe('install: npm i -g @continuedev/cli');
    expect(opt('cline').hint).toBe('install: npm i -g cline');
    expect(opt('goose').hint).toContain('download_cli.sh');
    expect(opt('aider').hint).toContain('aider-install');
    expect(opt('aider').label).toBe('Aider (instructions only: no graph tools) (not installed)');
    expect(opt('goose').label).toBe('Goose (not installed)');
  });

  it('picker, installed: Aider keeps its instructions-only marker; Goose has none', async () => {
    const h = harness({ bins: { aider: '/usr/bin/aider', goose: goosePath } });
    await launchIfChosen(h.deps);
    const opts = (h.deps.pick as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<{ value: string; label: string }>;
    expect(opts.find((o) => o.value === 'aider')!.label).toBe('Aider (instructions only: no graph tools)');
    expect(opts.find((o) => o.value === 'goose')!.label).toBe('Goose');
  });

  it('`align agents`: how Align connects, per agent; Aider is instructions only, Goose and the rest carry the graph', () => {
    const out: string[] = [];
    runAgents({}, { specs: AGENT_REGISTRY, findOnPath: () => null, env: {}, platform: 'linux', out: (l) => out.push(l), err: () => {} });
    const row = (label: string) => out.find((l) => l.startsWith(`${label} `))!;
    expect(row('Aider')).toMatch(/^Aider\s+no\s+instructions only, no graph\s/);
    expect(row('Goose')).toMatch(/^Goose\s+no\s+per session\s/);
    expect(row('Continue CLI')).toMatch(/per session\s+npm i -g @continuedev\/cli/);
    expect(row('Auggie')).toMatch(/written once\s+npm i -g @augmentcode\/auggie/);
    expect(row('Cline')).toMatch(/written once\s+npm i -g cline/);
  });

  it('`align agents --json`: Aider graph false, Goose graph true', () => {
    const out: string[] = [];
    runAgents({ json: true }, { specs: AGENT_REGISTRY, findOnPath: () => null, env: {}, platform: 'linux', out: (l) => out.push(l), err: () => {} });
    const rows = JSON.parse(out.join('\n')) as Array<Record<string, unknown>>;
    expect(rows.find((r) => r['id'] === 'aider')).toMatchObject({ connects: 'per-session', graph: false });
    expect(rows.find((r) => r['id'] === 'goose')).toMatchObject({ connects: 'per-session', graph: true });
  });
});

describe('written once, against FAKE auggie and cline binaries (real pipeline)', () => {
  let bin: string, record: string;
  let manifest: Record<string, WrittenConfig>;
  let lines: string[];
  let refused: Set<string>;
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  beforeEach(() => {
    bin = path.join(root, 'bin');
    mkdirSync(bin);
    record = path.join(root, 'record.json');
    const body = '{argv: args, wrapped: env.ALIGN_WRAPPED ?? null, anthropic: env.ANTHROPIC_API_KEY ?? null, openai: env.OPENAI_API_KEY ?? null}';
    for (const b of ['auggie', 'cline']) writeFakeAgent(bin, b, { record, recordBody: body, exitCode: 0 });
    // Goose only counts from Block's install place, so its fake lives there.
    writeFakeAgent(gooseDir(), HOST === 'win32' ? 'goose' : 'goose', { record, recordBody: body, exitCode: 0 });
    manifest = {};
    lines = [];
    refused = new Set();
    setWriteRecorder((f, e) => { manifest[f] = mergeWrittenConfig(manifest[f], e); }, (f) => manifest[f]);
    for (const k of ['ALIGN_WRAPPED', 'ALIGN_NO_LAUNCH', 'ALIGN_LAUNCH_DRY_RUN', 'CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_MCP_SETTINGS_PATH', 'GOOSE_PATH_ROOT']) vi.stubEnv(k, undefined);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
    vi.stubEnv('PATH', prependPath(bin, prependPath(gooseDir(), process.env['PATH'])));
    // As if align had put saved keys into its own environment.
    vi.stubEnv('ANTHROPIC_API_KEY', 'saved-by-align');
    vi.stubEnv('OPENAI_API_KEY', 'saved-by-align');
  });
  afterEach(() => { setWriteRecorder(undefined); vi.unstubAllEnvs(); });
  const memo: RefusedMemo = { has: (f) => refused.has(f), add: (f) => refused.add(f), remove: (f) => refused.delete(f) };
  const run = (agent: string, startupEnv: Record<string, string> = {}, args: string[] = ['hi']) => launchIfChosen({
    env: { ...process.env }, argv: ['node', 'align', '--', ...args], cwd, home, platform: process.platform, isTTY: true,
    config: { getAgent: () => agent, setAgent: () => {} },
    findOnPath,
    readAuggieState: (c, h, e, p, pt) => readAuggieState(c, h, { localIsDefault: true }, e, p, pt),
    readClineState: (c, h, e, p, pt) => readClineState(c, h, { localIsDefault: true }, e, p, pt),
    readGooseState: (c, h, e, p) => readGooseState(c, h, { localIsDefault: true }, e, p),
    applyConfigWrite: (w, note) => applyConfigWrite(w, note, memo),
    cacheDir: () => path.join(root, 'cache'), writeIfChanged, pruneLaunchFiles: () => {},
    runAgent: (spec) => runAgent(spec, { startupEnv }),
    record: () => {}, pick: async () => null, err: (l) => lines.push(l), now: () => 0,
  });
  const recorded = () => JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; wrapped: string | null; anthropic: string | null; openai: string | null };
  const files = {
    auggie: () => path.join(home, '.augment', 'settings.json'),
    cline: () => path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
  };

  it.each(['auggie', 'cline'] as const)('%s: adds align-local once, keeps the user\'s server, and --undo restores the file byte for byte', async (agent) => {
    const f = files[agent]();
    mkdirSync(path.dirname(f), { recursive: true });
    const original = '{ "mcpServers": { "mine": { "command": "x" } } }\n';
    writeFileSync(f, original);
    expect(await run(agent)).toEqual({ handled: true, code: 0 });
    expect(recorded()).toMatchObject({ argv: ['hi'], wrapped: '1' });
    expect(Object.keys(JSON.parse(readFileSync(f, 'utf8')).mcpServers)).toEqual(['mine', 'align-local']);
    const once = readFileSync(f, 'utf8');
    lines.length = 0;
    await run(agent);
    expect(readFileSync(f, 'utf8')).toBe(once);
    expect(lines.filter((l) => l.startsWith('Added'))).toEqual([]);
    expect(undoWrittenConfigs(manifest).restored).toEqual([f]);
    expect(sha(readFileSync(f, 'utf8'))).toBe(sha(original));
  });

  it.each(['auggie', 'cline'] as const)('%s: a hostile or user non-canonical align-local means no write and one line', async (agent) => {
    const f = files[agent]();
    mkdirSync(path.dirname(f), { recursive: true });
    const original = JSON.stringify({ mcpServers: { 'align-local': { command: '/bin/evil' } } });
    writeFileSync(f, original);
    expect(await run(agent)).toEqual({ handled: true, code: 0 });
    expect(readFileSync(f, 'utf8')).toBe(original);
    expect(lines.filter((l) => l.includes('defines its own align-local'))).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32').each(['auggie', 'cline'] as const)('%s: a symlinked settings file is never written through; refused once with the target named, then quiet', async (agent) => {
    const f = files[agent]();
    mkdirSync(path.dirname(f), { recursive: true });
    const real = path.join(root, 'dotfiles.json');
    const original = '{ "mcpServers": {} }\n';
    writeFileSync(real, original);
    symlinkSync(real, f);
    expect(await run(agent)).toEqual({ handled: true, code: 0 });
    expect(readFileSync(real, 'utf8')).toBe(original);
    expect(lines.filter((l) => l.includes(real))).toHaveLength(1);
    lines.length = 0;
    await run(agent);
    expect(readFileSync(real, 'utf8')).toBe(original);
    expect(lines.filter((l) => l.includes(real))).toEqual([]);
  });

  it.each(['auggie', 'cline', 'goose'])('%s: a saved ANTHROPIC/OPENAI key is absent from the child env; the user\'s own exported keys do reach it', async (agent) => {
    await run(agent);
    expect(recorded()).toMatchObject({ anthropic: null, openai: null, wrapped: '1' });
    await run(agent, { ANTHROPIC_API_KEY: 'users-own', OPENAI_API_KEY: 'users-own' });
    expect(recorded()).toMatchObject({ anthropic: 'users-own', openai: 'users-own' });
  });

  it('goose: the real spawn carries `session --with-extension align-local:...` before the user\'s session options', async () => {
    await run('goose', {}, ['--resume']);
    expect(recorded().argv).toEqual(['session', '--with-extension', expect.stringMatching(/^align-local:/), '--resume']);
  });
  it('goose: a bare word is a goose subcommand, so it is passed through untouched with one note', async () => {
    await run('goose');
    expect(recorded().argv).toEqual(['hi']);
    expect(lines).toContain('Align adds its graph to `goose session` and `goose run` only, so `goose hi` opens without it.');
  });
});

describe('wave C: the wizard without a terminal keeps its old answers', () => {
  const run = (onPath: string[], opts: { approve?: boolean } = {}) => {
    let stored: string | undefined;
    const config = { getAgent: () => stored, setAgent: (a: string) => { stored = a; } };
    return pickAgent(config, { interactive: false, ...opts }, { agents: supportedAgents(), env: {}, platform: 'linux', findOnPath: (b) => (onPath.includes(b) ? `/b/${b}` : null), select: vi.fn(), say: () => {} });
  };
  it('a wave B agent plus a wave C one picks the wave B one, as before wave C (two examples)', async () => {
    expect(await run(['qwen', 'goose'])).toBe('qwen');
    expect(await run(['amp', 'aider'])).toBe('amp');
  });
  it('a wave C agent alone is picked; two wave C agents are not guessed between', async () => {
    // Not goose or cn here: those count only from their real install places, which /b/ is not.
    expect(await run(['cline'])).toBe('cline');
    expect(await run(['cline', 'auggie'])).toBeNull();
  });
});
