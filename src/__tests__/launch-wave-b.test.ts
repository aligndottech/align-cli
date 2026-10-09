import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgents } from '../commands/agents.js';
import { runUse } from '../commands/use.js';
import { applyConfigWrite } from '../lib/launch/config-writes.js';
import { findOnPath } from '../lib/launch/detect.js';
import { readGrokState } from '../lib/launch/grok-state.js';
import { readKiroState } from '../lib/launch/kiro-state.js';
import { writeIfChanged } from '../lib/launch/launch-files.js';
import { type LaunchDeps, launchIfChosen } from '../lib/launch/launch.js';
import { AGENT_REGISTRY } from '../lib/launch/registry/index.js';
import { runAgent } from '../lib/launch/run-agent.js';
import { mergeWrittenConfig, setWriteRecorder, undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';
import { prependPath, writeFakeAgent } from './helpers/fake-agent.js';
import { pinPlatform } from './helpers/platform.js';

/*
 * Wave B wiring: Qwen Code, Factory Droid, Amp, Kiro CLI and Grok Build are launch targets.
 * Each launches with ALIGN_WRAPPED and the local graph, writes nothing to stdout, shows in the
 * picker and in `align agents`, and a written-once write is written once and undone exactly.
 */
pinPlatform('linux');
const WAVE_B = { qwen: 'qwen', droid: 'droid', amp: 'amp', kiro: 'kiro-cli', 'grok-build': 'grok' } as const;

let root: string, home: string, cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-wave-b-')));
  home = path.join(root, 'home');
  cwd = path.join(root, 'repo');
  mkdirSync(home);
  mkdirSync(cwd);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Real state readers over the sandbox; the agent itself is a mock. */
function harness(over: Partial<LaunchDeps> & { stored?: string; bins?: Record<string, string> } = {}) {
  const err: string[] = [];
  const runAgentMock = vi.fn().mockResolvedValue(0);
  const applied: unknown[] = [];
  const bins = over.bins ?? {};
  const deps: Partial<LaunchDeps> = {
    env: { HOME: home, QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'qwen-sys.json'), XDG_CONFIG_HOME: path.join(home, '.config') },
    argv: ['node', 'align'],
    cwd,
    home,
    platform: 'linux',
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

describe('wave B: each launches with Align wired in', () => {
  beforeEach(() => {
    // Grok Build's gate needs a `grok` that resolves inside ~/.grok/bin.
    mkdirSync(path.join(home, '.grok', 'bin'), { recursive: true });
    writeFileSync(path.join(home, '.grok', 'bin', 'grok'), '');
  });
  const binPath = (b: string) => (b === 'grok' ? path.join(home, '.grok', 'bin', 'grok') : `/usr/bin/${b}`);

  it.each(Object.entries(WAVE_B))('%s: runs %s with ALIGN_WRAPPED=1, carries align-local, writes nothing to stdout', async (name, bin) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const h = harness({ stored: name, bins: { [bin]: binPath(bin) } });
      expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
      const spec = h.runAgentMock.mock.calls[0]![0];
      expect(spec.bin).toBe(bin);
      expect(spec.env['ALIGN_WRAPPED']).toBe('1');
      expect(JSON.stringify({ spec, applied: h.applied })).toContain('align-local');
      expect(log).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
  });

  it('per-session ones write nothing to the user\'s config; written-once ones ask for exactly one write', async () => {
    for (const [name, bin] of Object.entries(WAVE_B)) {
      const h = harness({ stored: name, bins: { [bin]: binPath(bin) } });
      await launchIfChosen(h.deps);
      expect(h.applied, name).toHaveLength(name === 'kiro' || name === 'grok-build' ? 1 : 0);
    }
  });

  it('win32: the resolved .cmd shim is what runs, with the injected flags kept (qwen env, amp args)', async () => {
    const q = harness({ stored: 'qwen', platform: 'win32', bins: { qwen: 'C:\\npm\\qwen.cmd' } });
    await launchIfChosen(q.deps);
    expect(q.runAgentMock.mock.calls[0]![0].bin).toBe('C:\\npm\\qwen.cmd');
    expect(q.runAgentMock.mock.calls[0]![0].env['QWEN_CODE_SYSTEM_SETTINGS_PATH']).toBeDefined();
    const a = harness({ stored: 'amp', platform: 'win32', bins: { amp: 'C:\\npm\\amp.cmd' } });
    await launchIfChosen(a.deps);
    expect(a.runAgentMock.mock.calls[0]![0]).toMatchObject({ bin: 'C:\\npm\\amp.cmd', args: ['--mcp-config', expect.stringContaining('amp-mcp.json')] });
  });

  it('an ALIGN_WRAPPED session never launches another (nested align)', async () => {
    const h = harness({ stored: 'qwen', bins: { qwen: '/usr/bin/qwen' }, env: { ALIGN_WRAPPED: '1' } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(h.runAgentMock).not.toHaveBeenCalled();
  });
});

describe('Grok Build: a generic `grok` on PATH', () => {
  it('a `grok` outside Grok Build\'s install places is not Grok Build: a stored choice says it is not installed', async () => {
    const other = path.join(root, 'usr-bin-grok');
    writeFileSync(other, '');
    const h = harness({ stored: 'grok-build', bins: { grok: other }, argv: ['node', 'align', '--'] });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 127 });
    expect(h.runAgentMock).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('Grok Build is not installed any more');
  });

  it('the picker marks such a `grok` not installed, and Grok Build\'s own as installed', async () => {
    const other = path.join(root, 'grok');
    writeFileSync(other, '');
    const h = harness({ bins: { grok: other } });
    await launchIfChosen(h.deps);
    const labelOf = (opts: Array<{ value: string; label: string }>) => opts.find((o) => o.value === 'grok-build')!.label;
    expect(labelOf((h.deps.pick as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe('Grok Build (not installed)');
    mkdirSync(path.join(home, '.grok', 'bin'), { recursive: true });
    writeFileSync(path.join(home, '.grok', 'bin', 'grok'), '');
    const g = harness({ bins: { grok: path.join(home, '.grok', 'bin', 'grok') } });
    await launchIfChosen(g.deps);
    expect(labelOf((g.deps.pick as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe('Grok Build');
  });

  it('`align use grok-build` refuses a foreign `grok`', async () => {
    const other = path.join(root, 'grok');
    writeFileSync(other, '');
    const errs: string[] = [];
    const config = { getAgent: () => undefined, setAgent: vi.fn(), clearAgent: vi.fn(), setLaunchOff: vi.fn(), clearRefusedWrites: vi.fn() };
    const code = await runUse('grok-build', { config, findOnPath: () => other, writtenConfigs: { get: () => ({}), drop: () => {} }, env: { HOME: home }, platform: 'linux', log: () => {}, err: (l) => errs.push(l) });
    expect(code).toBe(1);
    expect(config.setAgent).not.toHaveBeenCalled();
  });
});

describe('the picker and `align agents` list wave B with how to install', () => {
  it('picker: every wave B agent, not installed, with its install text', async () => {
    const h = harness();
    await launchIfChosen(h.deps);
    const opts = (h.deps.pick as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<{ value: string; label: string; hint?: string }>;
    const hint = (v: string) => opts.find((o) => o.value === v)!.hint;
    expect(hint('qwen')).toBe('install: npm i -g @qwen-code/qwen-code');
    expect(hint('droid')).toBe('install: curl -fsSL https://app.factory.ai/cli | sh');
    expect(hint('amp')).toBe('install: curl -fsSL https://ampcode.com/install.sh | bash');
    expect(hint('kiro')).toBe('install: curl -fsSL https://cli.kiro.dev/install | bash');
    expect(hint('grok-build')).toBe('install: curl -fsSL https://x.ai/cli/install.sh | bash');
  });

  it('`align agents`: one row each, installed per the same gate, how Align connects', () => {
    const out: string[] = [];
    const other = path.join(root, 'grok');
    writeFileSync(other, '');
    runAgents({ json: true }, { specs: AGENT_REGISTRY, findOnPath: (b) => ({ qwen: '/usr/bin/qwen', grok: other } as Record<string, string>)[b] ?? null, env: { HOME: home }, platform: 'linux', out: (l) => out.push(l), err: () => {} });
    const rows = JSON.parse(out.join('\n')) as Array<Record<string, unknown>>;
    const row = (id: string) => rows.find((r) => r['id'] === id)!;
    expect(row('qwen')).toMatchObject({ label: 'Qwen Code', installed: true, connects: 'per-session', installCommand: 'npm i -g @qwen-code/qwen-code' });
    expect(row('grok-build')).toMatchObject({ label: 'Grok Build', bin: 'grok', installed: false, connects: 'written-once' });
    expect(row('kiro')).toMatchObject({ label: 'Kiro CLI', bin: 'kiro-cli', installed: false, connects: 'written-once', install: { kind: 'docs' } });
    expect(row('droid')).toMatchObject({ connects: 'per-session', install: { kind: 'docs' } });
    expect(row('amp')).toMatchObject({ connects: 'per-session', install: { kind: 'docs' } });
  });
});

describe('written once, against FAKE kiro-cli and grok binaries (real pipeline)', () => {
  let bin: string, record: string;
  let manifest: Record<string, WrittenConfig>;
  let lines: string[];
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  beforeEach(() => {
    bin = path.join(root, 'bin');
    mkdirSync(bin);
    record = path.join(root, 'record.json');
    writeFakeAgent(bin, 'kiro-cli', { record, recordBody: '{argv: args, wrapped: env.ALIGN_WRAPPED ?? null}', exitCode: 0 });
    mkdirSync(path.join(home, '.grok', 'bin'), { recursive: true });
    writeFakeAgent(path.join(home, '.grok', 'bin'), 'grok', { record, recordBody: '{argv: args, wrapped: env.ALIGN_WRAPPED ?? null}', exitCode: 0 });
    manifest = {};
    lines = [];
    setWriteRecorder((f, e) => { manifest[f] = mergeWrittenConfig(manifest[f], e); }, (f) => manifest[f]);
    for (const k of ['ALIGN_WRAPPED', 'ALIGN_NO_LAUNCH', 'ALIGN_LAUNCH_DRY_RUN', 'GROK_HOME', 'KIRO_HOME']) vi.stubEnv(k, undefined);
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', prependPath(bin, prependPath(path.join(home, '.grok', 'bin'), process.env['PATH'])));
  });
  afterEach(() => { setWriteRecorder(undefined); vi.unstubAllEnvs(); });
  const run = (agent: string) => launchIfChosen({
    env: { ...process.env }, argv: ['node', 'align', '--', 'hi'], cwd, home, platform: process.platform, isTTY: true,
    config: { getAgent: () => agent, setAgent: () => {} },
    findOnPath,
    readKiroState: (c, h, e, p) => readKiroState(c, h, { localIsDefault: true }, e, p),
    readGrokState: (c, h, e, p) => readGrokState(c, h, { localIsDefault: true }, e, p),
    applyConfigWrite,
    cacheDir: () => path.join(root, 'cache'), writeIfChanged, runAgent: (spec) => runAgent(spec),
    record: () => {}, pick: async () => null, err: (l) => lines.push(l), now: () => 0,
  });
  const recorded = () => JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; wrapped: string | null };

  it('kiro: adds align-local to ~/.kiro/settings/mcp.json once, keeps the user\'s server, and --undo restores it byte for byte', async () => {
    const f = path.join(home, '.kiro', 'settings', 'mcp.json');
    mkdirSync(path.dirname(f), { recursive: true });
    const original = '{ "mcpServers": { "mine": { "command": "x" } } }\n';
    writeFileSync(f, original);
    expect(await run('kiro')).toEqual({ handled: true, code: 0 });
    expect(recorded()).toEqual({ argv: ['hi'], wrapped: '1' });
    expect(Object.keys(JSON.parse(readFileSync(f, 'utf8')).mcpServers)).toEqual(['mine', 'align-local']);
    const once = readFileSync(f, 'utf8');
    lines.length = 0;
    await run('kiro');
    expect(readFileSync(f, 'utf8')).toBe(once);
    expect(lines.filter((l) => l.startsWith('Added'))).toEqual([]);
    expect(undoWrittenConfigs(manifest).restored).toEqual([f]);
    expect(sha(readFileSync(f, 'utf8'))).toBe(sha(original));
  });

  it('kiro: a commented (JSONC) mcp.json is never rewritten: the session opens and one line says why', async () => {
    const f = path.join(home, '.kiro', 'settings', 'mcp.json');
    mkdirSync(path.dirname(f), { recursive: true });
    const original = '// mine\n{ "mcpServers": {} }\n';
    writeFileSync(f, original);
    expect(await run('kiro')).toEqual({ handled: true, code: 0 });
    expect(readFileSync(f, 'utf8')).toBe(original);
    expect(lines.some((l) => l.includes(f))).toBe(true);
  });

  it('grok: appends the table once to ~/.grok/config.toml, keeps the user\'s text, and --undo restores it byte for byte', async () => {
    const f = path.join(home, '.grok', 'config.toml');
    const original = '# mine\n[mcp_servers.mine]\ncommand = "x"\n';
    writeFileSync(f, original);
    expect(await run('grok-build')).toEqual({ handled: true, code: 0 });
    expect(recorded()).toEqual({ argv: ['hi'], wrapped: '1' });
    const once = readFileSync(f, 'utf8');
    expect(once.startsWith(original)).toBe(true);
    expect(once).toContain('[mcp_servers.align-local]');
    await run('grok-build');
    expect(readFileSync(f, 'utf8')).toBe(once);
    expect(undoWrittenConfigs(manifest).restored).toEqual([f]);
    expect(sha(readFileSync(f, 'utf8'))).toBe(sha(original));
    expect(existsSync(`${f}.align-backup`)).toBe(false);
  });
});
