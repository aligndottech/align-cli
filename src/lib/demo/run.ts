import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEMO_COMMIT_BODY, DEMO_COMMIT_SUBJECT, DEMO_EDITS, DEMO_FILES } from './fixture.js';

export interface RunResult { code: number | null; stdout: string; stderr: string; error?: Error & { code?: string } }
export type Run = (cmd: string, args: string[], o: { cwd: string; env: Record<string, string | undefined>; input?: string; timeoutMs: number }) => Promise<RunResult>;
export interface DemoOptions { keep?: boolean }
export interface DemoDeps {
  run?: Run;
  write?: (line: string) => void;
  /** Where the temp dir is made. Defaults to the OS temp dir. */
  tmpRoot?: string;
  /** How to start this CLI again. Defaults to the running entry point. */
  align?: { cmd: string; args: string[] };
}

const STEP_TIMEOUT_MS = 120_000;
const HOOK_TIMEOUT_MS = 30_000;
/** Variables that would point a child at a cloud graph or a saved login. */
const CLOUD_VARS = ['ALIGN_TOKEN', 'ALIGN_TENANT_ID', 'ALIGN_GATEWAY_URL', 'ALIGN_ENV'] as const;

/**
 * The environment every child runs in: each variable a platform uses to find "home" points inside
 * the temp root (POSIX HOME and XDG, Windows USERPROFILE and APPDATA), so nothing can land in the
 * caller's ~/.align. Cloud-pointing variables are dropped, and telemetry is off for the children
 * (the caller's own DO_NOT_TRACK and friends pass through untouched).
 */
export function isolatedEnv(root: string, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const home = join(root, 'home');
  const env: Record<string, string | undefined> = {
    ...base,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    ALIGN_TELEMETRY: '0',
  };
  for (const k of CLOUD_VARS) delete env[k];
  return env;
}

/** What the edit hook printed, read as the agent reads it. Null when it printed nothing. */
export function hookReply(stdout: string): { text: string } | null {
  const raw = stdout.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { hookSpecificOutput?: { additionalContext?: unknown } };
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    if (typeof ctx === 'string' && ctx.trim()) return { text: ctx.trim() };
  } catch {
    // Not JSON: the text format. Show it as printed.
  }
  return { text: raw };
}

/**
 * Run this same CLI again. Compiled binaries have no script argument, so only a script entry gets
 * one. execArgv is carried so a run under a loader (tsx in the tests) re-enters through it.
 */
function selfInvocation(): { cmd: string; args: string[] } {
  const entry = process.argv[1];
  const compiled = !entry || /\$bunfs|~BUN/i.test(entry);
  return compiled ? { cmd: process.execPath, args: [] } : { cmd: process.execPath, args: [...process.execArgv, entry] };
}

const defaultRun: Run = (cmd, args, o) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      done({ code: null, stdout, stderr: `${stderr}timed out after ${Math.round(o.timeoutMs / 1000)}s`.trim() });
    }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (error: Error & { code?: string }) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr, error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(o.input ?? '');
  });

function tail(text: string, lines = 6): string {
  return text.trim().split(/\r?\n/).slice(-lines).map((l) => `    ${l}`).join('\n');
}

function indent(text: string, pad = '      '): string {
  return text.split(/\r?\n/).map((l) => `${pad}${l}`).join('\n');
}

function hookPayload(cwd: string, edit: { file: string; content: string }): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    cwd,
    tool_input: { file_path: edit.file, content: edit.content },
  });
}

/** Never delete anything that is not the directory this run made. */
function removeTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export async function runDemo(opts: DemoOptions, deps: DemoDeps = {}): Promise<number> {
  const run = deps.run ?? defaultRun;
  const say = deps.write ?? ((l: string) => console.log(l));
  const align = deps.align ?? selfInvocation();

  // Git is how the bundled repo gets its history. Checked before anything is made.
  const git = await run('git', ['--version'], { cwd: deps.tmpRoot ?? tmpdir(), env: process.env, timeoutMs: 15_000 });
  if (git.error || git.code !== 0) {
    say('align demo needs git, and it was not found on this machine.');
    say('Install git (https://git-scm.com/downloads), open a new terminal, and run align demo again.');
    return 1;
  }

  const root = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'align-demo-'));
  const repo = join(root, 'repo');
  const env = isolatedEnv(root);
  try {
    say('align demo: watch Align catch a decision before an agent edits your code.');
    say('Everything runs in a temp folder. Your repo and ~/.align are not touched, and no account or AI key is used.');
    say('The first run may download a small on-device model (about 50 MB, once) if it is not on this machine yet.');
    say('');

    mkdirSync(join(root, 'home'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    for (const f of DEMO_FILES) {
      const full = join(repo, ...f.path.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f.content, 'utf8');
    }

    const gitStep = async (label: string, args: string[]): Promise<boolean> => {
      const r = await run('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd: repo, env, timeoutMs: STEP_TIMEOUT_MS });
      if (r.error || r.code !== 0) {
        say(`The demo could not set up its repo (${label}).`);
        say(tail(`${r.stderr}${r.error?.message ?? ''}`));
        return false;
      }
      return true;
    };
    const author = ['-c', 'user.name=Align Demo', '-c', 'user.email=demo@example.invalid'];
    const stepsOk =
      (await gitStep('git init', ['init', '-q', '-b', 'main'])) &&
      (await gitStep('git add', ['add', '-A'])) &&
      (await gitStep('git commit', [...author, 'commit', '-q', '-m', DEMO_COMMIT_SUBJECT, '-m', DEMO_COMMIT_BODY]));
    if (!stepsOk) return 1;

    say('1. Setting up a throwaway repo and a local decision graph...');
    const started = Date.now();
    for (const step of [['local', 'start'], ['connect', 'git', '--env', 'local', '--approve'], ['connect', 'docs', '--env', 'local', '--approve']]) {
      const r = await run(align.cmd, [...align.args, ...step], { cwd: repo, env, timeoutMs: STEP_TIMEOUT_MS });
      if (r.error || r.code !== 0) {
        say(`   The setup step "align ${step.join(' ')}" failed.`);
        say(tail(`${r.stderr}\n${r.stdout}${r.error?.message ?? ''}`));
        say('   If you are offline, the on-device model could not be downloaded. Connect and run align demo again.');
        return 1;
      }
    }
    say(`   Done in ${((Date.now() - started) / 1000).toFixed(1)}s. The repo has one commit, "${DEMO_COMMIT_SUBJECT}", and a CLAUDE.md rule that says the same.`);
    say('');

    const hook = (edit: { file: string; content: string }): Promise<RunResult> =>
      run(align.cmd, [...align.args, 'check', '--advisory', '--env', 'local'], { cwd: repo, env, input: hookPayload(repo, edit), timeoutMs: HOOK_TIMEOUT_MS });

    say(`2. An agent is about to add module-level state in ${DEMO_EDITS.violating.file}:`);
    say(indent(DEMO_EDITS.violating.content.trimEnd()));
    const hit = await hook(DEMO_EDITS.violating);
    const reply = hookReply(hit.stdout);
    if (!reply) {
      say('   The edit hook did not surface any decision for this edit, which is not what this demo is meant to show.');
      say(tail(hit.stderr || hit.error?.message || '(no output)'));
      return 1;
    }
    say('   This is what Align puts in front of the agent before the edit is written:');
    say(indent(reply.text, '   | '));
    say('');

    say(`3. Now a harmless edit in ${DEMO_EDITS.harmless.file}, which touches no state:`);
    say(indent(DEMO_EDITS.harmless.content.trimEnd()));
    const quiet = hookReply((await hook(DEMO_EDITS.harmless)).stdout);
    if (quiet) {
      say('   The harmless edit was not silent, so this run is not a fair demo:');
      say(indent(quiet.text, '   | '));
      return 1;
    }
    say('   Align says nothing. It speaks only when an edit is near a decision.');
    say('');

    say('To run Align on your own repo:');
    say('   cd your-repo && align');
    return 0;
  } finally {
    if (opts.keep) {
      say('');
      say(`Kept the demo folder: ${root}`);
      say(`   (the throwaway graph is in ${join(root, 'home', '.align')})`);
    } else {
      removeTemp(root);
    }
  }
}
