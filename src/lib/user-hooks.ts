import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ALI-952: user-level advisory hooks for the hosts whose hook API lives in a file under the
// user's home rather than in the project. Written by mcp-setup.ts next to the MCP entry for
// the same host, so every path that wires an agent (setup, `align local start`,
// `align mcp --setup`) wires the hook too, and `align mcp --remove` takes both out.
//
// One engine, N hosts (docs/agent-hooks.md): each entry runs
// `align check --advisory --format <host>`, which reads the host's payload on stdin and
// prints the shape that host reads back. Fail-open is the whole point - the check always
// exits 0, and a hook that blocks or errors on every edit gets turned off.
//
// The file is the USER'S, shared with everything else they run. So: merge, never overwrite;
// strip exactly our prior entry before adding the new one, so a re-run is idempotent and
// picks up an env change; refuse to touch a file we cannot parse.

export type HookHost = 'codex' | 'cursor' | 'copilot';

export interface UserHookTarget {
  host: HookHost;
  /** The hook file for this host, e.g. ~/.codex/hooks.json. */
  path: string;
}

// The hook budget on every host is <=10s (check.ts); the same number Claude Code's hook uses.
const HOOK_TIMEOUT_SECONDS = 10;
const OURS = 'align check --advisory';

export function advisoryHookCommand(host: HookHost, env?: string): string {
  // prod is the default env, so leave it off - the same rule agent-rules.ts follows.
  const envArg = env && env !== 'prod' ? ` --env ${env}` : '';
  return `${OURS} --format ${host}${envArg}`;
}

interface HostSpec {
  /** Top-level `version` the host requires, if any. */
  version?: number;
  /** The events to register. Both are needed where the pre event has no context channel. */
  events: readonly string[];
  /** Build this host's entry for one event. */
  entry: (command: string) => Record<string, unknown>;
  /** Every command string an entry carries, so ours can be recognised on re-run and remove. */
  commandsOf: (entry: unknown) => string[];
}

// Every field name here comes from the host's published hook schema:
//   Codex    ~/.codex/hooks.json   {hooks:{PreToolUse:[{matcher, hooks:[{type,command,timeout}]}]}}
//            Claude Code's shape. matcher is a regex on tool_name; file edits go through
//            apply_patch, for which Edit|Write are documented aliases. PreToolUse has an
//            additionalContext channel, so one event carries the non-blocking finding.
//   Cursor   ~/.cursor/hooks.json  {version:1, hooks:{preToolUse:[{command,matcher,timeout}]}}
//            matcher is the tool type (Write covers file edits). preToolUse reads only
//            permission/user_message/agent_message, so the finding rides postToolUse's
//            additional_context - the Gemini split.
//   Copilot  ~/.copilot/hooks/*.json {version:1, hooks:{preToolUse:[{type,bash,matcher,timeoutSec}]}}
//            matcher is a regex on toolName; edit/str_replace_editor/apply_patch/create are
//            its file-editing tools. Same pre/post split as Cursor. Note: a non-timeout
//            non-zero exit DENIES the tool call there, which is why the check exits 0 always.
const HOSTS: Record<HookHost, HostSpec> = {
  codex: {
    events: ['PreToolUse'],
    entry: (command) => ({
      matcher: 'apply_patch|Edit|Write',
      hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }],
    }),
    commandsOf: (entry) => {
      const hooks = (entry as { hooks?: Array<{ command?: unknown }> } | null)?.hooks;
      return Array.isArray(hooks) ? hooks.map((h) => String(h?.command ?? '')) : [];
    },
  },
  cursor: {
    version: 1,
    events: ['preToolUse', 'postToolUse'],
    entry: (command) => ({ command, matcher: 'Write', timeout: HOOK_TIMEOUT_SECONDS }),
    commandsOf: (entry) => [String((entry as { command?: unknown } | null)?.command ?? '')],
  },
  copilot: {
    version: 1,
    events: ['preToolUse', 'postToolUse'],
    entry: (command) => ({
      type: 'command',
      matcher: 'edit|str_replace_editor|apply_patch|create',
      bash: command,
      timeoutSec: HOOK_TIMEOUT_SECONDS,
    }),
    commandsOf: (entry) => [String((entry as { bash?: unknown } | null)?.bash ?? '')],
  },
};

function isOurs(spec: HostSpec, entry: unknown): boolean {
  return spec.commandsOf(entry).some((c) => c.includes(OURS));
}

// Throws on a file we cannot parse rather than rewriting it - the same rule every JSON
// writer in mcp-setup.ts follows, for the same reason: a rewrite destroys whatever the user
// was part-way through editing.
function readHooksFile(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${file} contains invalid JSON - fix it manually before running align mcp --setup`);
  }
}

// The `hooks` map, validated (Copilot, #282). `"hooks": []` is valid JSON, and setting an
// event key on an array adds a non-index property that JSON.stringify drops - so the write
// would succeed and produce a file with no hook in it, a no-op that reads as done. Anything
// parseable but not an object is the same rule as invalid JSON: refuse, name the file.
function hooksOf(config: Record<string, unknown>, file: string): Record<string, unknown> {
  const hooks = config['hooks'];
  if (hooks === undefined) return {};
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new Error(`${file}: "hooks" is not an object - fix it manually before running align mcp --setup`);
  }
  return hooks as Record<string, unknown>;
}

export function writeUserHooks(target: UserHookTarget, env?: string): void {
  const spec = HOSTS[target.host];
  const command = advisoryHookCommand(target.host, env);
  const config = readHooksFile(target.path) ?? {};

  const hooks = hooksOf(config, target.path);
  for (const event of spec.events) {
    const existing = (Array.isArray(hooks[event]) ? hooks[event] : []) as unknown[];
    const preserved = existing.filter((e) => !isOurs(spec, e));
    preserved.push(spec.entry(command));
    hooks[event] = preserved;
  }
  config['hooks'] = hooks;
  if (spec.version !== undefined && config['version'] === undefined) config['version'] = spec.version;

  const dir = path.dirname(target.path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(target.path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Take our entries back out. Returns whether there was anything of ours to remove.
 * Deletes the file only when nothing but what we wrote (plus the version we added) is left,
 * so a file the user pre-populated survives with their hooks in it.
 */
export function removeUserHooks(target: UserHookTarget): boolean {
  const spec = HOSTS[target.host];
  const config = readHooksFile(target.path);
  if (!config) return false;

  const hooks = hooksOf(config, target.path);
  let removed = false;
  for (const event of spec.events) {
    const existing = (Array.isArray(hooks[event]) ? hooks[event] : []) as unknown[];
    const preserved = existing.filter((e) => !isOurs(spec, e));
    if (preserved.length !== existing.length) removed = true;
    if (preserved.length) hooks[event] = preserved;
    else delete hooks[event];
  }
  if (!removed) return false;

  const otherKeys = Object.keys(config).filter((k) => k !== 'hooks' && k !== 'version');
  if (Object.keys(hooks).length === 0 && otherKeys.length === 0) {
    unlinkSync(target.path);
    return true;
  }
  config['hooks'] = hooks;
  writeFileSync(target.path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return true;
}
