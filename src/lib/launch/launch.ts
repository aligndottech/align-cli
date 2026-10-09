import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createConfigStore } from '../config.js';
import { resolveEnv } from '../resolve-env.js';
import type { AgentName } from '../sessions/types.js';
import { agentByName, type LaunchAgent, resolveAgentBin, supportedAgents } from './agents.js';
import { buildClaudeLaunch, type LaunchSpec } from './adapters/claude-code.js';
import { buildCursorLaunch } from './adapters/cursor.js';
import { buildOpenCodeLaunch } from './adapters/opencode.js';
import { buildPiLaunch } from './adapters/pi.js';
import { applyConfigWrite, type ConfigWrite } from './config-writes.js';
import { type CursorProjectState, readCursorState } from './cursor-state.js';
import { findOnPath } from './detect.js';
import { launchCacheDir, writeIfChanged } from './launch-files.js';
import { type OpenCodeProjectState, readOpenCodeState } from './opencode-state.js';
import { type PiProjectState, readPiState } from './pi-state.js';
import { type ProjectState, readProjectState } from './project-state.js';
import { runAgent } from './run-agent.js';

/*
 * The launch path of bare `align`. COST RULE (performance.md, plan "Cost line"): nothing
 * reachable from here may import setup, the embedding model, the SQLite graph or the gateway
 * client, and nothing here may await the network before the spawn. launch-path-imports.test.ts
 * walks the static import graph to keep that true.
 */

export interface LaunchDeps {
  env: Record<string, string | undefined>;
  argv: string[];
  cwd: string;
  home: string;
  platform: string;
  isTTY: boolean;
  config: { getAgent(): string | undefined; setAgent(agent: string): void; isLaunchOff?(): boolean };
  findOnPath(bin: string, env: Record<string, string | undefined>, platform: string): string | null;
  readProjectState(cwd: string, home: string): ProjectState;
  /** What OpenCode would already load. Separate from readProjectState: it reads other files. */
  readOpenCodeState(cwd: string, home: string): OpenCodeProjectState;
  /** What pi would already load, and where its MCP file is. */
  readPiState(cwd: string, home: string, env: Record<string, string | undefined>): PiProjectState;
  /** What Cursor would already read. */
  readCursorState(cwd: string, home: string): CursorProjectState;
  /** Add to a file in the user's own agent config, once (C4). Lines go to `note`. */
  applyConfigWrite(w: ConfigWrite, note: (line: string) => void): void;
  cacheDir(env: Record<string, string | undefined>): string;
  writeIfChanged(dir: string, name: string, content: string): boolean;
  runAgent(spec: LaunchSpec): Promise<number>;
  /** Fire and forget: the caller never awaits what this returns. */
  record(agent: AgentName): void;
  /** Ask which agent. Only called on a TTY with more than one supported agent installed. */
  pick(candidates: LaunchAgent[]): Promise<AgentName | null>;
  /** Every line align itself writes on this path. stderr only: stdout belongs to the agent (`align -- -p ... | jq`). */
  err(line: string): void;
  now(): number;
}

export type LaunchResult = { handled: false } | { handled: true; code: number };

const set = (v: string | undefined): boolean => v !== undefined && v !== '';

/**
 * Whether an align command with no --env reads the local graph: the CLI's own resolver, so
 * ALIGN_ENV, the signed-in rule and the demo-mode rule all apply exactly as they do for `align ask`.
 */
export function isLocalDefault(): boolean {
  return resolveEnv(undefined, { preferLocalEmbedded: true }) === 'local';
}

function defaultDeps(): LaunchDeps {
  const config = createConfigStore();
  return {
    env: process.env,
    argv: process.argv,
    cwd: process.cwd(),
    home: os.homedir(),
    platform: process.platform,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    config,
    findOnPath,
    readProjectState: (cwd, home) => readProjectState(cwd, home, { localIsDefault: isLocalDefault() }),
    readOpenCodeState: (cwd, home) => readOpenCodeState(cwd, home, { localIsDefault: isLocalDefault() }, process.env),
    readPiState: (cwd, home, env) => readPiState(cwd, home, { localIsDefault: isLocalDefault() }, env),
    readCursorState: (cwd, home) => readCursorState(cwd, home, { localIsDefault: isLocalDefault() }),
    applyConfigWrite: (w, note) => applyConfigWrite(w, note, { has: (f) => config.wasWriteRefused(f), add: (f) => config.markWriteRefused(f), remove: (f) => config.unmarkWriteRefused(f) }),
    cacheDir: launchCacheDir,
    writeIfChanged,
    runAgent: (spec) => runAgent(spec),
    record: (agent) => {
      // Dynamic and un-awaited: telemetry consent rules live in recordFunnelStage, and none of
      // its network time may sit between the user and the agent.
      void import('../usage-telemetry.js')
        .then((m) => m.recordFunnelStage(config.getEnvironment('local'), 'agent_launched', 'align', { agent }))
        .catch(() => undefined);
    },
    pick: async (candidates) => {
      const clack = await import('@clack/prompts');
      const answer = await clack.select({
        message: 'Which coding agent should `align` open?',
        options: candidates.map((a) => ({ value: a.name, label: a.label })),
      });
      return clack.isCancel(answer) ? null : (answer as AgentName);
    },
    err: (l) => console.error(l),
    now: () => performance.now(),
  };
}

/** Args after `--`, and the operands before it (anything there is a typo, not an agent arg). */
function splitArgv(argv: string[]): { operands: string[]; passthrough: string[] } {
  const user = argv.slice(2);
  const sep = user.indexOf('--');
  const before = sep < 0 ? user : user.slice(0, sep);
  return { operands: before.filter((a) => !a.startsWith('-')), passthrough: sep < 0 ? [] : user.slice(sep + 1) };
}

interface BuildInput {
  passthrough: string[];
  cachePath(name: string): string;
}

/** One adapter per launchable agent. Each reads the project state ITS agent would load. */
const BUILDERS: Partial<Record<AgentName, (d: LaunchDeps, base: BuildInput) => LaunchSpec>> = {
  'claude-code': (d, base) => buildClaudeLaunch({ ...base, ...d.readProjectState(d.cwd, d.home) }),
  opencode: (d, base) => buildOpenCodeLaunch({ ...base, env: d.env, ...d.readOpenCodeState(d.cwd, d.home) }),
  pi: (d, base) => buildPiLaunch({ ...base, ...d.readPiState(d.cwd, d.home, d.env) }),
  cursor: (d, base) => buildCursorLaunch({ ...base, ...d.readCursorState(d.cwd, d.home) }),
};

/**
 * What bare `align` does once a local graph exists: open the user's coding agent with Align
 * wired in for that session only. Returns `handled: false` when the caller should show the
 * second-run card as before.
 */
export async function launchIfChosen(overrides: Partial<LaunchDeps> = {}): Promise<LaunchResult> {
  const d = { ...defaultDeps(), ...overrides };
  if (set(d.env['ALIGN_WRAPPED']) || set(d.env['ALIGN_NO_LAUNCH'])) return { handled: false };

  const { operands, passthrough } = splitArgv(d.argv);
  if (operands.length > 0) {
    d.err(`error: unknown command '${operands[0]}'`);
    d.err('Run `align --help` for the commands, or `align -- <args>` to pass arguments to your agent.');
    return { handled: true, code: 2 };
  }

  // No terminal and no explicit `align -- ...`: a pipe, a cron job or CI ran bare `align`. That
  // is not a request for an interactive session, so print the card as before and decide nothing.
  const explicit = d.argv.slice(2).includes('--');
  if (!d.isTTY && !explicit) return { handled: false };

  let agent = agentByName(d.config.getAgent());
  // `align use --undo` turned launching off: no auto-pick, no config writes, until `align use <agent>`.
  if (!agent && d.config.isLaunchOff?.()) {
    d.err('Launching is off after `align use --undo`. Run `align use <agent>` to turn it back on.');
    // Bare `align` shows the card; an explicit `align -- ...` asked for a session, so dropping
    // its arguments silently would be wrong (same rule as an agent that is not installed).
    return explicit ? { handled: true, code: 1 } : { handled: false };
  }
  const stored = agent !== undefined;
  let announce: string | undefined;
  if (!agent) {
    const installed = supportedAgents().filter((a) => resolveAgentBin(a, d.findOnPath, d.env, d.platform) !== null);
    if (installed.length === 0) {
      const works = supportedAgents();
      d.err(`No coding agent that Align can open was found on your PATH. Align works with: ${works.map((a) => a.label).join(', ')}.`);
      for (const a of works) d.err(`Install ${a.label}: ${a.install}`);
      d.err('Then run `align` again.');
      return { handled: true, code: 1 };
    }
    if (installed.length === 1) {
      agent = installed[0];
      announce = `Opening ${agent!.label}. Switch any time with \`align use\`.`;
    } else if (d.isTTY) {
      const choice = await d.pick(installed);
      agent = installed.find((a) => a.name === choice);
      if (!agent) return { handled: true, code: 1 };
    } else {
      d.err(`More than one coding agent is installed (${installed.map((a) => a.label).join(', ')}) and there is no terminal to ask in.`);
      d.err(`Choose one: align use <agent>   (${installed.map((a) => a.name).join(' | ')})`);
      d.err('Then run `align` again.');
      return { handled: true, code: 2 };
    }
  }

  const build = BUILDERS[agent!.name];
  if (!agent!.supported || !build) {
    d.err(`${agent!.label} launching is coming soon; showing your graph instead. Switch with \`align use\`.`);
    return { handled: false };
  }

  const resolved = resolveAgentBin(agent!, d.findOnPath, d.env, d.platform);
  const found = resolved?.path ?? null;
  if (!found) {
    // Reachable only for a stored choice (a fresh pick came from the installed list).
    d.err(`${agent!.label} is not installed any more. Run \`align use\` to pick another, or reinstall it.`);
    // Bare `align` falls back to the card; an explicit `align -- ...` asked for a session, so
    // dropping its arguments silently would be wrong.
    return explicit ? { handled: true, code: 127 } : { handled: false };
  }

  const dir = d.cacheDir(d.env);
  const built = build(d, { passthrough, cachePath: (name) => `${dir}/${name}` });
  // The adapter names the agent's usual binary; run whichever name is actually installed.
  const spec: LaunchSpec = resolved && resolved.bin !== built.bin ? { ...built, bin: resolved.bin } : built;
  try {
    for (const f of spec.files) d.writeIfChanged(dir, f.name, f.content);
  } catch (e) {
    d.err(`Could not write launch files (${(e as Error).message}). Showing your graph instead.`);
    return { handled: false };
  }
  // On win32 the resolved path is what tells runAgent it holds a .cmd shim.
  for (const n of spec.notes ?? []) d.err(n);
  const toRun: LaunchSpec = d.platform === 'win32' ? { ...spec, bin: found } : spec;

  if (set(d.env['ALIGN_LAUNCH_TRACE'])) d.err(`align-overhead-ms=${Math.round(d.now())}`);
  // A dry run measures; it must not change the machine, so nothing is persisted before this.
  if (set(d.env['ALIGN_LAUNCH_DRY_RUN'])) return { handled: true, code: 0 };

  if (!stored) d.config.setAgent(agent!.name);
  // Written-once agents (pi, Cursor): the one place align adds to the user's own config. Not
  // fatal: the session still opens, just without that piece.
  for (const w of spec.writes ?? []) {
    try {
      d.applyConfigWrite({ ...w, root: d.home }, d.err);
    } catch (e) {
      d.err(`Could not update ${w.file} (${(e as Error).message}). Opening ${agent!.label} without it.`);
    }
  }
  if (announce) d.err(announce);
  d.record(agent!.name);
  try {
    return { handled: true, code: await d.runAgent(toRun) };
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === 'ENOENT') {
      d.err(`${agent!.bin} is not on your PATH. Install it (${agent!.install}), or pick another: align use`);
      return { handled: true, code: 127 };
    }
    d.err(`align: ${err.message}`);
    return { handled: true, code: 2 };
  }
}
