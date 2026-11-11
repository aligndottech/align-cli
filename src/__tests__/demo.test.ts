/**
 * `align demo`: a bundled repo, a throwaway graph, the real edit hook, and a plain explanation.
 *
 * Test list (written first):
 *  - the bundled repo is a real git repo: one commit whose message says to keep all app state in
 *    src/store.ts, and a CLAUDE.md rule saying the same
 *  - the child environment points every home-like variable into the temp dir, and drops the
 *    variables that would send a child to a cloud graph
 *  - a hook reply is read as the agent would read it (hookSpecificOutput.additionalContext);
 *    no reply is "nothing"
 *  - git missing -> a clear message, exit 1, nothing left behind
 *  - a setup step failing -> a clear message naming the step, exit 1, temp dir removed
 *  - the violating edit staying silent is a failed demo (exit 1), not a quiet pass
 *  - a harmless edit that speaks is a failed demo too (the negative control)
 *  - end to end through the real CLI: exit 0, the decision title surfaced, the harmless edit
 *    silent, the own-repo command printed, nothing written under the caller's HOME, temp dir
 *    removed, and kept under --keep
 */
import { afterAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PROVIDER_ENV_VARS } from '../lib/llm-providers.js';
import { modelCacheDir } from '../lib/model-cache.js';
import { invokedCommandName, topLevelCommandName } from '../lib/demo/invoked.js';
import { DEMO_COMMIT_BODY, DEMO_COMMIT_SUBJECT, DEMO_EDITS, DEMO_FILES } from '../lib/demo/fixture.js';
import { hookReply, isolatedEnv, type Run, runDemo, type RunResult } from '../lib/demo/run.js';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = join(ROOT, 'src', 'index.ts');

const TITLE = 'Keep all app state in src/store.ts';
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = (prefix = 'align-demo-test-'): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

function hookJson(titles: string[]): string {
  const body = `Align decision graph: ${titles.length} prior decisions relate to this change:\n${titles.map((t) => `- ${t}`).join('\n')}\n`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: body } });
}

/** A fake CLI: every step succeeds; the hook answers per the edit it is handed. */
function fakeRun(opts: { violating?: string; harmless?: string; failStep?: string; noGit?: boolean } = {}): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (cmd, args, o) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') {
      if (opts.noGit) return { code: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) };
      return ok('git version 2.40.0');
    }
    if (args.includes('check')) {
      const payload = JSON.parse(o.input ?? '{}') as { tool_input?: { file_path?: string } };
      const file = payload.tool_input?.file_path;
      return ok(file === DEMO_EDITS.violating.file ? (opts.violating ?? '') : (opts.harmless ?? ''));
    }
    if (opts.failStep && args.join(' ').includes(opts.failStep)) return { code: 1, stdout: '', stderr: 'boom: could not fetch model', error: undefined };
    return ok();
  };
  return { run, calls };
}

function collect(): { write: (l: string) => void; text: () => string } {
  const lines: string[] = [];
  return { write: (l) => lines.push(l), text: () => lines.join('\n') };
}

describe('the bundled repo', () => {
  it('carries a CLAUDE.md rule and a commit message that both say to keep app state in src/store.ts', () => {
    const claude = DEMO_FILES.find((f) => f.path === 'CLAUDE.md');
    expect(claude?.content.toLowerCase()).toContain('keep all app state in src/store.ts');
    expect(DEMO_COMMIT_SUBJECT).toBe(TITLE);
    expect(DEMO_COMMIT_BODY.length).toBeGreaterThan(40);
    expect(DEMO_FILES.some((f) => f.path === 'src/store.ts')).toBe(true);
  });

  it('proposes one edit that adds module-level state and one that does not', () => {
    expect(DEMO_EDITS.violating.file).not.toBe(DEMO_EDITS.harmless.file);
    expect(DEMO_EDITS.violating.content).toMatch(/^let /m);
    expect(DEMO_EDITS.harmless.content).not.toMatch(/\b(let|var)\b/);
  });
});

describe('isolatedEnv', () => {
  it('points every home-like variable inside the root, and drops cloud-pointing variables', () => {
    const root = join(tmpdir(), 'align-demo-x');
    const env = isolatedEnv(root, {
      HOME: '/real/home',
      USERPROFILE: 'C:\\Users\\real',
      XDG_CONFIG_HOME: '/real/.config',
      ALIGN_TOKEN: 'secret',
      ALIGN_TENANT_ID: 't',
      ALIGN_GATEWAY_URL: 'https://x',
      ALIGN_ENV: 'prod',
      DO_NOT_TRACK: '1',
    });
    for (const k of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA'] as const) {
      expect(env[k]?.startsWith(root)).toBe(true);
    }
    for (const k of ['ALIGN_TOKEN', 'ALIGN_TENANT_ID', 'ALIGN_GATEWAY_URL', 'ALIGN_ENV']) expect(env[k]).toBeUndefined();
    expect(env['ALIGN_TELEMETRY']).toBe('0');
    expect(env['DO_NOT_TRACK']).toBe('1');
  });
});

describe('isolatedEnv: what a child must never inherit', () => {
  const callerEnv = (): Record<string, string> => {
    const env: Record<string, string> = { PATH: '/usr/bin', ALIGN_LLM_ANYTHING: 'x', ALIGN_OLLAMA_HOST: 'h', ALIGN_TOKEN_STORE: 'file', ALIGN_DETECTOR: 'v0', ALIGN_ORT_RUNTIME_URL: 'https://mirror.example' };
    for (const k of PROVIDER_ENV_VARS) env[k] = `value-of-${k}`;
    return env;
  };

  it('strips every provider key and model variable llm-providers defines, plus ALIGN_LLM_*, the token store, the detector and the runtime mirror', () => {
    const base = callerEnv();
    // Positive control: the list is not empty, and every name really is in the caller's env.
    expect(PROVIDER_ENV_VARS.length).toBeGreaterThan(10);
    for (const k of Object.keys(base)) expect(base[k]).toBeDefined();
    const env = isolatedEnv(join(tmpdir(), 'align-demo-x'), base);
    for (const k of [...PROVIDER_ENV_VARS, 'ALIGN_LLM_ANYTHING', 'ALIGN_OLLAMA_HOST', 'ALIGN_DETECTOR', 'ALIGN_ORT_RUNTIME_URL']) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('forces the file token store, so no child can reach the OS keychain, which a temp HOME does not isolate', () => {
    // Distinct caller values: the caller's own choice must not win.
    expect(isolatedEnv(join(tmpdir(), 'align-demo-x'), { PATH: 'p', ALIGN_TOKEN_STORE: 'keychain' })['ALIGN_TOKEN_STORE']).toBe('file');
    expect(isolatedEnv(join(tmpdir(), 'align-demo-x'), { PATH: 'p' })['ALIGN_TOKEN_STORE']).toBe('file');
  });

  it('strips every GIT_ variable, so a run inside a git hook cannot write to the caller\'s repo', () => {
    const env = isolatedEnv(join(tmpdir(), 'align-demo-x'), { GIT_DIR: '/real/.git', GIT_INDEX_FILE: '/real/.git/index', GIT_WORK_TREE: '/real', GIT_AUTHOR_NAME: 'x', PATH: 'p' });
    expect(Object.keys(env).filter((k) => k.startsWith('GIT_'))).toEqual([]);
    expect(env['PATH']).toBe('p');
  });

  it('points the model cache at the CALLER\'s cache, absolute, so a warm cache is reused', () => {
    const base = { XDG_CACHE_HOME: join(tmpdir(), 'real-cache'), HOME: join(tmpdir(), 'real-home') };
    const env = isolatedEnv(join(tmpdir(), 'align-demo-x'), base);
    expect(env['ALIGN_MODEL_CACHE']).toBe(modelCacheDir(base));
    expect(isAbsolute(env['ALIGN_MODEL_CACHE'] as string)).toBe(true);
    expect(env['ALIGN_MODEL_CACHE']?.startsWith(join(tmpdir(), 'align-demo-x'))).toBe(false);
  });
});

describe('which command was invoked', () => {
  it('reads the command word from argv, skipping options', () => {
    expect(invokedCommandName(['node', 'align', 'demo'])).toBe('demo');
    expect(invokedCommandName(['node', 'align', '--version'])).toBeUndefined();
    expect(invokedCommandName(['node', 'align', 'ask', 'demo'])).toBe('ask');
    expect(invokedCommandName(['node', 'align'])).toBeUndefined();
  });

  it('names the TOP-LEVEL command, so a future `align foo demo` is not mistaken for `align demo`', () => {
    const program = new Command('align');
    const foo = program.command('foo');
    const nested = foo.command('demo');
    const top = program.command('demo');
    expect(topLevelCommandName(nested)).toBe('foo');
    expect(topLevelCommandName(top)).toBe('demo');
  });
});

describe('startup leaves the caller\'s ~/.align alone for `demo`', () => {
  function seededHome(): string {
    const home = scratch('align-demo-legacy-');
    // The two places an older install left a config. Both resolve under this HOME.
    for (const dir of [join(home, '.config', 'align-cli'), join(home, '.config', 'align-cli-nodejs')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ environments: {}, defaultEnv: 'prod' }), 'utf8');
    }
    return home;
  }
  const run = (home: string, args: string[]) =>
    exec(process.execPath, [TSX, ENTRY, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), DO_NOT_TRACK: '1' },
      timeout: 60_000,
    });

  it('control: a different command DOES run the migration and create ~/.align from the legacy config', async () => {
    const home = seededHome();
    await run(home, ['--version']);
    expect(existsSync(join(home, '.align', 'config.json'))).toBe(true);
  }, 70_000);

  it('`demo` does not create ~/.align before it starts', async () => {
    const home = seededHome();
    await run(home, ['demo', '--help']);
    expect(existsSync(join(home, '.align'))).toBe(false);
  }, 70_000);
});

describe('hookReply', () => {
  it('reads the additionalContext the agent would be given', () => {
    expect(hookReply(hookJson([TITLE]))?.text).toContain(`- ${TITLE}`);
  });
  it('treats an empty reply as nothing', () => {
    expect(hookReply('')).toBeNull();
    expect(hookReply('  \n')).toBeNull();
  });
});

describe('runDemo', () => {
  it('passes when the violating edit surfaces the decision and the harmless edit stays silent', async () => {
    const out = collect();
    const { run } = fakeRun({ violating: hookJson([TITLE]) });
    const code = await runDemo({}, { run, write: out.write, tmpRoot: scratch() });
    expect(code).toBe(0);
    expect(out.text()).toContain(TITLE);
    expect(out.text()).toMatch(/silent|nothing/i);
    expect(out.text()).toMatch(/align\b.*your own repo|your own repo/i);
    expect(out.text()).not.toContain('\u2014');
  });

  it('fails with a clear message when git is missing, and creates nothing', async () => {
    const out = collect();
    const root = scratch();
    const { run } = fakeRun({ noGit: true });
    const code = await runDemo({}, { run, write: out.write, tmpRoot: root });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/needs git/i);
    expect(readdirSync(root)).toEqual([]);
  });

  it('names the failing setup step and cleans up', async () => {
    const out = collect();
    const root = scratch();
    const { run } = fakeRun({ failStep: 'connect git' });
    const code = await runDemo({}, { run, write: out.write, tmpRoot: root });
    expect(code).toBe(1);
    expect(out.text()).toContain('connect git');
    expect(out.text()).toContain('could not fetch model');
    expect(readdirSync(root)).toEqual([]);
  });

  it('fails when the violating edit stays silent (a quiet pass would be a lie)', async () => {
    const out = collect();
    const { run } = fakeRun({ violating: '' });
    const code = await runDemo({}, { run, write: out.write, tmpRoot: scratch() });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/did not (surface|say)/i);
  });

  it('fails when the harmless edit speaks (the negative control)', async () => {
    const out = collect();
    const { run } = fakeRun({ violating: hookJson([TITLE]), harmless: hookJson([TITLE]) });
    const code = await runDemo({}, { run, write: out.write, tmpRoot: scratch() });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/harmless edit/i);
  });

  it('runs every setup step with the isolated environment and the temp repo as cwd', async () => {
    const root = scratch();
    const seen: Array<{ cwd: string; home?: string }> = [];
    const { run } = fakeRun({ violating: hookJson([TITLE]) });
    const spy: Run = async (cmd, args, o) => {
      if (cmd !== 'git') seen.push({ cwd: o.cwd, home: o.env['HOME'] });
      return run(cmd, args, o);
    };
    await runDemo({ keep: true }, { run: spy, write: () => undefined, tmpRoot: root });
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const s of seen) {
      expect(s.cwd.startsWith(root)).toBe(true);
      expect(s.home?.startsWith(root)).toBe(true);
    }
    rmSync(root, { recursive: true, force: true });
  });
});

describe('runDemo: environment, messages and interruption', () => {
  it('runs every child, git included, without GIT_ variables or provider keys from the caller', async () => {
    const root = scratch();
    const seen: Array<Record<string, string | undefined>> = [];
    const { run } = fakeRun({ violating: hookJson([TITLE]) });
    const spy: Run = async (cmd, args, o) => {
      if (!(cmd === 'git' && args[0] === '--version')) seen.push(o.env);
      return run(cmd, args, o);
    };
    await runDemo({}, { run: spy, write: () => undefined, tmpRoot: root, env: { PATH: 'p', GIT_DIR: '/real/.git', ANTHROPIC_API_KEY: 'k', ALIGN_LLM_API_KEY: 'k' } });
    expect(seen.length).toBeGreaterThanOrEqual(6);
    for (const env of seen) {
      expect(Object.keys(env).filter((k) => k.startsWith('GIT_'))).toEqual([]);
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(env['ALIGN_LLM_API_KEY']).toBeUndefined();
    }
  });

  it('says a timed-out step is a slow connection, not "offline"', async () => {
    const out = collect();
    const { run } = fakeRun();
    const slow: Run = async (cmd, args, o) => (args.join(' ').includes('connect git') ? { code: null, stdout: '', stderr: 'timed out after 120s' } : run(cmd, args, o));
    const code = await runDemo({}, { run: slow, write: out.write, tmpRoot: scratch() });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/slow connection/i);
    expect(out.text()).not.toMatch(/offline/i);
  });

  it('describes the model download accurately: once, kept in the align cache, not in the demo folder', async () => {
    const out = collect();
    const { run } = fakeRun({ violating: hookJson([TITLE]) });
    await runDemo({}, { run, write: out.write, tmpRoot: scratch() });
    expect(out.text()).toMatch(/align cache/i);
    expect(out.text()).toMatch(/once|one-time/i);
  });

  class FakeProc extends EventEmitter {
    exits: number[] = [];
    exit(code: number): void { this.exits.push(code); }
  }
  const SIGNALS = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

  it.each(SIGNALS)('on %s it kills the in-flight child, removes the temp dir and exits 130', async (sig) => {
    const root = scratch();
    const proc = new FakeProc();
    let release: (r: RunResult) => void = () => undefined;
    let reached: () => void = () => undefined;
    const atStep = new Promise<void>((r) => (reached = r));
    let killed = 0;
    const { run } = fakeRun();
    const hang: Run = async (cmd, args, o) => {
      if (args.join(' ').includes('connect git')) {
        reached();
        return new Promise<RunResult>((r) => (release = r));
      }
      return run(cmd, args, o);
    };
    const done = runDemo({}, { run: hang, write: () => undefined, tmpRoot: root, proc, kill: () => { killed++; release({ code: null, stdout: '', stderr: 'killed' }); } });
    await atStep;
    expect(readdirSync(root).filter((n) => n.startsWith('align-demo-'))).toHaveLength(1);
    proc.emit(sig);
    await done;
    expect(killed).toBe(1);
    expect(proc.exits).toContain(130);
    expect(readdirSync(root)).toEqual([]);
    for (const s of SIGNALS) expect(proc.listenerCount(s), s).toBe(0);
  });

  it('removes its signal handlers when the run finishes normally', async () => {
    const proc = new FakeProc();
    const { run } = fakeRun({ violating: hookJson([TITLE]) });
    let during = 0;
    const spy: Run = async (cmd, args, o) => {
      during = Math.max(during, ...SIGNALS.map((s) => proc.listenerCount(s)));
      return run(cmd, args, o);
    };
    await runDemo({}, { run: spy, write: () => undefined, tmpRoot: scratch(), proc });
    expect(during).toBe(1);
    for (const s of SIGNALS) expect(proc.listenerCount(s), s).toBe(0);
    expect(proc.exits).toEqual([]);
  });
});

// Needs the on-device model. Runs when this machine already has the model cache, or when ALIGN_DEMO_E2E=1
// says to fetch it. Same shape as the other environment-gated suites (describe.skipIf at module level).
const REAL_MODEL_CACHE = modelCacheDir(process.env);
const haveModel = process.env['ALIGN_DEMO_E2E'] === '1' || (existsSync(REAL_MODEL_CACHE) && readdirSync(REAL_MODEL_CACHE).length > 0);

describe.skipIf(!haveModel)('align demo, end to end through the real CLI', () => {
  async function runCli(args: string[]): Promise<{ out: string; home: string; tmp: string }> {
    const home = scratch('align-demo-e2e-home-');
    const tmp = scratch('align-demo-e2e-tmp-');
    const { stdout, stderr } = await exec(process.execPath, [TSX, ENTRY, 'demo', ...args], {
      cwd: tmp,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        APPDATA: join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        ALIGN_MODEL_CACHE: REAL_MODEL_CACHE,
        DO_NOT_TRACK: '1',
      },
      timeout: 170_000,
    });
    // execFile rejects on a non-zero exit, so reaching here is the exit-0 assertion.
    return { out: stdout + stderr, home, tmp };
  }

  it('surfaces the decision, keeps the harmless edit silent, writes nothing under HOME, and cleans up', async () => {
    const { out, home, tmp } = await runCli([]);
    expect(out).toContain(TITLE);
    expect(out).toMatch(/harmless/i);
    expect(out).toMatch(/your own repo/i);
    expect(existsSync(join(home, '.align'))).toBe(false);
    expect(readdirSync(tmp).filter((n) => n.startsWith('align-demo-'))).toEqual([]);
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }, 180_000);

  it('keeps the temp dir, and names it, under --keep', async () => {
    const { out, home, tmp } = await runCli(['--keep']);
    const kept = readdirSync(tmp).filter((n) => n.startsWith('align-demo-'));
    expect(kept).toHaveLength(1);
    expect(out).toContain(join(tmp, kept[0] as string));
    expect(readFileSync(join(tmp, kept[0] as string, 'repo', 'CLAUDE.md'), 'utf8')).toMatch(/src\/store\.ts/);
    expect(existsSync(join(home, '.align'))).toBe(false);
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }, 180_000);
});
