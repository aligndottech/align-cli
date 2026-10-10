/**
 * L3: the MCP tool `align_backfill({ source, since })` - read more history from a source the
 * user already connected.
 *
 * What it does, and what it cannot:
 * - A connected, healthy source: record the window in `source_sync` and start the SAME command
 *   a person would type (`align connect --source <id> --since <when> --yes --json`) as a
 *   detached child (Decision 9). A tool call never runs a bulk fetch in the MCP server's own
 *   process, and it returns inside journey 5's 500 ms.
 * - Not connected, or waiting on re-authentication: start nothing and return the exact command
 *   for the human. Connecting, re-authenticating and every token or key stay with the person
 *   (Decision 16): the input schema is closed, so a `token` property is refused before anything
 *   else happens, and no credential is ever read into, echoed by, or passed on argv from here.
 * - It never classifies. `align connect` imports with the classifier off (L1); this adds no
 *   other path.
 *
 * Not here yet (L5): the detached `align sync --background` child, the lock, and progress via
 * `align_sync`. Until then the child is `align connect`, which has no lock and writes no
 * watermark, so two backfills of one source can overlap. The import is an upsert, so overlap
 * costs time and never duplicates a row.
 */
import { spawn } from 'node:child_process';
import type { EnvironmentConfig } from './config.js';
import { createConfigStore } from './config.js';
import { SYNC_CEILINGS, SYNC_WINDOW_DEFAULT_DAYS } from './import-defaults.js';
import { parseSince } from './since.js';
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
      since: { type: 'string', description: 'How far back: 30d, 2w, 6m, 1y or all. Default 6m. A ceiling per source still applies' },
    },
    required: ['source'],
    additionalProperties: false,
  },
} as const;

export interface BackfillDeps {
  now(): Date;
  isConnected(source: string): boolean;
  needsReauth(source: string): boolean;
  recordWindow(source: string, since: string | null, agent: string): void;
  /** Start `align <argv>` detached. Must not wait for it. */
  startConnect(argv: string[]): void;
}

export interface BackfillResult {
  started: boolean;
  text: string;
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
    recordWindow: (source, since, agent) => recordWindowSince(need(), source, since, agent),
    startConnect: (argv) => {
      // process.argv[1] is this CLI's own entry point, however it was installed; execPath is a
      // real executable on Windows too (check.ts spawns the deferred adjudicator the same way).
      const child = spawn(process.execPath, [process.argv[1] ?? 'align', ...argv], { detached: true, stdio: 'ignore' });
      // spawn reports failure asynchronously; an unhandled 'error' would take the MCP server down.
      child.on('error', () => {});
      child.unref();
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
    const names = unknownKeys.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 40))).join(', ');
    throw new Error(
      `${BACKFILL_TOOL} takes only "source" and "since", and does not accept ${names}. ` +
      'It never accepts a token or key: the person connects a source themselves with `align connect <source>`.',
    );
  }
  const source = input['source'];
  if (typeof source !== 'string' || !(BACKFILL_SOURCES as readonly string[]).includes(source)) {
    throw new Error(
      `${BACKFILL_TOOL} requires "source", one of: ${BACKFILL_SOURCES.join(', ')}. ${
        typeof source === 'string' && source ? `Got "${source.slice(0, 40)}".` : 'Call it again with one of those.'}`,
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

  deps.recordWindow(source, window.since ?? null, UNKNOWN_AGENT);
  deps.startConnect(['connect', '--source', source, '--since', sinceArg, '--yes', '--json']);
  const reach = window.since === undefined
    ? `as far back as the ceiling allows (${SYNC_CEILINGS[source as BackfillSource]} items)`
    : `back to ${window.since.slice(0, 10)}`;
  return {
    started: true,
    text: `Backfill started for ${source} ${reach}. It runs in the background on this machine, only reads, and makes no LLM calls. New items appear in align_ask as they land.`,
  };
}
