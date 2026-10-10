/**
 * L4: the MCP tool `align_scope({ action, source, ... })` - see, or change, what the sources the user already connected read.
 *
 * What it does, and what it cannot:
 * - `view`: each connected source's scope (their own items, or everyone's in a named repo, project, team or space), with no network
 *   call and nothing secret.
 * - `set`: changes the scope of a CONNECTED source through `setScope`, the same function `align connect --scope` ends in, so a
 *   change by an agent takes exactly the path a person's does. It records `via = 'mcp'` and the agent id on the scope's row, returns
 *   the plain-words disclosure and what widening costs (a new scope re-reads the window), and never deletes an item.
 * - Listing choices (is this Jira project visible?) uses the saved token inside this process. The token never appears in a result.
 * - Connecting, re-authenticating and every token or key stay with the person: the input schema is closed, so a `token` or `api_key`
 *   property is refused before anything runs, and the reply for an unconnected source is the `align connect <source>` command.
 * - Zoom is only the user's own and says why. Slack, Notion and Teams already read all the token can see and have nothing to set.
 *
 * The server's `instructions` text is at its 2,048-byte budget, so the guidance for when to offer this tool lives here, in its description.
 */
import type { EnvironmentConfig } from './config.js';
import { type ScopeDeps, ScopeRefusal, type SetInput, setScope, viewScopes } from './scope.js';
import { UNKNOWN_AGENT } from './mcp/tool-rules.js';
import { realScopeDeps } from './scope-real.js';
import { SCOPED_SOURCES } from './scope-values.js';

export const SCOPE_TOOL = 'align_scope';
export const SCOPE_ACTIONS = ['view', 'set'] as const;
/** Every source that can be connected, so Zoom gets its own honest refusal instead of "unknown source". */
export const SCOPE_SOURCES = ['github', 'jira', 'confluence', 'slack', 'teams', 'gitlab', 'linear', 'notion', 'zoom'] as const;

/** The one value property each source takes for a team scope. */
const VALUE_PROPERTY = { github: 'repo', jira: 'projects', linear: 'teams', gitlab: 'gitlab_project', confluence: 'spaces' } as const;
const VALUE_PROPERTIES = Object.values(VALUE_PROPERTY);

export const SCOPE_TOOL_SCHEMA = {
  name: SCOPE_TOOL,
  annotations: { readOnlyHint: false, destructiveHint: false },
  description:
    'See, or change, what the sources the user has ALREADY connected read into the local graph on this machine: only their own items, or everyone\'s in one named GitHub repo, Jira project, Linear team, GitLab project or Confluence space that their token can see. ' +
    'action "view" lists each connected source\'s scope (and any change waiting for the person); use it when asked what is read or why teammates\' items are missing. ' +
    'action "set" changes one source; offer it when the user asks to include their team\'s items, or to go back to only their own. ' +
    'Widening re-reads that source\'s history on its next sync (a few minutes; the reply says how far back). ' +
    'It deletes nothing and reads other people\'s items onto this machine only. A team change you make WAITS: nothing reads it, in the background or via align_sync, until a person runs `align sync <source>` at a terminal, which shows what it reads and asks (default No). Tell them so, with the reply\'s disclosure sentence in your own words. That prompt is a speed bump, not proof of consent: an agent with shell access could answer it from a pseudo-terminal, and you must never do that. Narrowing to their own items is immediate. ' +
    'Zoom is only the user\'s own; Slack, Notion and Teams already read all their token can see. ' +
    'It never takes a token or key: for a source that is not connected, or whose saved token was refused, the reply gives the exact `align connect <source>` command for the user to run themselves. Do not ask the user to paste a token into the chat.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...SCOPE_ACTIONS], description: 'view: show the scopes. set: change one source\'s scope' },
      source: { type: 'string', enum: [...SCOPE_SOURCES], description: 'With "set": which connected source to change' },
      scope: { type: 'string', enum: ['yours', 'team'], description: 'With "set": "yours" goes back to only the user\'s own items. "team" is implied by passing the source\'s value below' },
      repo: { type: 'string', description: 'GitHub: the repo as owner/repo' },
      projects: { type: 'array', items: { type: 'string' }, description: 'Jira: project keys, for example ["ALI","OPS"]' },
      teams: { type: 'array', items: { type: 'string' }, description: 'Linear: team keys, for example ["ENG"]' },
      gitlab_project: { type: 'string', description: 'GitLab: the project id or group/project path' },
      spaces: { type: 'array', items: { type: 'string' }, description: 'Confluence: space keys, for example ["ENG"]' },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

export interface ScopeToolResult { text: string; [k: string]: unknown }

const KNOWN = new Set(Object.keys(SCOPE_TOOL_SCHEMA.inputSchema.properties));

export function defaultScopeToolDeps(env: EnvironmentConfig): ScopeDeps {
  const dbPath = env.localDbPath;
  if (!dbPath) throw new Error(`${SCOPE_TOOL} needs the local graph path, and this server has none configured.`);
  return realScopeDeps(dbPath);
}

export async function runScopeTool(
  args: Record<string, unknown> | undefined,
  env: EnvironmentConfig,
  injected?: ScopeDeps,
  o: { agent?: string } = {},
): Promise<ScopeToolResult> {
  const input = args ?? {};
  const unknownKeys = Object.keys(input).filter((k) => !KNOWN.has(k));
  if (unknownKeys.length) {
    // Names the keys (cut), never their values: a rejected token must not be echoed into the transcript it was typed into.
    const names = unknownKeys.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 16))).join(', ');
    throw new Error(
      `${SCOPE_TOOL} does not accept ${names}. It never accepts a token or key: the person connects a source themselves with \`align connect <source>\`.`,
    );
  }
  const action = input['action'];
  if (action !== 'view' && action !== 'set') throw new Error(`${SCOPE_TOOL} requires "action", one of: ${SCOPE_ACTIONS.join(', ')}. Call it again with one of those.`);
  if (env.mode !== 'local-embedded') {
    throw new Error(
      `${SCOPE_TOOL} edits what the local graph on this machine reads, and this server reads a hosted Align graph. ` +
      'Use the local Align server (align mcp --env local); a hosted graph reads what its connectors are set up to read.',
    );
  }
  const deps = injected ?? defaultScopeToolDeps(env);
  if (action === 'view') return view(deps);
  return set(input, deps, o.agent ?? UNKNOWN_AGENT);
}

async function view(deps: ScopeDeps): Promise<ScopeToolResult> {
  const sources = await viewScopes(deps);
  if (sources.length === 0) {
    return { text: 'No source is connected, so there is no scope to show. Connecting needs a token only the person can supply. Ask them to run: align connect <source>', sources: [] };
  }
  const name = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const lines = sources.map((s) => `${name(s.source)}: ${s.label}${s.origin === 'detected' ? " (from this folder's git remote)" : ''}.`);
  return { text: lines.join('\n'), sources };
}

/** The schema says which are lists (projects, teams, spaces) and which are one text value (repo, gitlab_project): hold the input to it. */
function valueOf(property: string, v: unknown): string | string[] {
  const one = property === 'repo' || property === 'gitlab_project';
  if (one && typeof v === 'string') return v;
  if (!one && Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  throw new Error(`${SCOPE_TOOL} "${property}" must be ${one ? 'one text value' : 'a list of text values'}.`);
}

async function set(input: Record<string, unknown>, deps: ScopeDeps, agent: string): Promise<ScopeToolResult> {
  const source = input['source'];
  if (source === undefined) throw new Error(`${SCOPE_TOOL} requires "source" with action "set", one of: ${SCOPE_SOURCES.join(', ')}.`);
  if (typeof source !== 'string' || !(SCOPE_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`${SCOPE_TOOL} "source" must be one of: ${SCOPE_SOURCES.join(', ')}.`);
  }
  const scope = input['scope'];
  if (scope !== undefined && scope !== 'yours' && scope !== 'team') throw new Error(`${SCOPE_TOOL} "scope" must be "yours" or "team".`);

  const wanted = (SCOPED_SOURCES as readonly string[]).includes(source) ? VALUE_PROPERTY[source as keyof typeof VALUE_PROPERTY] : undefined;
  const given = VALUE_PROPERTIES.filter((p) => input[p] !== undefined);
  const wrong = given.filter((p) => p !== wanted);
  if (wanted !== undefined && wrong.length > 0) throw new Error(`${SCOPE_TOOL} for ${source} takes "${wanted}", not "${wrong[0]}".`);

  let change: SetInput;
  if (scope === 'yours') {
    if (given.length > 0) throw new Error(`${SCOPE_TOOL} takes either scope "yours" or a value to read, not both.`);
    change = { scope: 'yours' };
  } else if (wanted === undefined) {
    // Zoom, Slack, Notion, Teams: setScope refuses with the honest reason for that source.
    change = { scope: 'team', values: [] };
  } else {
    if (input[wanted] === undefined) throw new Error(`${SCOPE_TOOL} for ${source} needs "${wanted}" to name what to read, or scope "yours" to go back to the user's own items.`);
    change = { scope: 'team', values: valueOf(wanted, input[wanted]) };
  }

  try {
    const r = await setScope(deps, source, change, { via: 'mcp', agent });
    return {
      text: [r.text, r.disclosure].filter((x) => x !== undefined && x !== '').join(' '),
      source: r.source, scope: r.scope, scope_key: r.scopeKey, new_scope: r.newRow, pending: r.pending === true,
    };
  } catch (e) {
    if (e instanceof ScopeRefusal) throw new Error(e.message);
    throw e;
  }
}
