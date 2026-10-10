/**
 * L5: the MCP tool `align_sync({ action })` - what the background refresh is doing, start it now,
 * or price the optional AI classification.
 *
 * What it does, and what it cannot:
 * - `status`: per source, scope, last success, status, items last run, discussion pending and
 *   skip counts, the manual-refresh note for Teams and the exact re-auth command for a refused
 *   token, and how many stored items wait for their links. Never an item's title, text or URL.
 * - `run`: starts the SAME detached child a person gets from `align sync --background` and returns
 *   (Decision 9). A tool call never runs a bulk fetch in the MCP server's own process, and it
 *   returns inside journey 5's 500 ms. A source already syncing, or being backfilled, is not
 *   started twice.
 * - `classify_estimate`: how many LLM calls typing the imported items would cost, and the command
 *   for the PERSON to run. There is no action that classifies: spending stays with the human
 *   (Decision 16). No LLM call is made, here or by the child `run` starts.
 * - Connecting or re-authenticating needs a token only the person can supply: nothing here takes
 *   one. The input schema is closed, so a `token` or `api_key` property is refused before anything runs.
 */
import { backfillDir, liveBackfills, pidAlive, readStatus, reserveSlot, statusPath } from './backfill-state.js';
import type { EnvironmentConfig } from './config.js';
import { createConfigStore } from './config.js';
import { BACKFILL_SOURCES } from './mcp-backfill.js';
import { estimateClassify } from './sync/classify.js';
import { scopeStatusHooks } from './scope-real.js';
import { lockHolder } from './sync/lock.js';
import { startSyncChild } from './sync/spawn-background.js';
import { readRows } from './sync/sync-state.js';
import { collectStatus, renderStatus, type SourceStatus, type StatusDeps, TEAMS_NOTE } from './sync/status.js';

export const SYNC_TOOL = 'align_sync';
export const SYNC_ACTIONS = ['status', 'run', 'classify_estimate'] as const;
type SyncAction = (typeof SYNC_ACTIONS)[number];
const DEFAULT_ESTIMATE_ITEMS = 25;

export const SYNC_TOOL_SCHEMA = {
  name: SYNC_TOOL,
  annotations: { readOnlyHint: false, destructiveHint: false },
  description:
    'Check on, or start, the refresh of the sources the user has ALREADY connected into the local graph on this machine. ' +
    'action "status" says per source when it last synced, whether it needs the person to re-authenticate, and what is still waiting; use it when the user asks whether the graph is up to date or why something is missing. ' +
    'action "run" starts a background refresh now (it only reads from the sources, makes no LLM calls, and returns at once). ' +
    'action "classify_estimate" says what typing the imported items with the user\'s own AI key would cost, plus the command for the user to run; it cannot start that. ' +
    'It never takes a token or key: for a source that is not connected, or whose saved token was refused, the reply gives the exact `align connect <source>` command for the user to run themselves. Do not ask the user to paste a token into the chat.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...SYNC_ACTIONS], description: 'What to do' },
      source: { type: 'string', enum: [...BACKFILL_SOURCES], description: 'With "run": only this source. Default: every connected source' },
      max: { type: 'integer', minimum: 1, maximum: 1000, description: 'With "classify_estimate": how many items the person would classify (default 25)' },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

export interface SyncToolDeps {
  dbPath: string;
  status: StatusDeps;
  needsReauth(source: string): boolean;
  syncRunning(source: string): boolean;
  backfillRunning(source: string): boolean;
  /** Take a slot per source SYNCHRONOUSLY, before the child exists (MCP does not queue calls, so parallel `run`s would all pass
   *  the lock check and start a child each). All or none: a refusal names the sources that are taken. */
  reserve?(sources: string[]): { ok: true; release(): void } | { ok: false; busy: string[] };
  start(sources: string[]): Promise<{ ok: boolean; pid?: number }>;
  estimate: typeof estimateClassify;
}

export interface SyncToolResult { text: string; [k: string]: unknown }

export function defaultSyncDeps(env: EnvironmentConfig): SyncToolDeps {
  const dbPath = env.localDbPath;
  if (!dbPath) throw new Error('align_sync needs the local graph path, and this server has none configured.');
  const config = createConfigStore();
  const dir = backfillDir();
  const status: StatusDeps = {
    dbPath, ...scopeStatusHooks(config),
    isConnected: (id) => Boolean(config.getConnectorFields('local', id)?.['token']),
    syncRunning: (id) => lockHolder(`sync-${id}`) !== undefined,
    backfill: (id) => (dir ? readStatus(statusPath(dir, id)) : null),
    backfillAlive: (s) => s.state === 'running' && pidAlive(s.pid),
  };
  return {
    dbPath, status,
    needsReauth: (id) => readRows(dbPath, id).some((r) => r.status === 'needs_reauth'),
    syncRunning: status.syncRunning,
    backfillRunning: (id) => dir !== null && liveBackfills(dir).some((s) => s.source === id),
    reserve: (sources) => {
      const dir = backfillDir();
      if (dir === null) return { ok: false, busy: sources };
      const taken: Array<{ release(): void }> = [];
      for (const s of sources) {
        const r = reserveSlot(dir, s);
        if (!r.ok) { for (const t of taken) t.release(); return { ok: false, busy: [s] }; }
        taken.push(r);
      }
      return { ok: true, release: () => { for (const t of taken) t.release(); } };
    },
    start: (sources) => startSyncChild(sources),
    estimate: estimateClassify,
  };
}

function isAction(v: unknown): v is SyncAction {
  return typeof v === 'string' && (SYNC_ACTIONS as readonly string[]).includes(v);
}

export async function runSyncTool(args: Record<string, unknown> | undefined, env: EnvironmentConfig, injected?: SyncToolDeps): Promise<SyncToolResult> {
  const input = args ?? {};
  const unknownKeys = Object.keys(input).filter((k) => k !== 'action' && k !== 'source' && k !== 'max');
  if (unknownKeys.length) {
    // Names the keys, never their values: a rejected token must not be echoed into the transcript it was typed into.
    const names = unknownKeys.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 16))).join(', ');
    throw new Error(
      `${SYNC_TOOL} takes only "action", "source" and "max", and does not accept ${names}. ` +
      'It never accepts a token or key: the person connects a source themselves with `align connect <source>`.',
    );
  }
  const action = input['action'];
  if (!isAction(action)) throw new Error(`${SYNC_TOOL} requires "action", one of: ${SYNC_ACTIONS.join(', ')}. Call it again with one of those.`);
  const source = input['source'];
  if (source !== undefined && (typeof source !== 'string' || !(BACKFILL_SOURCES as readonly string[]).includes(source))) {
    throw new Error(`${SYNC_TOOL} "source" must be one of: ${BACKFILL_SOURCES.join(', ')}.`);
  }
  const max = input['max'];
  if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 1000)) {
    throw new Error(`${SYNC_TOOL} "max" must be a whole number from 1 to 1000.`);
  }
  if (env.mode !== 'local-embedded') {
    throw new Error(
      `${SYNC_TOOL} refreshes the local graph on this machine, and this server reads a hosted Align graph. ` +
      'Use the local Align server (align mcp --env local); a hosted graph is refreshed by its connectors.',
    );
  }
  const d = injected ?? defaultSyncDeps(env);

  switch (action) {
    case 'status': {
      const r = collectStatus(d.status);
      return { text: renderStatus(r), sources: r.sources.filter((s: SourceStatus) => s.connected), rows_awaiting_relink: r.rows_awaiting_relink };
    }
    case 'run':
      return runAction(typeof source === 'string' ? source : undefined, d);
    case 'classify_estimate': {
      const e = d.estimate(d.dbPath, typeof max === 'number' ? max : DEFAULT_ESTIMATE_ITEMS);
      if (e.available === 0) return { text: 'Nothing to classify: no imported item has a close match that is still untyped.', available: 0 };
      if (e.provider === undefined) {
        return {
          text: `${e.available} imported items could be typed, but no AI provider is configured, so there is no estimate. Ask the person to run: align ai`,
          available: e.available,
        };
      }
      return {
        text: `Typing ${e.items} of ${e.available} imported items would use up to ${e.calls} LLM calls on your ${e.provider} key. Nothing was sent. To do it, ask the person to run: align sync --classify --max ${e.items}`,
        available: e.available, items: e.items, max_llm_calls: e.calls, command: `align sync --classify --max ${e.items}`,
      };
    }
  }
}

async function runAction(source: string | undefined, d: SyncToolDeps): Promise<SyncToolResult> {
  const connected = BACKFILL_SOURCES.filter((s) => d.status.isConnected(s));
  const wanted = source !== undefined ? [source] : connected.filter((s) => s !== 'teams');
  if (source !== undefined && !d.status.isConnected(source)) {
    return { started: false, text: `${source} is not connected, so nothing was started. Connecting needs a token only the person can supply. Ask them to run: align connect ${source}` };
  }
  if (source === 'teams') {
    return { started: false, text: `${TEAMS_NOTE} Nothing was started. Ask the person to run: align connect teams` };
  }
  if (wanted.length === 0) {
    return { started: false, text: 'No source is connected, so there is nothing to refresh. Ask the person to run: align connect <source>' };
  }
  const reauth = wanted.filter((s) => d.needsReauth(s));
  const busy = wanted.filter((s) => !reauth.includes(s) && (d.syncRunning(s) || d.backfillRunning(s)));
  const go = wanted.filter((s) => !reauth.includes(s) && !busy.includes(s));
  const notes: string[] = [];
  if (reauth.length) notes.push(`${reauth.join(', ')} ${reauth.length === 1 ? 'needs' : 'need'} the person to re-authenticate (the provider refused the saved token); ask them to run: ${reauth.map((s) => `align connect ${s}`).join(' ; ')}.`);
  if (busy.length) notes.push(`${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} already syncing or being backfilled, so nothing new was started for ${busy.length === 1 ? 'it' : 'them'}.`);
  if (go.length === 0) return { started: false, text: notes.join(' ') };
  const slot = d.reserve?.(go) ?? { ok: true as const, release: () => {} };
  if (!slot.ok) {
    return { started: false, text: `${slot.busy.join(', ')} ${slot.busy.length === 1 ? 'is' : 'are'} already being started or backfilled, so nothing new was started. ${notes.join(' ')}`.trim() };
  }
  let started: { ok: boolean; pid?: number };
  try {
    started = await d.start(go);
  } finally {
    slot.release();
  }
  if (!started.ok) {
    return { started: false, text: `The background process could not start, so nothing was started. The person can run it themselves: align sync ${go.join(' ')}`.trim() };
  }
  return {
    started: true,
    sources: go,
    text: `Refresh started for ${go.join(', ')}. It runs in the background on this machine, only reads, and makes no LLM calls. Call ${SYNC_TOOL} with action "status" to see how it is going.${notes.length ? ` ${notes.join(' ')}` : ''}`,
  };
}
