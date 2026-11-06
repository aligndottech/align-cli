import { join, resolve } from 'node:path';
// Types only. The engine ships outside the npm install (a one-time download on first use, see
// pi-sdk.ts), so nothing here may load it at import time; the SDK is handed in instead.
import type * as PiCodingAgent from '@earendil-works/pi-coding-agent';
import type { DefaultResourceLoader, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { HookToolInput } from '../../hook-payload.js';
import type { GraphToolSpec } from '../graph-tools.js';
import type { AgentEngine, AgentUiEvent, BrokerVerdict, ToolAsk } from '../types.js';
import type { ResolvedPiModel } from './pi-models.js';

/**
 * Align's engine on Pi. EVERY Pi type stays in this file: Pi's minors break often, and the gate,
 * the broker and the UI only ever see the port in ../types.ts.
 */

const ALIGN_AGENT_SYSTEM_PROMPT = [
  "You are Align's coding agent. You work in the user's repository with read, bash, edit, write, grep, find and ls.",
  'You also have tools that read the team\'s decision graph: align_ask, align_search, align_get_topic_timeline and align_get_related_decisions.',
  'Ask the graph before you change behaviour a past decision may cover. Quote a decision by its title when it matters.',
  'Every edit is checked against the graph before it is written. If an edit is stopped, read the reason, say what it means, and change course. Do not retry the same edit.',
  'Follow the repository\'s own notes (AGENTS.md, CLAUDE.md). Keep answers short and plain.',
].join('\n');

const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

/**
 * The loader the Align engine runs on. A repository is untrusted input: Pi would otherwise load
 * `<cwd>/.pi/extensions`, skills, prompt templates and themes, run them with the user's full
 * permissions, and read `<cwd>/.pi/settings.json` for more. So none of that is discovered. The
 * settings are in-memory as well, so no project or home settings file reaches the session (the
 * hostile-repo test shows noExtensions already covers the settings route; this is the second
 * lock). Context files (AGENTS.md, CLAUDE.md) stay on: they are text, and the agent should
 * follow a repo's own notes.
 */
/** The parts of Pi's SDK the engine uses. */
export type PiSdk = Pick<typeof PiCodingAgent, 'DefaultResourceLoader' | 'ModelRuntime' | 'createAgentSession' | 'SessionManager' | 'SettingsManager'>;

export function createAlignResourceLoader(o: {
  sdk: PiSdk;
  cwd: string;
  agentDir: string;
  systemPrompt?: string;
  extensionFactories?: ExtensionFactory[];
}): DefaultResourceLoader {
  return new o.sdk.DefaultResourceLoader({
    cwd: o.cwd,
    agentDir: o.agentDir,
    settingsManager: o.sdk.SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: o.systemPrompt,
    extensionFactories: o.extensionFactories,
  });
}

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Pi's tool call, in Align's vocabulary. Paths resolve against the working directory, as Pi's own tools do. */
function toToolAsk(id: string, tool: string, input: Rec, cwd: string): ToolAsk {
  const abs = (p: string | undefined): string | undefined => (p === undefined ? undefined : resolve(cwd, p));
  if (tool === 'write') {
    const edit: HookToolInput = { file_path: abs(str(input['path'])), content: str(input['content']) };
    return { id, tool, kind: 'edit', edit };
  }
  if (tool === 'edit') {
    const edits = Array.isArray(input['edits']) ? (input['edits'] as Rec[]) : [];
    const edit: HookToolInput = {
      file_path: abs(str(input['path'])),
      edits: edits.map((e) => ({ old_string: str(e['oldText']), new_string: str(e['newText']) })),
    };
    return { id, tool, kind: 'edit', edit };
  }
  if (tool === 'bash' || tool === 'powershell') return { id, tool, kind: 'command', command: str(input['command']) ?? '' };
  // Align's own graph tools (all named align_*) only read the local graph, so they never interrupt.
  if (READ_TOOLS.has(tool) || tool.startsWith('align_')) return { id, tool, kind: 'read' };
  return { id, tool, kind: 'other', detail: JSON.stringify(input) };
}

type BrokerFn = (ask: ToolAsk) => Promise<BrokerVerdict>;

/**
 * The one inline extension: every tool call waits on the broker, and a denial blocks the call with
 * the broker's message, which Pi hands back to the model as the tool result. Fails CLOSED: no broker
 * yet (start() not called) or a broker that throws blocks the call, because "I could not ask" must
 * never read as "allowed".
 */
export function createToolGate(getBroker: () => BrokerFn | undefined, cwd: string): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      try {
        const broker = getBroker();
        if (!broker) return { block: true, reason: 'Align has not finished starting its edit check, so this call was stopped.' };
        const verdict = await broker(toToolAsk(event.toolCallId, event.toolName, event.input as Rec, cwd));
        return verdict.allow ? undefined : { block: true, reason: verdict.message };
      } catch (err) {
        return { block: true, reason: `Align's edit check failed (${err instanceof Error ? err.message : String(err)}), so this call was stopped.` };
      }
    });
  };
}

function graphToolDefinition(spec: GraphToolSpec): ToolDefinition {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    // The MCP inputSchema is plain JSON Schema, which is what a TypeBox schema is at runtime.
    parameters: spec.parameters as never,
    async execute(_id, params) {
      const text = await spec.run(params as Rec);
      return { content: [{ type: 'text', text }], details: undefined };
    },
  } as ToolDefinition;
}

const summaryOf = (args: Rec | undefined): string => str(args?.['command']) ?? str(args?.['path']) ?? str(args?.['file_path']) ?? '';

export interface PiEngineDeps {
  sdk: PiSdk;
  /** The module boundary tests inject, so nothing calls a provider. */
  createAgentSession?: PiSdk['createAgentSession'];
}

export async function createPiEngine(
  opts: { cwd: string; stateDir: string; model: ResolvedPiModel; tools: GraphToolSpec[] },
  deps: PiEngineDeps,
): Promise<AgentEngine> {
  const { sdk } = deps;
  const create = deps.createAgentSession ?? sdk.createAgentSession;
  const agentDir = join(opts.stateDir, 'agent');
  let broker: BrokerFn | undefined;
  let onEvent: (e: AgentUiEvent) => void = () => {};

  // No network at startup, and no login: the key is set in-process from what the user gave Align.
  // Pi's login is never called, so no subscription sign-in is reachable from here.
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  const { provider, modelId, apiKey, baseUrl } = opts.model;
  if (provider === 'ollama') {
    modelRuntime.registerProvider('ollama', {
      baseUrl,
      api: 'openai-completions',
      apiKey: apiKey ?? 'ollama',
      models: [{
        id: modelId, name: modelId, input: ['text'], reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768, maxTokens: 8_192,
      }],
    });
  } else if (apiKey) {
    await modelRuntime.setRuntimeApiKey(provider, apiKey);
  }
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Pi does not know the model ${provider}/${modelId}.`);

  const resourceLoader = createAlignResourceLoader({
    sdk,
    cwd: opts.cwd,
    agentDir,
    systemPrompt: ALIGN_AGENT_SYSTEM_PROMPT,
    extensionFactories: [createToolGate(() => broker, opts.cwd)],
  });
  await resourceLoader.reload();

  const { session } = await create({
    cwd: opts.cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader,
    settingsManager: sdk.SettingsManager.inMemory(),
    sessionManager: sdk.SessionManager.inMemory(opts.cwd),
    tools: [...BUILTIN_TOOLS, ...opts.tools.map((t) => t.name)],
    customTools: opts.tools.map(graphToolDefinition),
  });

  let turnEnded = false;
  const endTurn = (): void => { turnEnded = true; onEvent({ type: 'turn-end' }); };

  return {
    label: opts.model.label,
    async start(emit, ask) {
      onEvent = emit;
      broker = ask;
      session.subscribe((e) => {
        if (e.type === 'message_update') {
          if (e.assistantMessageEvent.type === 'text_delta') onEvent({ type: 'text', delta: e.assistantMessageEvent.delta });
        } else if (e.type === 'tool_execution_start') {
          onEvent({ type: 'tool-start', id: e.toolCallId, tool: e.toolName, summary: summaryOf(e.args as Rec) });
        } else if (e.type === 'tool_execution_end') {
          onEvent({ type: 'tool-end', id: e.toolCallId, ok: !e.isError });
        } else if (e.type === 'agent_end' && !e.willRetry) {
          // A provider failure (bad key, no credit) arrives as a message that ended in error, and
          // without this it would read as an empty turn.
          const last = [...e.messages].reverse().find((m) => (m as Rec)['role'] === 'assistant') as Rec | undefined;
          if (last?.['stopReason'] === 'error') onEvent({ type: 'error', message: str(last['errorMessage']) ?? 'The model call failed.' });
          endTurn();
        }
      });
    },
    async prompt(text) {
      turnEnded = false;
      try {
        await session.prompt(text);
      } catch (err) {
        onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        if (!turnEnded) endTurn();
      }
    },
    abort() {
      void session.abort();
    },
    async close() {
      session.dispose();
    },
  };
}
