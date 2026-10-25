import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { carriesLocalEnv, type OnForeign } from './foreign-env.js';
import { alignServerEntry } from './mcp-setup.js';
import { safeWriteJson, type SafeWriteOptions, safeWriteText } from './safe-config-write.js';

// The deterministic auto-alignment layer. The MCP server already had
// instructions (model discretion); these project-local, committed files make the
// alignment context fire regardless of which agent/model the user runs:
//  - .claude/settings.json  Pre/PostToolUse hook -> `align check --advisory` (Claude Code)
//  - .claude/settings.json  SessionStart hook -> `align context inject` (Claude Code)
//  - CLAUDE.md               managed nudge block (Claude Code)
//  - AGENTS.md               managed nudge block (the cross-agent standard read by
//                            Cursor, Windsurf, Codex, Gemini, Zed, and others)
//  - .cursor/rules/align.md  project rule (Cursor ignores Claude Code hooks)
//
// The write-path hooks above only ever reach the model if the AGENT edits a
// file. Nothing delivered the graph's content unprompted - a claim like "the agent
// already has the answer" was only true of the ask-based MCP path, never of a fresh
// session. writeClaudeCodeSessionHook is the read-path counterpart: it fires at
// SessionStart, before the model has done anything, and injects whatever `align context
// sync` last wrote. See docs/agent-hooks.md for which other hosts do (and, mostly,
// don't) expose an equivalent mechanism, and why.

// Claude Code hook command timeout, in SECONDS (Claude Code's unit). The advisory
// check also self-bounds (see ADVISORY_TIMEOUT_MS in check.ts); this is the backstop.
const HOOK_TIMEOUT_SECONDS = 10;

// The command a SessionStart hook shells out to. No --env flag: unlike the
// advisory check, this reads a local file (.align/decisions.md) and never touches the
// gateway, so there is no environment to encode.
const SESSION_INJECT_COMMAND = 'align context inject';

// Every `source` value Claude Code's SessionStart hook documents (startup, resume,
// clear, compact, fork - code.claude.com/docs/en/hooks, verified 2026-09-09). Listed
// explicitly, alternation-matched, rather than omitting `matcher` to mean "all": that
// omission is unverified for this event, where the existing Write|Edit matcher on
// PreToolUse/PostToolUse IS the documented idiom for "more than one value". A compacted
// or resumed session may have dropped the graph content from its summary, so there is
// no source worth excluding by default.
const SESSION_START_MATCHER = 'startup|resume|clear|compact|fork';

export const ALIGN_NUDGE_START = '<!-- align:start (managed by `align setup` - do not edit) -->';
export const ALIGN_NUDGE_END = '<!-- align:end -->';

// Every project file goes through the safe writer (safe-config-write.ts), the same one
// the user-level configs use. That is what records each write in the ledger `align use --undo`
// reads, keeps the first copy of a file that already existed, and refuses to write through a
// symlink. `root: cwd` limits the link check to inside the repo.
function projectWrite(cwd: string, markers?: { start: string; end: string }): SafeWriteOptions {
  return { root: cwd, projectFile: true, trailingNewline: true, ...(markers ? { markers } : {}), invalidJsonAdvice: ' before running align' };
}
const NUDGE_MARKERS = { start: ALIGN_NUDGE_START, end: ALIGN_NUDGE_END };

function advisoryCommand(env?: string): string {
  // prod is the default env, so leave it off to keep the committed command portable.
  return env && env !== 'prod' ? `align check --advisory --env ${env}` : 'align check --advisory';
}

export function isAlignHookGroup(group: unknown): boolean {
  const hooks = (group as { hooks?: Array<{ command?: unknown }> })?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => String(h?.command ?? '').includes('align check --advisory'));
}

export function isAlignSessionHookGroup(group: unknown): boolean {
  const hooks = (group as { hooks?: Array<{ command?: unknown }> })?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => String(h?.command ?? '').includes(SESSION_INJECT_COMMAND));
}

/**
 * The Pre/PostToolUse hook groups Claude Code gets, as one shape for both writers: the
 * committed project file (writeClaudeCodeHook) and the per-session launch file (C1).
 */
export function alignClaudeHooks(env?: string): Record<'PreToolUse' | 'PostToolUse', unknown[]> {
  const group = () => ({
    matcher: 'Write|Edit',
    hooks: [{ type: 'command', command: advisoryCommand(env), timeout: HOOK_TIMEOUT_SECONDS }],
  });
  return { PreToolUse: [group()], PostToolUse: [group()] };
}

// Merge a PostToolUse (Write|Edit) hook into the project .claude/settings.json. The
// file is committed so the whole team gets it; Claude Code shows a one-time "approve
// hooks" prompt the first time it loads a committed hook (documented in setup output).
export function writeClaudeCodeHook(cwd: string, env?: string, onForeign?: OnForeign): boolean {
  const file = path.join(cwd, '.claude', 'settings.json');
  const status = safeWriteJson(file, (settings) => {
    const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
    // The local wizard never replaces a hook that checks against a team env.
    if (onForeign && env === 'local' && (['PreToolUse', 'PostToolUse'] as const).some((event) =>
      (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).some((g) => isAlignHookGroup(g) && !carriesLocalEnv(JSON.stringify(g))))) {
      return undefined;
    }
    // The same advisory command goes in both events; it self-detects Pre vs Post from the
    // hook payload on stdin. PreToolUse catches a conflict before the edit is written;
    // PostToolUse is the backstop on the landed change. Strip any
    // prior align-managed group from each so re-runs stay idempotent and pick up env changes.
    const alignGroups = alignClaudeHooks(env);
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      const existing = (Array.isArray(hooks[event]) ? hooks[event] : []) as unknown[];
      const preserved = existing.filter((g) => !isAlignHookGroup(g));
      preserved.push(...alignGroups[event]);
      hooks[event] = preserved;
    }
    settings['hooks'] = hooks;
    return settings;
  }, projectWrite(cwd));
  if (status === 'declined') onForeign?.('.claude/settings.json');
  return status === 'written' || status === 'unchanged';
}

// Merge a SessionStart hook into the project .claude/settings.json - the
// read-path counterpart to writeClaudeCodeHook above. Separate function, separate merge:
// it touches a different top-level hook key (SessionStart, not Pre/PostToolUse) for a
// different purpose (inject the graph unprompted, not check a proposed edit), and
// conflating the two would make either one harder to read without saving a real merge.
//
// Fires on every documented source (SESSION_START_MATCHER) and always non-blocking:
// `align context inject` only ever prints an additionalContext line or nothing, never a
// deny - there is nothing here to approve or reject, only content to offer or withhold.
export function writeClaudeCodeSessionHook(cwd: string): boolean {
  const file = path.join(cwd, '.claude', 'settings.json');
  const status = safeWriteJson(file, (settings) => {
    const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
    const existing = (Array.isArray(hooks['SessionStart']) ? hooks['SessionStart'] : []) as unknown[];
    const preserved = existing.filter((g) => !isAlignSessionHookGroup(g));
    preserved.push({
      matcher: SESSION_START_MATCHER,
      hooks: [{ type: 'command', command: SESSION_INJECT_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
    });
    hooks['SessionStart'] = preserved;
    settings['hooks'] = hooks;
    return settings;
  }, projectWrite(cwd));
  return status === 'written' || status === 'unchanged';
}

/** The managed CLAUDE.md block as text, for per-session injection (C1). */
export function alignNudgeBody(): string {
  return managedNudgeBlock({ claudeHooks: true });
}

// A hook's finding reaches the model only, so a check that ran and one that never fired look
// the same to the user. One line from the agent makes the check visible. Shared by every
// instruction surface so the wording cannot drift.
const SAY_WHAT_ALIGN_SURFACED = [
  '- When Align surfaces a decision (a tool result or a hook), tell the user in one line which decision',
  '  it was and whether your change agrees with it.',
] as const;

// The nudge body. `claudeHooks` adds the Claude-Code-specific line about the
// Pre/PostToolUse hook - true for CLAUDE.md, false for the agent-neutral AGENTS.md.
function managedNudgeBlock(opts: { claudeHooks: boolean }): string {
  return [
    ALIGN_NUDGE_START,
    '## Align decision graph',
    '',
    'This project is connected to Align - the decision graph of what was decided, why, and by whom,',
    'across Slack, Jira, GitHub, Linear and more (via the `align` MCP server).',
    '',
    '- BEFORE writing or changing non-trivial code, check it against prior decisions',
    '  (`align_check_alignment`, or run `align check`). A conflict means a past decision opposes',
    '  the change - reconcile it or confirm with the user before proceeding.',
    '- When unsure why something is the way it is, ask the graph first (`align_ask`).',
    ...(opts.claudeHooks
      ? [
          '- Claude Code hooks also surface related decisions automatically: before an edit is',
          '  written, and again after it lands.',
        ]
      : []),
    ...SAY_WHAT_ALIGN_SURFACED,
    ALIGN_NUDGE_END,
  ].join('\n');
}

// Append (or replace) a marker-delimited Align block in a project markdown file. Only the
// content between the markers is managed; everything else the user wrote is preserved.
function writeMarkerNudge(file: string, block: string, cwd: string): boolean {
  const status = safeWriteText(file, (current) => {
    let content = current ?? '';
    const start = content.indexOf(ALIGN_NUDGE_START);
    const end = content.indexOf(ALIGN_NUDGE_END);
    if (start !== -1 && end !== -1 && end > start) {
      const before = content.slice(0, start);
      const after = content.slice(end + ALIGN_NUDGE_END.length);
      content = `${before}${block}${after}`;
    } else if (content.trim()) {
      content = `${content.replace(/\s*$/, '')}\n\n${block}\n`;
    } else {
      content = `${block}\n`;
    }
    return content;
  }, projectWrite(cwd, NUDGE_MARKERS));
  return status === 'written' || status === 'unchanged';
}

// CLAUDE.md nudge (Claude Code reads this file).
export function writeManagedNudge(cwd: string): boolean {
  return writeMarkerNudge(path.join(cwd, 'CLAUDE.md'), managedNudgeBlock({ claudeHooks: true }), cwd);
}

// AGENTS.md nudge - the cross-agent standard read by Cursor, Windsurf, Codex,
// Gemini, Zed and others. Agent-neutral (no Claude-hook line).
export function writeAgentsNudge(cwd: string): boolean {
  return writeMarkerNudge(path.join(cwd, 'AGENTS.md'), managedNudgeBlock({ claudeHooks: false }), cwd);
}

function cursorRuleBody(): string {
  return [
    '---',
    'description: Check changes against the Align decision graph',
    'alwaysApply: true',
    '---',
    '',
    '# Align decision graph',
    '',
    'This project is connected to Align via the `align` MCP server - the source of truth for',
    'what was decided, why, and by whom across Slack, Jira, GitHub, Linear and more.',
    '',
    '- BEFORE writing or changing non-trivial code, call `align_check_alignment` with the',
    '  proposed change. A "conflict" means a past decision opposes it - reconcile or confirm',
    '  with the user before proceeding.',
    '- When unsure about a convention or "why" something is the way it is, call `align_ask` first.',
    ...SAY_WHAT_ALIGN_SURFACED,
    '',
    '(Cursor does not honor Claude Code hooks, so this rule is the Cursor-side nudge.)',
    '',
  ].join('\n');
}

// Cursor project rule. Fully managed - overwritten each run.
export function writeCursorRule(cwd: string): boolean {
  const status = safeWriteText(path.join(cwd, '.cursor', 'rules', 'align.md'), () => cursorRuleBody(), projectWrite(cwd));
  return status === 'written' || status === 'unchanged';
}

// .mcp.json - the tool-agnostic, project-local MCP config. pi reads it (via
// pi-mcp-adapter), so does Claude Code, and it is committed, so one write covers the
// whole team rather than each person's per-host config. Deliberately host-NEUTRAL: pi's
// `directTools` goes in the Pi-owned override that mcp-setup.ts writes, never here.
export function writeProjectMcpConfig(cwd: string, env?: string, onForeign?: OnForeign): boolean {
  const status = safeWriteJson(path.join(cwd, '.mcp.json'), (config) => {
    const servers = (config['mcpServers'] ?? {}) as Record<string, unknown>;
    // A committed entry that targets a team env is the team's, not ours to replace.
    if (onForeign && env === 'local' && servers['align'] !== undefined && !carriesLocalEnv(JSON.stringify(servers['align']))) {
      return undefined;
    }
    // `committed: true` keeps the Windows `cmd /c` wrapper OUT of this file. It is
    // the one MCP config that travels: a wrapper written here by a Windows machine would be
    // committed and then fail to spawn for every teammate on macOS or Linux. Windows readers
    // get the wrapper from their own user-level entry instead.
    servers['align'] = alignServerEntry('mcpServers', env, { committed: true });
    config['mcpServers'] = servers;
    return config;
  }, projectWrite(cwd));
  if (status === 'declined') onForeign?.('.mcp.json');
  return status === 'written' || status === 'unchanged';
}

// ---------------------------------------------------------------------------
// Per-host hook shims (the agent-agnostic guardrail)
// ---------------------------------------------------------------------------
// One advisory engine, N hosts. `align check --advisory --format <host>` reads the
// host's payload on stdin and prints the shape that host reads back. All a shim does
// is register that command and move the bytes. Which hosts can do what, and why, is
// the table in docs/agent-hooks.md - the differences are the hosts', not ours.

// pi discovers project extensions at .pi/extensions/*.ts and loads them with jiti, so
// this ships as TypeScript and is never compiled by us.
//
// Two events, because pi splits the two halves of what Claude Code does in one:
//   tool_call   fires BEFORE the edit, but its only return channel is {block, reason}
//   tool_result fires after, and CAN patch the content the model reads
// So the check runs pre-edit (the whole point) and its finding is replayed into
// that same call's result - non-blocking by default, exactly like the Claude hook.
//
// The extension deliberately declares its own structural types instead of importing
// them from pi: an unresolved import would throw at load and take the session with it,
// and pi's package scope has already moved once (@mariozechner -> @earendil-works).
/**
 * The spawn preamble both generated plugins embed.
 *
 * An npm global install on Windows exposes `align.cmd`, and a process spawn
 * resolves a `.cmd` only through a shell - Node's child_process refuses one outright. `cmd`
 * is a real executable, so `cmd /c align` launches and cmd resolves `align` -> `align.cmd`
 * through PATH + PATHEXT. Same form the MCP configs settled on.
 *
 * IT BRANCHES AT RUNTIME, NOT HERE. A generated plugin is a file that can be committed,
 * shared, or synced to a machine with a different OS than the one that generated it. Baking
 * the GENERATING platform in would work for whoever ran `align setup` and fail for everyone
 * who received the file, which is the same defect one layer along. So the output of these
 * writers is identical on every platform and the decision happens where the code runs.
 *
 * One copy, used by both bodies: the pi extension and the opencode plugin made the identical
 * mistake independently, which is what two writers of one fact produces.
 */
const PLUGIN_SPAWN_PREAMBLE = `// npm installs align.cmd on Windows, which a process spawn cannot resolve without a
// shell. cmd is a real executable and resolves align.cmd through PATHEXT.
const ALIGN_IS_WIN = process.platform === "win32";
const ALIGN_BIN = ALIGN_IS_WIN ? "cmd" : "align";
const ALIGN_PRE = ALIGN_IS_WIN ? ["/c", "align"] : [];`;

export function piExtensionBody(env?: string): string {
  const envArgs = env && env !== 'prod' ? `, "--env", "${env}"` : '';
  return `// Align decision graph - managed by \`align setup\`, do not edit.
// Checks each proposed edit against your team's prior decisions and feeds any
// conflict back to the model. Non-blocking and fail-open by design: if align is
// missing, slow or unhappy, the edit proceeds untouched.
import { execFile } from "node:child_process";

type PiEvent = { toolName?: string; toolCallId?: string; input?: unknown; content?: unknown[] };
type Verdict = { block?: boolean; reason?: string; context?: string };

const MUTATING_TOOLS = new Set(["edit", "write"]);
const TIMEOUT_MS = 10000;
${PLUGIN_SPAWN_PREAMBLE}

// Findings from the pre-edit check, held until that call's result comes back.
const pending = new Map<string, string>();

function askAlign(payload: unknown): Promise<Verdict | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        ALIGN_BIN,
        [...ALIGN_PRE, "check", "--advisory", "--format", "pi"${envArgs}],
        { timeout: TIMEOUT_MS },
        (err, stdout) => {
          if (err || !stdout || !stdout.trim()) return resolve(null);
          try {
            const last = stdout.trim().split("\\n").pop() as string;
            resolve(JSON.parse(last) as Verdict);
          } catch {
            resolve(null);
          }
        },
      );
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      resolve(null);
    }
  });
}

export default function (pi: { on: (e: string, h: (ev: PiEvent) => unknown) => void }) {
  pi.on("tool_call", async (event: PiEvent) => {
    if (!event.toolName || !MUTATING_TOOLS.has(event.toolName)) return;
    const verdict = await askAlign({ type: "tool_call", toolName: event.toolName, input: event.input });
    if (!verdict) return;
    if (verdict.block) return { block: true, reason: String(verdict.reason ?? "Conflicts with a prior decision") };
    if (verdict.context && event.toolCallId) pending.set(event.toolCallId, String(verdict.context));
  });

  pi.on("tool_result", async (event: PiEvent) => {
    const found = event.toolCallId ? pending.get(event.toolCallId) : undefined;
    if (!found) return;
    pending.delete(event.toolCallId as string);
    return { content: [...(event.content ?? []), { type: "text", text: found }] };
  });
}
`;
}

// pi extension. Fully managed - overwritten each run.
export function writePiExtension(cwd: string, env?: string, onForeign?: OnForeign): boolean {
  const status = safeWriteText(path.join(cwd, '.pi', 'extensions', 'align.ts'), (current) => {
    if (onForeign && env === 'local' && current !== null && !carriesLocalEnv(current)) return undefined;
    return piExtensionBody(env);
  }, projectWrite(cwd));
  if (status === 'declined') onForeign?.('.pi/extensions/align.ts');
  return status === 'written' || status === 'unchanged';
}

// Gemini CLI hooks. BeforeTool can only deny (no additionalContext channel), so the
// non-blocking finding is carried by AfterTool - the same split as pi, for the same
// reason. `replace` and `write_file` are Gemini's built-in file-mutating tools; the
// matcher is a regex.
const GEMINI_MATCHER = 'write_file|replace';

function geminiHookGroup(event: 'BeforeTool' | 'AfterTool', env?: string): Record<string, unknown> {
  const envArg = env && env !== 'prod' ? ` --env ${env}` : '';
  return {
    matcher: GEMINI_MATCHER,
    hooks: [{
      type: 'command',
      name: 'align-decision-graph',
      description: `Align: check the ${event === 'BeforeTool' ? 'proposed' : 'applied'} change against prior decisions`,
      command: `align check --advisory --format gemini${envArg}`,
    }],
  };
}

function isAlignGeminiHook(group: unknown): boolean {
  const hooks = (group as { hooks?: Array<{ command?: unknown }> })?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => String(h?.command ?? '').includes('align check --advisory'));
}

export function writeGeminiHooks(cwd: string, env?: string, onForeign?: OnForeign): boolean {
  const status = safeWriteJson(path.join(cwd, '.gemini', 'settings.json'), (settings) => {
    const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
    if (onForeign && env === 'local' && (['BeforeTool', 'AfterTool'] as const).some((event) =>
      (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).some((g) => isAlignGeminiHook(g) && !carriesLocalEnv(JSON.stringify(g))))) {
      return undefined;
    }
    // Strip any prior align-managed group from each event first, so a re-run replaces
    // it (and picks up an env change) instead of stacking a second one.
    for (const event of ['BeforeTool', 'AfterTool'] as const) {
      const existing = (Array.isArray(hooks[event]) ? hooks[event] : []) as unknown[];
      const preserved = existing.filter((g) => !isAlignGeminiHook(g));
      preserved.push(geminiHookGroup(event, env));
      hooks[event] = preserved;
    }
    settings['hooks'] = hooks;
    return settings;
  }, projectWrite(cwd));
  if (status === 'declined') onForeign?.('.gemini/settings.json');
  return status === 'written' || status === 'unchanged';
}

// OpenCode discovers project plugins at .opencode/plugins/*.{js,ts} and loads them at
// startup. Ships as plain JS so nothing depends on a type package resolving.
//
// The two halves work differently from pi's, verified against OpenCode's own caller in
// packages/opencode/src/session/tools.ts rather than from the type signatures:
//   tool.execute.before  runs BEFORE `item.execute(...)`, so throwing prevents the call.
//                        That is the only way to stop an edit - there is no {block} return.
//   tool.execute.after   is handed the result object and the caller does `return output`
//                        on the next line, so mutating output.output reaches the model.
// Both hooks are declared `=> Promise<void>`; mutation is in place, not by return value.
export function openCodePluginBody(env?: string): string {
  const envArgs = env && env !== 'prod' ? `, "--env", "${env}"` : '';
  return `// Align decision graph - managed by \`align setup\`, do not edit.
// Checks each proposed edit against your team's prior decisions and feeds any conflict
// back to the model. Non-blocking and fail-open by design: if align is missing, slow or
// unhappy, the edit proceeds untouched.
import { execFile } from "node:child_process";

const MUTATING_TOOLS = new Set(["edit", "write", "apply_patch"]);
const TIMEOUT_MS = 10000;
${PLUGIN_SPAWN_PREAMBLE}

// Findings from the pre-edit check, held until that call's result comes back.
const pending = new Map();

function askAlign(payload) {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        ALIGN_BIN,
        [...ALIGN_PRE, "check", "--advisory", "--format", "opencode"${envArgs}],
        { timeout: TIMEOUT_MS },
        (err, stdout) => {
          if (err || !stdout || !stdout.trim()) return resolve(null);
          try {
            resolve(JSON.parse(stdout.trim().split("\\n").pop()));
          } catch {
            resolve(null);
          }
        },
      );
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      resolve(null);
    }
  });
}

export const AlignPlugin = async () => ({
  "tool.execute.before": async (input, output) => {
    if (!MUTATING_TOOLS.has(input.tool)) return;
    const verdict = await askAlign({
      type: "tool.execute.before",
      tool: input.tool,
      args: output.args,
    });
    if (!verdict) return;
    // Throwing is the only way to stop the call - the hook runs before item.execute.
    if (verdict.block) throw new Error(String(verdict.reason ?? "Conflicts with a prior decision"));
    if (verdict.context) pending.set(input.callID, String(verdict.context));
  },

  "tool.execute.after": async (input, output) => {
    const found = pending.get(input.callID);
    if (!found) return;
    pending.delete(input.callID);
    // The caller returns this same object, so appending here reaches the model.
    output.output = \`\${output.output}\\n\\n\${found}\`;
  },
});
`;
}

// OpenCode plugin. Fully managed - overwritten each run.
export function writeOpenCodePlugin(cwd: string, env?: string, onForeign?: OnForeign): boolean {
  const status = safeWriteText(path.join(cwd, '.opencode', 'plugins', 'align.js'), (current) => {
    if (onForeign && env === 'local' && current !== null && !carriesLocalEnv(current)) return undefined;
    return openCodePluginBody(env);
  }, projectWrite(cwd));
  if (status === 'declined') onForeign?.('.opencode/plugins/align.js');
  return status === 'written' || status === 'unchanged';
}

interface AlignmentWriteCtx {
  cwd: string;
  /** The env as given. */
  env?: string;
  /** The env for committed files: prod is the default, so it is left off to keep them portable. */
  projectEnv?: string;
  onForeign?: OnForeign;
}

/**
 * THE plan: every project file setup writes, in write order, with the writer that writes it.
 * setupAgentAlignment runs exactly this table and planAgentAlignment lists exactly this table,
 * so the list shown before the write cannot drift from what the write touches.
 * A writer returns false when it left its file as found (a team entry, or a symlink).
 */
const ALIGNMENT_WRITES: Array<{ file: string; write: (c: AlignmentWriteCtx) => boolean }> = [
  {
    file: '.claude/settings.json',
    // The session hook lives in the same file, so it is skipped too when the hooks are left as found.
    write: (c) => writeClaudeCodeHook(c.cwd, c.env, c.onForeign) && writeClaudeCodeSessionHook(c.cwd),
  },
  { file: 'CLAUDE.md', write: (c) => writeManagedNudge(c.cwd) },
  { file: 'AGENTS.md', write: (c) => writeAgentsNudge(c.cwd) },
  { file: '.cursor/rules/align.md', write: (c) => writeCursorRule(c.cwd) },
  { file: '.mcp.json', write: (c) => writeProjectMcpConfig(c.cwd, c.projectEnv, c.onForeign) },
  { file: '.pi/extensions/align.ts', write: (c) => writePiExtension(c.cwd, c.projectEnv, c.onForeign) },
  { file: '.gemini/settings.json', write: (c) => writeGeminiHooks(c.cwd, c.projectEnv, c.onForeign) },
  { file: '.opencode/plugins/align.js', write: (c) => writeOpenCodePlugin(c.cwd, c.projectEnv, c.onForeign) },
];

/**
 * The project files setupAgentAlignment will create or modify, before it runs anything.
 * An upper bound: a writer that finds a team-owned entry or a symlink leaves its file as
 * found, and setupAgentAlignment then leaves it out of what it returns.
 */
export function planAgentAlignment(cwd: string): Array<{ file: string; action: 'create' | 'modify' }> {
  return ALIGNMENT_WRITES.map(({ file }) => ({
    file,
    action: existsSync(path.join(cwd, file)) ? 'modify' : 'create',
  }));
}

// Write every deterministic-alignment artifact into the project. Returns the
// repo-relative paths written, for the caller to report.
export function setupAgentAlignment(opts: { cwd: string; env?: string; onForeign?: OnForeign }): string[] {
  const skipped = new Set<string>();
  // Opt-in: with no callback every writer overwrites, exactly as before.
  const onForeign: OnForeign | undefined = opts.onForeign
    ? (f) => { skipped.add(f); opts.onForeign!(f); }
    : undefined;
  // A writer that returns false left its file as found (a team entry, or a symlink): not reported.
  const left = new Set<string>();
  const ctx: AlignmentWriteCtx = {
    cwd: opts.cwd,
    env: opts.env,
    projectEnv: opts.env === 'prod' ? undefined : opts.env,
    onForeign,
  };
  for (const { file, write } of ALIGNMENT_WRITES) {
    if (!write(ctx)) left.add(file);
  }
  return ALIGNMENT_WRITES.map((w) => w.file).filter((f) => !skipped.has(f) && !left.has(f));
}

const PROJECT_FILE_TELLS: Array<[string, string[]]> = [
  ['.claude/settings.json', ['align check --advisory', SESSION_INJECT_COMMAND]],
  ['CLAUDE.md', [ALIGN_NUDGE_START]],
  ['AGENTS.md', [ALIGN_NUDGE_START]],
  ['.cursor/rules/align.md', ['Align decision graph']],
  ['.mcp.json', ['"align"']],
  ['.pi/extensions/align.ts', ['align check --advisory']],
  ['.gemini/settings.json', ['align check --advisory']],
  ['.opencode/plugins/align.js', ['align check --advisory']],
];

/**
 * Files under `cwd` that carry align's own text, for the case where `align use --undo` has no
 * record of writing them (an older build wrote them, or the record was lost). Read only: undo
 * names these and touches none of them, because without a record it cannot tell align's text
 * from the user's.
 */
export function projectFilesWithAlignText(cwd: string): string[] {
  const found: string[] = [];
  for (const [rel, tells] of PROJECT_FILE_TELLS) {
    try {
      const text = readFileSync(path.join(cwd, rel), 'utf8');
      if (tells.some((t) => text.includes(t))) found.push(rel);
    } catch {
      // missing or unreadable: nothing to name
    }
  }
  return found;
}
