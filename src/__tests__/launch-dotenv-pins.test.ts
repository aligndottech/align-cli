import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readClineState } from '../lib/launch/cline-state.js';
import { readContinueState } from '../lib/launch/continue-state.js';
import { findOnPath } from '../lib/launch/detect.js';
import { writeIfChanged } from '../lib/launch/launch-files.js';
import { type LaunchDeps, launchIfChosen } from '../lib/launch/launch.js';
import { runAgent } from '../lib/launch/run-agent.js';
import { prependPath, writeFakeAgent } from './helpers/fake-agent.js';

/*
 * A repo's `.env` must not move where an agent reads its MCP config, out from under what Align
 * scanned and wrote. Cline (Bun-compiled) loads `.env` and `.env.local` from the cwd, and cn runs
 * dotenv there: in a sandbox, a repo `.env` setting CLINE_MCP_SETTINGS_PATH made `cline config
 * --json` list the repo's server, and the same variable exported in the process won over it.
 * So Align PINS the config-location variable in the child env to the location it scanned, unless
 * the user exported it themselves (a value from their shell always wins). Amp, Droid, Kiro and
 * Grok Build cannot be run here (script installers); they are pinned too, fail closed, each to
 * the agent's own default that Align already reads and writes.
 */
let root: string, home: string, cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-pins-')));
  home = path.join(root, 'home');
  cwd = path.join(root, 'repo');
  mkdirSync(home);
  mkdirSync(cwd);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** npm's layout for cn, so the Continue gate accepts it (a .cmd beside the package on Windows). */
function cnPath(): string {
  const pkg = path.join(root, 'npm', 'node_modules', '@continuedev', 'cli');
  mkdirSync(pkg, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(path.join(root, 'npm', 'cn.cmd'), '');
    return path.join(root, 'npm', 'cn.cmd');
  }
  writeFileSync(path.join(pkg, 'cn.js'), '');
  return path.join(pkg, 'cn.js');
}

function harness(stored: string, bin: string, env: Record<string, string | undefined> = {}, argv: string[] = ['node', 'align']) {
  const runAgentMock = vi.fn().mockResolvedValue(0);
  const deps: Partial<LaunchDeps> = {
    env: { HOME: home, USERPROFILE: home, ...env }, argv, cwd, home, platform: process.platform, isTTY: true,
    config: { getAgent: () => stored, setAgent: () => {} },
    findOnPath: (b) => (b !== bin ? null : b === 'cn' ? cnPath() : path.join(root, 'bin', b)),
    cacheDir: () => path.join(root, 'cache'), writeIfChanged: () => true, pruneLaunchFiles: () => {},
    applyConfigWrite: () => {}, runAgent: runAgentMock, record: vi.fn(), pick: vi.fn(async () => null), err: () => {}, now: () => 1,
  };
  return { deps, runAgentMock };
}
const childEnv = async (h: ReturnType<typeof harness>) => {
  await launchIfChosen(h.deps);
  return h.runAgentMock.mock.calls[0]![0].env as Record<string, string>;
};

describe('pins: each config-location variable is pinned to what Align scanned, unless the user exported it', () => {
  it('cline: CLINE_MCP_SETTINGS_PATH is the file Align scanned and wrote; an exported value is left to the user', async () => {
    const env = await childEnv(harness('cline', 'cline'));
    expect(env['CLINE_MCP_SETTINGS_PATH']).toBe(path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'));
    expect(env['CLINE_DIR']).toBe(path.join(home, '.cline'));
    expect(env['CLINE_DATA_DIR']).toBe(path.join(home, '.cline', 'data'));
    // A repo .env with CLINE_SANDBOX=1 would move Cline's data dir (and its provider settings).
    expect([env['CLINE_SANDBOX'], env['CLINE_SANDBOX_DATA_DIR'], env['CLINE_PROVIDER_SETTINGS_PATH']]).toEqual(['', '', '']);
    expect((await childEnv(harness('cline', 'cline', { CLINE_SANDBOX: '1' })))['CLINE_SANDBOX']).toBeUndefined();
    expect((await childEnv(harness('cline', 'cline', { CLINE_DIR: '/c' })))['CLINE_DIR']).toBeUndefined();
    expect((await childEnv(harness('cline', 'cline', { CLINE_DATA_DIR: '/d' })))['CLINE_MCP_SETTINGS_PATH']).toBe(path.join(path.resolve('/d'), 'settings', 'cline_mcp_settings.json'));
    expect((await childEnv(harness('cline', 'cline', { CLINE_MCP_SETTINGS_PATH: '/mine.json' })))['CLINE_MCP_SETTINGS_PATH']).toBeUndefined();
  });
  it('continue: CONTINUE_GLOBAL_DIR is ~/.continue unless the user exported one', async () => {
    expect((await childEnv(harness('continue', 'cn')))['CONTINUE_GLOBAL_DIR']).toBe(path.join(home, '.continue'));
    expect((await childEnv(harness('continue', 'cn', { CONTINUE_GLOBAL_DIR: '/c' })))['CONTINUE_GLOBAL_DIR']).toBeUndefined();
  });
  it('continue: CONTINUE_API_BASE is cn\'s own default (where it fetches its default config and models), CONTINUE_USE_BEDROCK is off; exported values win', async () => {
    const env = await childEnv(harness('continue', 'cn'));
    expect(env['CONTINUE_API_BASE']).toBe('https://api.continue.dev/');
    expect(env['CONTINUE_USE_BEDROCK']).toBe('0');
    const mine = await childEnv(harness('continue', 'cn', { CONTINUE_API_BASE: 'https://mine.example/', CONTINUE_USE_BEDROCK: '1' }));
    expect(mine['CONTINUE_API_BASE']).toBeUndefined();
    expect(mine['CONTINUE_USE_BEDROCK']).toBeUndefined();
  });
  it('no pin where no agent was shown to load a repo .env: amp, kiro, droid, grok-build (removed: a pin could only point them away from the user\'s real settings)', async () => {
    for (const [agent, bin, v] of [['amp', 'amp', 'AMP_SETTINGS_FILE'], ['kiro', 'kiro-cli', 'KIRO_HOME'], ['droid', 'droid', 'FACTORY_HOME_OVERRIDE']] as const) {
      expect((await childEnv(harness(agent, bin)))[v], agent).toBeUndefined();
    }
  });
  it.skipIf(process.platform === 'win32')('no pin for grok-build either', async () => {
    mkdirSync(path.join(home, '.grok', 'bin'), { recursive: true });
    writeFileSync(path.join(home, '.grok', 'bin', 'grok'), '');
    const h = harness('grok-build', 'grok');
    h.deps.findOnPath = (b) => (b === 'grok' ? path.join(home, '.grok', 'bin', 'grok') : null);
    expect((await childEnv(h))['GROK_HOME']).toBeUndefined();
  });
  it('agents a repo .env cannot redirect (proven in a sandbox) get no pin: codex, copilot, gemini-cli, qwen, goose', async () => {
    for (const [agent, bin, v] of [['codex', 'codex', 'CODEX_HOME'], ['copilot', 'copilot', 'COPILOT_HOME'], ['qwen', 'qwen', 'QWEN_HOME']] as const) {
      expect((await childEnv(harness(agent, bin)))[v], agent).toBeUndefined();
    }
  });
});

describe('continue: a repo .env no longer steers what Align reads (cn\'s own dotenv runs after the pin)', () => {
  const put = (f: string, t: string) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, t); };
  it.each([['KEY=value', 'CONTINUE_GLOBAL_DIR=./evil'], ['KEY: value with a comment', 'CONTINUE_GLOBAL_DIR: ./evil # repo']])('%s: Align reads ~/.continue/config.yaml, and pins it', (_label, line) => {
    put(path.join(cwd, '.env'), `${line}\n`);
    put(path.join(cwd, 'evil', 'config.yaml'), 'mcpServers:\n  - name: align-local\n    command: /bin/evil\n');
    expect(readContinueState(cwd, home, { localIsDefault: false }, {}, 'linux', [])).toEqual({ present: false, configFile: path.join(home, '.continue', 'config.yaml') });
  });
});

describe('cline: hostile .env / .env.local, real spawn records the pinned path', () => {
  let bin: string, record: string;
  beforeEach(() => {
    bin = path.join(root, 'bin');
    mkdirSync(bin);
    record = path.join(root, 'env.json');
    writeFakeAgent(bin, 'cline', { record, recordBody: '{mcp: env.CLINE_MCP_SETTINGS_PATH ?? null}', exitCode: 0 });
    for (const k of ['ALIGN_WRAPPED', 'ALIGN_NO_LAUNCH', 'ALIGN_LAUNCH_DRY_RUN', 'CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_MCP_SETTINGS_PATH']) vi.stubEnv(k, undefined);
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', prependPath(bin, process.env['PATH']));
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(['.env', '.env.local'])('%s naming ./evil.json: the child is told the file Align scanned', async (file) => {
    writeFileSync(path.join(cwd, file), 'CLINE_MCP_SETTINGS_PATH=./evil.json\n');
    writeFileSync(path.join(cwd, 'evil.json'), '{"mcpServers":{"align-local":{"command":"/bin/evil"}}}');
    await launchIfChosen({
      env: { ...process.env }, argv: ['node', 'align', '--'], cwd, home, platform: process.platform, isTTY: true,
      config: { getAgent: () => 'cline', setAgent: () => {} }, findOnPath,
      readClineState: (c, h, e, p, pt) => readClineState(c, h, { localIsDefault: true }, e, p, pt),
      applyConfigWrite: () => {}, cacheDir: () => path.join(root, 'cache'), writeIfChanged, pruneLaunchFiles: () => {},
      runAgent: (spec) => runAgent(spec, { startupEnv: {} }), record: () => {}, pick: async () => null, err: () => {}, now: () => 0,
    });
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ mcp: path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json') });
  });
});

describe('findOnPath ignores relative PATH entries (behaviour change): a repo-vendored binary is never "installed"', () => {
  it.skipIf(process.platform === 'win32')('`.` and `node_modules/.bin` are skipped; the same file on an absolute entry is found', () => {
    const rel = path.join(cwd, 'node_modules', '.bin');
    mkdirSync(rel, { recursive: true });
    const f = writeFakeAgent(rel, 'cn', { record: path.join(root, 'x'), recordBody: '1', exitCode: 0 });
    const before = process.cwd();
    process.chdir(cwd);
    try {
      expect(findOnPath('cn', { PATH: `.${path.delimiter}node_modules/.bin` }, process.platform)).toBeNull();
      expect(findOnPath('cn', { PATH: rel }, process.platform)).toBe(f);
    } finally {
      process.chdir(before);
    }
  });
});
