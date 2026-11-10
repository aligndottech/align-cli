import os from 'node:os';
import path from 'node:path';
import { confirm, isCancel } from '@clack/prompts';
import { alignNudgeBody } from '../agent-rules.js';
import { createConfigStore, savedLlmConfig } from '../config.js';
import { createGatewayClient } from '../gateway-client.js';
import { findOnPath } from '../launch/detect.js';
import { isLocalDefault } from '../launch/launch.js';
import { readProjectState } from '../launch/project-state.js';
import { childEnv } from '../launch/run-agent.js';
import { createLocalDb } from '../local-db.js';
import { hasConfiguredProvider, probeOllama } from '../local-llm.js';
import { alignConfigDir } from '../private-files.js';
import { STARTUP_ENV } from '../startup-env.js';
import { applyBackgroundPlan, failedReadLines, planBackgroundSync } from '../sync/launch-hook.js';
import { readSummary } from '../sync/summary-read.js';
import { launchAlignEntry } from '../trusted-align-bin.js';
import { ASK_ONCE_GUIDANCE } from './agent-guidance.js';
import { gateEdit } from './edit-gate.js';
import { decisionsThatWroteTheseLines } from './edit-text.js';
import { gitConfigRunsPrograms } from './git-runs-programs.js';
import { type ClaudeCodeOpts, createClaudeCodeEngine } from './engines/claude-code.js';
import { type ResolvedPiModel, resolvePiModel } from './engines/pi-models.js';
import { createGraphTools, type GraphToolSpec } from './graph-tools.js';
import { repoHasHarness, trustedDir } from './trusted-folder.js';
import { type EngineName, selectEngine } from './select-engine.js';
import { type AgentUiOptions, runAgentUi } from './tui/app.js';
import type { AgentEngine, GateOutcome, ToolAsk } from './types.js';

/**
 * The composition root for Align's own agent: picks the engine, builds the edit gate over the
 * local graph, and hands both to Align's UI. Everything with a side effect is a dependency, so
 * the wiring is tested without a terminal, a provider or a `claude` binary.
 */
export interface SessionDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  startupEnv: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  getRemembered: () => EngineName | undefined;
  remember: (engine: EngineName) => void;
  resolveModel: () => Promise<ResolvedPiModel | undefined>;
  findClaude: () => string | null;
  projectState: () => { projectHasMcp: boolean; projectHasBlock: boolean };
  makeGate: () => (ask: ToolAsk) => Promise<GateOutcome>;
  gitRunsPrograms: () => Promise<boolean>;
  graphTools: () => GraphToolSpec[];
  countDecisions: () => number;
  loadPiEngine: () => Promise<{ createPiEngine: (o: { cwd: string; stateDir: string; model: ResolvedPiModel; tools: GraphToolSpec[]; trustedDir?: string }) => Promise<AgentEngine> }>;
  createClaudeCodeEngine: (o: ClaudeCodeOpts) => AgentEngine;
  runAgentUi: (o: AgentUiOptions) => Promise<number>;
  record: (agent: 'align' | 'claude-code') => void;
  /** Starts the 15-minute refresh of connected sources if one is due, and returns its lines for the screen. */
  backgroundSync: () => string[];
  /** The folder whose trust the user accepted in Claude Code, or undefined. Fails closed. */
  trustedDir: () => string | undefined;
  /** Does the repo root hold .claude, .agents or .pi content that trust would load? */
  repoHasHarness: () => boolean;
}

const NOTHING_TO_RUN = [
  'Align needs a model to run its own agent, or your own Claude Code.',
  '  Add an API key:        align ai',
  '  Use a local model:     ollama pull qwen2.5:7b',
  '  Or install Claude Code (your subscription works): https://claude.com/claude-code',
];
const OPEN_IT = 'Open it in Claude Code once and accept the trust prompt to load them.';
const NOTICES = {
  'claude-code': {
    trusted: "Loaded this repo's own settings, hooks and skills (trusted in Claude Code).",
    untrusted: `This repo isn't trusted in Claude Code, so its hooks, settings and skills stay off. ${OPEN_IT}`,
  },
  align: {
    trusted: "Loaded this repo's skills and prompts (trusted in Claude Code).",
    untrusted: `This repo isn't trusted in Claude Code, so its skills and prompts stay off. ${OPEN_IT}`,
  },
} as const;
const CANNOT_RUN: Record<EngineName, string> = {
  align: 'Align\'s own engine has no model. Add a key with `align ai`, or start Ollama.',
  claude: 'Claude Code is not installed (no `claude` on PATH).',
};

function claudeArgs(state: { projectHasMcp: boolean; projectHasBlock: boolean }): string[] {
  const args: string[] = [];
  args.push('--append-system-prompt', [...(state.projectHasBlock ? [] : [alignNudgeBody()]), ASK_ONCE_GUIDANCE].join('\n\n'));
  // Last, because claude's --mcp-config is variadic. Named align-local so it never replaces a
  // server the user configured as `align` (see adapters/claude-code.ts).
  if (!state.projectHasMcp) args.push('--mcp-config', JSON.stringify({ mcpServers: { 'align-local': launchAlignEntry('mcpServers') } }));
  return args;
}

/** Opens the chosen agent engine with Align's gate. `notices` are shown under the header (background reads, failed reads). Returns the exit code. */
export async function runAgentSession(opts: { engine?: EngineName; notices?: string[] }, deps: SessionDeps = defaultSessionDeps()): Promise<number> {
  const model = await deps.resolveModel();
  const claudeBin = deps.findClaude();
  const choice = selectEngine({ flag: opts.engine, remembered: deps.getRemembered(), hasModel: model !== undefined, claudeOnPath: claudeBin !== null });
  if (choice.engine === 'none') {
    (choice.unavailable ? [CANNOT_RUN[choice.unavailable]] : NOTHING_TO_RUN).forEach((l) => deps.out(l));
    return 1;
  }
  if (opts.engine) deps.remember(opts.engine);

  const trustedDir = deps.trustedDir();
  const trusted = trustedDir !== undefined;
  const claude = (): AgentEngine => deps.createClaudeCodeEngine({
    cwd: deps.cwd,
    bin: claudeBin ?? 'claude',
    extraArgs: claudeArgs(deps.projectState()),
    trusted,
    // The user's own environment, not Align's: a key Align saved stays out of `claude`, and
    // ALIGN_WRAPPED stops an `align` run inside it from opening a second agent.
    env: childEnv(deps.env, deps.startupEnv, { ALIGN_WRAPPED: '1' }),
  });

  let engine: AgentEngine;
  let agent: 'align' | 'claude-code' = choice.engine === 'align' ? 'align' : 'claude-code';
  if (choice.engine === 'align' && model) {
    try {
      const { createPiEngine } = await deps.loadPiEngine();
      engine = await createPiEngine({ cwd: deps.cwd, stateDir: alignConfigDir(), model, tools: deps.graphTools(), trustedDir });
    } catch (err) {
      if (!claudeBin || opts.engine === 'align') {
        deps.out(`Align's own engine could not start: ${(err as Error).message}`);
        return 1;
      }
      deps.out(`Align's own engine could not start (${(err as Error).message}). Using your Claude Code instead.`);
      engine = claude();
      agent = 'claude-code';
    }
  } else {
    engine = claude();
  }

  deps.record(agent);
  // Bare `align` opens here, not through the launcher, so the refresh starts here too.
  const trustNotice = trusted ? NOTICES[agent].trusted : deps.repoHasHarness() ? NOTICES[agent].untrusted : undefined;
  let notices: string[] = [...(trustNotice === undefined ? [] : [trustNotice]), ...(opts.notices ?? [])];
  try { notices = [...notices, ...deps.backgroundSync()]; } catch { /* no refresh this time; the agent still opens */ }
  return deps.runAgentUi({ engine, decisionCount: deps.countDecisions(), gate: deps.makeGate(), gitRunsPrograms: deps.gitRunsPrograms, notices });
}

export function defaultSessionDeps(o: { home?: string; env?: Record<string, string | undefined> } = {}): SessionDeps {
  const config = createConfigStore();
  const localEnv = config.getEnvironment('local');
  const client = createGatewayClient(localEnv);
  const cwd = process.cwd();
  return {
    cwd,
    env: process.env,
    startupEnv: STARTUP_ENV,
    out: (l) => process.stderr.write(`${l}\n`),
    getRemembered: () => config.getAgentEngine(),
    remember: (e) => config.setAgentEngine(e),
    resolveModel: () => resolvePiModel({ saved: savedLlmConfig(config), probeOllama }),
    findClaude: () => findOnPath('claude', process.env, process.platform),
    projectState: () => readProjectState(cwd, os.homedir(), { localIsDefault: isLocalDefault() }),
    makeGate: () => (ask) => gateEdit(ask, {
      client,
      cwd,
      canAdjudicate: () => hasConfiguredProvider(),
      blame: (input, at) => decisionsThatWroteTheseLines(client, input, at),
    }),
    gitRunsPrograms: () => gitConfigRunsPrograms(cwd),
    graphTools: () => createGraphTools({ client, env: localEnv }),
    trustedDir: () => trustedDir(cwd, o.home ?? os.homedir(), o.env ?? process.env),
    repoHasHarness: () => repoHasHarness(cwd),
    countDecisions: () => {
      if (!localEnv.localDbPath) return 0;
      const db = createLocalDb(localEnv.localDbPath);
      try { return db.getStats().decisions; } finally { db.close(); }
    },
    // The engine is a one-time download on first use (pi-sdk.ts says why), asked for here, before
    // the screen opens. A no or a failure falls back like any engine that cannot start.
    loadPiEngine: async () => {
      const { defaultPiSdkDeps, loadPiSdk, PI_ENGINE_VERSION } = await import('./engines/pi-sdk.js');
      const sdk = await loadPiSdk(defaultPiSdkDeps({
        engineDir: path.join(alignConfigDir(), 'engine', PI_ENGINE_VERSION),
        confirm: async (message) => { const yes = await confirm({ message, initialValue: true }); return !isCancel(yes) && yes === true; },
      }));
      const { createPiEngine } = await import('./engines/pi.js');
      return { createPiEngine: (o) => createPiEngine(o, { sdk }) };
    },
    createClaudeCodeEngine,
    runAgentUi,
    backgroundSync: () => {
      const lines: string[] = [];
      const host = { env: process.env, home: os.homedir(), platform: process.platform, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), config, err: (l: string) => lines.push(l) };
      applyBackgroundPlan(planBackgroundSync(host), host);
      return [...lines, ...failedReadLines(readSummary())];
    },
    record: (agent) => {
      void import('../usage-telemetry.js')
        .then((m) => m.recordFunnelStage(localEnv, 'agent_launched', 'align', { agent }))
        .catch(() => undefined);
    },
  };
}
