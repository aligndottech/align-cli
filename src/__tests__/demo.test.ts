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
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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

describe('align demo, end to end through the real CLI', () => {
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
