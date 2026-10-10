/**
 * L3: the MCP tool `align_backfill({ source, since })` - read more history from a source the
 * user already connected.
 *
 * What it does, and what it cannot:
 * - A connected, healthy source: record the window in `source_sync` and start the SAME command
 *   a person would type (`align connect --env local --source <id> --since <when> --yes --json`) as a
 *   detached child (Decision 9). A tool call never runs a bulk fetch in the MCP server's own
 *   process, and it returns inside journey 5's 500 ms.
 * - Not connected, or waiting on re-authentication: start nothing and return the exact command
 *   for the human. Connecting, re-authenticating and every token or key stay with the person
 *   (Decision 16): the input schema is closed, so a `token` property is refused before anything
 *   else happens, and no credential is ever read into, echoed by, or passed on argv from here.
 * - It never classifies. `align connect` imports with the classifier off (L1); this adds no
 *   other path.
 *
 * Children are capped (one per source, three in all; backfill-state.ts) and leave a status file
 * under the state directory, so none is silently orphaned and `align_sync` (L5) can find them.
 * "Started" is claimed only after the OS confirmed the child, and the window is recorded after.
 *
 * Not here yet (L5): the `align sync --background` child, the lock and the watermark. Until then
 * the child is `align connect --env local`. The import is an upsert, so an overlap costs time and
 * never duplicates a row.
 */
import { backfillDir, type BackfillStatus, readStatus, type Reservation, reserveSlot, startBackfillChild, statusPath } from './backfill-state.js';
import type { EnvironmentConfig } from './config.js';
import { createConfigStore } from './config.js';
import { SYNC_CEILINGS, SYNC_WINDOW_DEFAULT_DAYS } from './import-defaults.js';
import { parseSince } from './since.js';
import { lockHolder } from './sync/lock.js';
import { readSyncStatus, recordWindowSince } from './source-sync-state.js';

export const BACKFILL_TOOL = 'align_backfill';

/** The sources `align connect --source` takes (the paste-token ones). Equal to
 *  `localConnectorIds()` by test; spelled here so the MCP server does not import setup.ts. */
export const BACKFILL_SOURCES = ['github', 'jira', 'confluence', 'slack', 'teams', 'gitlab', 'linear', 'notion'] as const;
type BackfillSource = (typeof BACKFILL_SOURCES)[number];

/** Attribution until LM maps the MCP client's `clientInfo.name` onto the registry's closed list.
 *  The closed value, never a free-text client name (Decision 16). */
const UNKNOWN_AGENT = 'unknown';

/** The tool as `tools/list` publishes it. Closed (`additionalProperties: false`) so a client that
 *  validates sees no place to put a secret, and runBackfill refuses one regardless. A write: it
 *  records a window and starts an import (mcp-tool-annotations.test.ts). */
export const BACKFILL_TOOL_SCHEMA = {
  name: BACKFILL_TOOL,
  annotations: { readOnlyHint: false, destructiveHint: false },
  description:
    'Import more history from a source the user has ALREADY connected (for example the last year of GitHub PRs) into the local graph on this machine. ' +
    'Offer it when the user asks for older context than the graph holds. It runs in the background, only reads from the source, and makes no LLM calls. ' +
    'It never takes a token or key: if the source is not connected, or its saved token was refused, nothing starts and the reply gives the exact `align connect <source>` command for the user to run themselves. ' +
    'Do not ask the user to paste a token into the chat.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: [...BACKFILL_SOURCES], description: 'Which connected source to read from' },
      since: { type: 'string', description: 'How far back: 30d, 2w, 6m, 1y or all. Default 180 days. A ceiling per source still applies' },
    },
    required: ['source'],
    additionalProperties: false,
  },
} as const;

export interface BackfillDeps {
  now(): Date;
  isConnected(source: string): boolean;
  needsReauth(source: string): boolean;
  /** Is a `align sync` of this source running? The two read and write the same history, so one waits for the other. */
  syncRunning?(source: string): boolean;
  recordWindow(source: string, since: string | null, agent: string): void;
  /** Take a slot SYNCHRONOUSLY (check and take in one tick, no await): MCP does not queue requests,
   *  so parallel calls would otherwise all pass the cap. Released when the child is confirmed
   *  (its status file then holds the slot) or has failed to start. */
  reserve(source: string): Reservation;
  /** How the previous backfill of this source ended, if it left a status file. */
  lastRun(source: string): BackfillStatus | null;
  /** Start `align <argv>` detached and wait briefly for the OS to confirm it exists. */
  start(source: string, argv: string[]): Promise<{ ok: boolean; pid?: number }>;
}

export interface BackfillResult {
  started: boolean;
  text: string;
}

/**
 * The child's arguments. `--env local` is not optional: for a logged-in user the default env is
 * hosted, where `align connect --since` is refused with exit 2 (the hosted scan takes --from/--to)
 * and, with stdio ignored, nobody would hear. check.ts spawns its child the same way (--env).
 */
export function backfillArgv(source: string, sinceArg: string): string[] {
  return ['connect', '--env', 'local', '--source', source, '--since', sinceArg, '--yes', '--json'];
}

export function defaultBackfillDeps(env: EnvironmentConfig): BackfillDeps {
  const config = createConfigStore();
  const dbPath = env.localDbPath;
  const need = (): string => {
    if (!dbPath) throw new Error('align_backfill needs the local graph path, and this server has none configured.');
    return dbPath;
  };
  return {
    now: () => new Date(),
    isConnected: (source) => Boolean(config.getConnectorFields('local', source)?.['token']),
    needsReauth: (source) => readSyncStatus(need(), source).needsReauth,
    syncRunning: (source) => lockHolder(`sync-${source}`) !== undefined,
    recordWindow: (source, since, agent) => recordWindowSince(need(), source, since, agent),
    reserve: (source) => {
      const dir = backfillDir();
      return dir ? reserveSlot(dir, source) : { ok: false, reason: 'state', running: [] };
    },
    lastRun: (source) => {
      const dir = backfillDir();
      return dir ? readStatus(statusPath(dir, source)) : null;
    },
    start: async (source, argv) => {
      const dir = backfillDir();
      if (!dir) return { ok: false };
      return startBackfillChild(source, argv, statusPath(dir, source));
    },
  };
}

export async function runBackfill(
  args: Record<string, unknown> | undefined,
  env: EnvironmentConfig,
  injected?: BackfillDeps,
): Promise<BackfillResult> {
  const input = args ?? {};
  const unknownKeys = Object.keys(input).filter((k) => k !== 'source' && k !== 'since');
  if (unknownKeys.length) {
    // Names the keys, never their values: a rejected token must not be echoed back into the
    // transcript it was typed into.
    const names = unknownKeys.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 16))).join(', ');
    throw new Error(
      `${BACKFILL_TOOL} takes only "source" and "since", and does not accept ${names}. ` +
      'It never accepts a token or key: the person connects a source themselves with `align connect <source>`.',
    );
  }
  const source = input['source'];
  if (typeof source !== 'string' || !(BACKFILL_SOURCES as readonly string[]).includes(source)) {
    throw new Error(
      // The value is never echoed: a token pasted into the wrong field fits any slice.
      `${BACKFILL_TOOL} requires "source", one of: ${BACKFILL_SOURCES.join(', ')}. Call it again with one of those.`,
    );
  }
  if (env.mode !== 'local-embedded') {
    throw new Error(
      `${BACKFILL_TOOL} fills the local graph on this machine, and this server reads a hosted Align graph. ` +
      'Use the local Align server (align mcp --env local), or run the hosted scan with align connect --all.',
    );
  }

  const rawSince = input['since'];
  if (rawSince !== undefined && typeof rawSince !== 'string') throw new Error(`${BACKFILL_TOOL}: "since" must be a string such as 6m or 1y.`);
  // Built only now, after every check that needs no config: a refused call opens nothing.
  const deps = injected ?? defaultBackfillDeps(env);
  const now = deps.now();
  const window = parseSince(rawSince, now); // throws SinceError naming the accepted forms
  const sinceArg = rawSince === undefined ? `${SYNC_WINDOW_DEFAULT_DAYS}d` : rawSince.trim().toLowerCase();

  // How the previous run of this source ended, said first: a dead token ended "done" would hide it.
  const prev = deps.lastRun(source);
  const say = (r: BackfillResult): BackfillResult =>
    prev?.state === 'failed' && prev.last_line ? { ...r, text: `Last run failed: ${prev.last_line}. ${r.text}` } : r;
  const proceed = async (): Promise<BackfillResult> => {
    if (!deps.isConnected(source)) {
      return {
        started: false,
        text: `${source} is not connected, so nothing was started. Connecting needs a token only the person can supply. Ask them to run: align connect ${source}`,
      };
    }
    if (source === 'teams') {
      // Decision 21: a Graph token lasts about an hour, so a background child would hold a dead one.
      return {
        started: false,
        text: `Teams tokens last about an hour, so a refresh is manual and nothing was started. Ask the person to run: align connect teams --since ${sinceArg}`,
      };
    }
    if (deps.needsReauth(source)) {
      return {
        started: false,
        text: `${source} needs the person to re-authenticate (the provider refused its saved token), so nothing was started. Ask them to run: align connect ${source}`,
      };
    }

    if (deps.syncRunning?.(source)) {
      return { started: false, text: `A sync of ${source} is running and reads the same history, so nothing new was started. Ask again when it has finished.` };
    }

    // Taken in this same synchronous stretch (nothing above awaits): five parallel calls cannot all pass.
    const slot = deps.reserve(source);
    if (!slot.ok) {
      if (slot.reason === 'state') {
        return { started: false, text: `The state directory for backfills could not be used safely, so nothing was started. The person can run it themselves: align connect ${source} --since ${sinceArg}` };
      }
      const names = [...new Set(slot.running.map((r) => r.source))].join(', ');
      return {
        started: false,
        text: slot.reason === 'source'
          ? `A backfill for ${source} is already running${slot.running[0]?.pid ? ` (started ${slot.running[0].started_at.slice(0, 16).replace('T', ' ')} UTC)` : ''}, so nothing new was started. It only reads and makes no LLM calls; ask again when it has finished.`
          : `${slot.running.length} backfills are already running (${names}), which is the most at once, so nothing new was started. Ask again when one has finished.`,
      };
    }
    let started: { ok: boolean; pid?: number };
    try {
      started = await deps.start(source, backfillArgv(source, sinceArg));
    } finally {
      slot.release();
    }
    if (!started.ok) {
      return {
        started: false,
        text: `The background process for ${source} could not start, so nothing was started. The person can run it themselves: align connect ${source} --since ${sinceArg}`,
      };
    }
    // Only now: the window is recorded for a child that exists.
    deps.recordWindow(source, window.since ?? null, UNKNOWN_AGENT);
    const reach = window.since === undefined
      ? `as far back as the ceiling allows (${SYNC_CEILINGS[source as BackfillSource]} items)`
      : `back to ${window.since.slice(0, 10)}`;
    const scope = source === 'github'
      ? " Inside a repo it reads everyone's PRs and issues in that repo, as far as their access allows; elsewhere only the person's own."
      : '';
    return {
      started: true,
      text: `Backfill started for ${source} ${reach}. It runs in the background on this machine, only reads, and makes no LLM calls.${scope} New items appear in align_ask as they land.`,
    };
  };
  return say(await proceed());
}
