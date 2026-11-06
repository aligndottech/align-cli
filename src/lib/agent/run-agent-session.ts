import os from 'node:os';
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
import { launchAlignEntry } from '../trusted-align-bin.js';
import { gateEdit } from './edit-gate.js';
import { decisionsThatWroteTheseLines } from './edit-text.js';
import { type ClaudeCodeOpts, createClaudeCodeEngine } from './engines/claude-code.js';
import { type ResolvedPiModel, resolvePiModel } from './engines/pi-models.js';
import { createGraphTools, type GraphToolSpec } from './graph-tools.js';
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
  graphTools: () => GraphToolSpec[];
  countDecisions: () => number;
  loadPiEngine: () => Promise<{ createPiEngine: (o: { cwd: string; stateDir: string; model: ResolvedPiModel; tools: GraphToolSpec[] }) => Promise<AgentEngine> }>;
  createClaudeCodeEngine: (o: ClaudeCodeOpts) => AgentEngine;
  runAgentUi: (o: AgentUiOptions) => Promise<number>;
  record: (agent: 'align' | 'claude-code') => void;
}

const NOTHING_TO_RUN = [
  'Align needs a model to run its own agent, or your own Claude Code.',
  '  Add an API key:        align ai',
  '  Use a local model:     ollama pull qwen2.5:7b',
  '  Or install Claude Code (your subscription works): https://claude.com/claude-code',
];
const CANNOT_RUN: Record<EngineName, string> = {
  align: 'Align\'s own engine has no model. Add a key with `align ai`, or start Ollama.',
  claude: 'Claude Code is not installed (no `claude` on PATH).',
};

function claudeArgs(state: { projectHasMcp: boolean; projectHasBlock: boolean }): string[] {
  const args: string[] = [];
  if (!state.projectHasBlock) args.push('--append-system-prompt', alignNudgeBody());
  // Last, because claude's --mcp-config is variadic. Named align-local so it never replaces a
  // server the user configured as `align` (see adapters/claude-code.ts).
  if (!state.projectHasMcp) args.push('--mcp-config', JSON.stringify({ mcpServers: { 'align-local': launchAlignEntry('mcpServers') } }));
  return args;
}

export async function runAgentSession(opts: { engine?: EngineName }, deps: SessionDeps = defaultSessionDeps()): Promise<number> {
  const model = await deps.resolveModel();
  const claudeBin = deps.findClaude();
  const choice = selectEngine({ flag: opts.engine, remembered: deps.getRemembered(), hasModel: model !== undefined, claudeOnPath: claudeBin !== null });
  if (choice.engine === 'none') {
    (choice.unavailable ? [CANNOT_RUN[choice.unavailable]] : NOTHING_TO_RUN).forEach((l) => deps.out(l));
    return 1;
  }
  if (opts.engine) deps.remember(opts.engine);

  const claude = (): AgentEngine => deps.createClaudeCodeEngine({
    cwd: deps.cwd,
    bin: claudeBin ?? 'claude',
    extraArgs: claudeArgs(deps.projectState()),
    // The user's own environment, not Align's: a key Align saved stays out of `claude`, and
    // ALIGN_WRAPPED stops an `align` run inside it from opening a second agent.
    env: childEnv(deps.env, deps.startupEnv, { ALIGN_WRAPPED: '1' }),
  });

  let engine: AgentEngine;
  let agent: 'align' | 'claude-code' = choice.engine === 'align' ? 'align' : 'claude-code';
  if (choice.engine === 'align' && model) {
    try {
      const { createPiEngine } = await deps.loadPiEngine();
      engine = await createPiEngine({ cwd: deps.cwd, stateDir: alignConfigDir(), model, tools: deps.graphTools() });
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
  return deps.runAgentUi({ engine, decisionCount: deps.countDecisions(), gate: deps.makeGate() });
}

export function defaultSessionDeps(): SessionDeps {
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
    graphTools: () => createGraphTools({ client, env: localEnv }),
    countDecisions: () => {
      if (!localEnv.localDbPath) return 0;
      const db = createLocalDb(localEnv.localDbPath);
      try { return db.getStats().decisions; } finally { db.close(); }
    },
    loadPiEngine: () => import('./engines/pi.js'),
    createClaudeCodeEngine,
    runAgentUi,
    record: (agent) => {
      void import('../usage-telemetry.js')
        .then((m) => m.recordFunnelStage(localEnv, 'agent_launched', 'align', { agent }))
        .catch(() => undefined);
    },
  };
}
