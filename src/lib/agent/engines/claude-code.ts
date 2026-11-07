import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from 'node:child_process';
import type { AgentEngine, AgentUiEvent, BrokerVerdict, ToolAsk } from '../types.js';
import { buildArgs, controlResponse, initializeLine, interruptLine, parseLine, userMessageLine } from './claude-code-protocol.js';

export interface ClaudeCodeOpts {
  cwd: string;
  bin?: string;
  extraArgs?: string[];
  /** Exactly the child's env. The caller passes the user's startup env so a key Align saved never reaches `claude`. */
  env: Record<string, string | undefined>;
  spawn?: typeof nodeSpawn;
  firstEventTimeoutMs?: number;
}

const NOT_INSTALLED = 'Claude Code is not installed (no `claude` on PATH)';
const KILL_AFTER_MS = 2000;

/**
 * Drives the user's own, unmodified `claude` over stream-json. Align never touches its auth or
 * model: it only answers the permission questions `claude` asks the host.
 */
export function createClaudeCodeEngine(opts: ClaudeCodeOpts): AgentEngine {
  const spawnFn = opts.spawn ?? nodeSpawn;
  const firstEventTimeoutMs = opts.firstEventTimeoutMs ?? 20000;
  let child: ChildProcessWithoutNullStreams | undefined;
  let exitMessage: string | undefined;
  let pending: { resolve: () => void; reject: (e: Error) => void } | undefined;
  let emit: (e: AgentUiEvent) => void = () => {};
  let broker: (ask: ToolAsk) => Promise<BrokerVerdict> = async () => ({ allow: true });
  let stderrTail = '';
  let initTimer: ReturnType<typeof setTimeout> | undefined;
  let buffer = '';
  let interrupts = 0;

  const send = (text: string) => { child?.stdin.write(text); };

  async function answer(requestId: string, ask: ToolAsk, input: Record<string, unknown>) {
    let verdict: BrokerVerdict;
    try { verdict = await broker(ask); } catch (err) {
      // Never leave `claude` waiting on a question nobody will answer.
      verdict = { allow: false, message: `Align could not check this action (${err instanceof Error ? err.message : String(err)}). Do not retry it.` };
    }
    send(controlResponse(requestId, verdict, input));
  }

  function onLine(raw: string) {
    if (!raw.trim()) return;
    const parsed = parseLine(raw);
    if (parsed.init) clearTimeout(initTimer);
    for (const e of parsed.events) {
      emit(e);
      if (e.type === 'turn-end') { pending?.resolve(); pending = undefined; }
    }
    if (parsed.permission) void answer(parsed.permission.requestId, parsed.permission.ask, parsed.permission.input);
  }

  return {
    label: 'Claude Code',

    start(onEvent, onAsk) {
      emit = onEvent;
      broker = onAsk;
      return new Promise<void>((resolve, reject) => {
        const c = spawnFn(opts.bin ?? 'claude', buildArgs(opts.extraArgs), { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
        child = c;
        c.stdout.on('data', (d: Buffer) => {
          buffer += String(d);
          let i: number;
          while ((i = buffer.indexOf('\n')) >= 0) { const l = buffer.slice(0, i); buffer = buffer.slice(i + 1); onLine(l); }
        });
        c.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + String(d)).slice(-500); });
        // A claude that died mid-write breaks the pipe. The 'exit' handler reports the death;
        // an unhandled stream error here would crash Align instead.
        c.stdin.on('error', () => {});
        c.once('error', (err: Error & { code?: string }) => {
          const message = err.code === 'ENOENT' ? NOT_INSTALLED : err.message;
          emit({ type: 'error', message });
          reject(new Error(message));
        });
        c.once('exit', (code, signal) => {
          clearTimeout(initTimer);
          exitMessage = `Claude Code exited (${signal ? `signal ${signal}` : `code ${code}`})${stderrTail.trim() ? `: ${stderrTail.trim()}` : ''}`;
          if (pending) {
            emit({ type: 'error', message: exitMessage });
            pending.reject(new Error(exitMessage));
            pending = undefined;
          }
        });
        c.once('spawn', () => {
          send(initializeLine(`init-${Date.now()}`));
          // A claude that never starts ends the run: the waiting turn fails, the child is stopped,
          // and later prompts are refused with the same reason, so the screen never hangs.
          initTimer = setTimeout(() => {
            exitMessage = `Claude Code did not start within ${Math.round(firstEventTimeoutMs / 1000)}s. Run \`claude --version\` to check it works.`;
            emit({ type: 'error', message: exitMessage });
            pending?.reject(new Error(exitMessage));
            pending = undefined;
            c.kill();
          }, firstEventTimeoutMs);
          resolve();
        });
      });
    },

    prompt(text) {
      if (exitMessage) return Promise.reject(new Error(exitMessage));
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
        send(userMessageLine(text));
      });
    },

    // Verified against claude 2.1.318: it answers with a result line (error_during_execution), which
    // ends the turn through the normal path, and the process stays up for the next prompt.
    abort() { send(interruptLine(`int-${++interrupts}`)); },

    close() {
      const c = child;
      if (!c || exitMessage) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const killer = setTimeout(() => c.kill(), KILL_AFTER_MS);
        c.once('exit', () => { clearTimeout(killer); resolve(); });
        c.stdin.end();
      });
    },
  };
}
