import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { alignServerEntry } from './mcp-setup.js';

// ALI-121: the deterministic auto-alignment layer. ALI-120 gave the MCP server
// instructions (model discretion); these project-local, committed files make the
// alignment context fire regardless of which agent/model the user runs:
//  - .claude/settings.json  Pre/PostToolUse hook -> `align check --advisory` (Claude Code)
//  - CLAUDE.md               managed nudge block (Claude Code)
//  - AGENTS.md               managed nudge block (the cross-agent standard read by
//                            Cursor, Windsurf, Codex, Gemini, Zed, and others)
//  - .cursor/rules/align.md  project rule (Cursor ignores Claude Code hooks)

// Claude Code hook command timeout, in SECONDS (Claude Code's unit). The advisory
// check also self-bounds (see ADVISORY_TIMEOUT_MS in check.ts); this is the backstop.
const HOOK_TIMEOUT_SECONDS = 10;

export const ALIGN_NUDGE_START = '<!-- align:start (managed by `align setup` - do not edit) -->';
export const ALIGN_NUDGE_END = '<!-- align:end -->';

function advisoryCommand(env?: string): string {
  // prod is the default env, so leave it off to keep the committed command portable.
  return env && env !== 'prod' ? `align check --advisory --env ${env}` : 'align check --advisory';
}

function isAlignHookGroup(group: unknown): boolean {
  const hooks = (group as { hooks?: Array<{ command?: unknown }> })?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => String(h?.command ?? '').includes('align check --advisory'));
}

// Merge a PostToolUse (Write|Edit) hook into the project .claude/settings.json. The
// file is committed so the whole team gets it; Claude Code shows a one-time "approve
// hooks" prompt the first time it loads a committed hook (documented in setup output).
export function writeClaudeCodeHook(cwd: string, env?: string): void {
  const dir = path.join(cwd, '.claude');
  const file = path.join(dir, 'settings.json');

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      throw new Error(`${file} contains invalid JSON - fix it manually before running align setup`);
    }
  }

  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  // The same advisory command goes in both events; it self-detects Pre vs Post from the
  // hook payload on stdin. PreToolUse catches a conflict before the edit is written
  // (ALI-122); PostToolUse is the backstop on the landed change (ALI-121). Strip any
  // prior align-managed group from each so re-runs stay idempotent and pick up env changes.
  for (const event of ['PreToolUse', 'PostToolUse'] as const) {
    const existing = (Array.isArray(hooks[event]) ? hooks[event] : []) as unknown[];
    const preserved = existing.filter((g) => !isAlignHookGroup(g));
    preserved.push({
      matcher: 'Write|Edit',
      hooks: [{ type: 'command', command: advisoryCommand(env), timeout: HOOK_TIMEOUT_SECONDS }],
    });
    hooks[event] = preserved;
  }
  settings['hooks'] = hooks;

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

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
          '- Claude Code hooks also surface conflicting decisions automatically: before an edit is',
          '  written, and again after it lands.',
        ]
      : []),
    ALIGN_NUDGE_END,
  ].join('\n');
}

// Append (or replace) a marker-delimited Align block in a project markdown file. Only the
// content between the markers is managed; everything else the user wrote is preserved.
function writeMarkerNudge(file: string, block: string): void {
  let content = '';
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }

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

  writeFileSync(file, content, 'utf8');
}

// CLAUDE.md nudge (Claude Code reads this file).
export function writeManagedNudge(cwd: string): void {
  writeMarkerNudge(path.join(cwd, 'CLAUDE.md'), managedNudgeBlock({ claudeHooks: true }));
}

// AGENTS.md nudge - the cross-agent standard read by Cursor, Windsurf, Codex,
// Gemini, Zed and others. Agent-neutral (no Claude-hook line).
export function writeAgentsNudge(cwd: string): void {
  writeMarkerNudge(path.join(cwd, 'AGENTS.md'), managedNudgeBlock({ claudeHooks: false }));
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
    '',
    '(Cursor does not honor Claude Code hooks, so this rule is the Cursor-side nudge.)',
    '',
  ].join('\n');
}

// Cursor project rule. Fully managed - overwritten each run.
export function writeCursorRule(cwd: string): void {
  const dir = path.join(cwd, '.cursor', 'rules');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'align.md'), cursorRuleBody(), 'utf8');
}

// .mcp.json - the tool-agnostic, project-local MCP config. pi reads it (via
// pi-mcp-adapter), so does Claude Code, and it is committed, so one write covers the
// whole team rather than each person's per-host config. Deliberately host-NEUTRAL: pi's
// `directTools` goes in the Pi-owned override that mcp-setup.ts writes, never here.
export function writeProjectMcpConfig(cwd: string, env?: string): void {
  const file = path.join(cwd, '.mcp.json');

  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }

  let config: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} contains invalid JSON - fix it manually before running align setup`);
    }
  }

  const servers = (config['mcpServers'] ?? {}) as Record<string, unknown>;
  servers['align'] = alignServerEntry('mcpServers', env);
  config['mcpServers'] = servers;

  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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
// So the check runs pre-edit (the point of ALI-122) and its finding is replayed into
// that same call's result - non-blocking by default, exactly like the Claude hook.
//
// The extension deliberately declares its own structural types instead of importing
// them from pi: an unresolved import would throw at load and take the session with it,
// and pi's package scope has already moved once (@mariozechner -> @earendil-works).
function piExtensionBody(env?: string): string {
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

// Findings from the pre-edit check, held until that call's result comes back.
const pending = new Map<string, string>();

function askAlign(payload: unknown): Promise<Verdict | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        "align",
        ["check", "--advisory", "--format", "pi"${envArgs}],
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
export function writePiExtension(cwd: string, env?: string): void {
  const dir = path.join(cwd, '.pi', 'extensions');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'align.ts'), piExtensionBody(env), 'utf8');
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

export function writeGeminiHooks(cwd: string, env?: string): void {
  const dir = path.join(cwd, '.gemini');
  const file = path.join(dir, 'settings.json');

  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }

  let settings: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} contains invalid JSON - fix it manually before running align setup`);
    }
  }

  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  // Strip any prior align-managed group from each event first, so a re-run replaces
  // it (and picks up an env change) instead of stacking a second one.
  for (const event of ['BeforeTool', 'AfterTool'] as const) {
    const existing = (Array.isArray(hooks[event]) ? hooks[event] : []) as unknown[];
    const preserved = existing.filter((g) => !isAlignGeminiHook(g));
    preserved.push(geminiHookGroup(event, env));
    hooks[event] = preserved;
  }
  settings['hooks'] = hooks;

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
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
function openCodePluginBody(env?: string): string {
  const envArgs = env && env !== 'prod' ? `, "--env", "${env}"` : '';
  return `// Align decision graph - managed by \`align setup\`, do not edit.
// Checks each proposed edit against your team's prior decisions and feeds any conflict
// back to the model. Non-blocking and fail-open by design: if align is missing, slow or
// unhappy, the edit proceeds untouched.
import { execFile } from "node:child_process";

const MUTATING_TOOLS = new Set(["edit", "write", "apply_patch"]);
const TIMEOUT_MS = 10000;

// Findings from the pre-edit check, held until that call's result comes back.
const pending = new Map();

function askAlign(payload) {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        "align",
        ["check", "--advisory", "--format", "opencode"${envArgs}],
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
export function writeOpenCodePlugin(cwd: string, env?: string): void {
  const dir = path.join(cwd, '.opencode', 'plugins');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'align.js'), openCodePluginBody(env), 'utf8');
}

// Write every deterministic-alignment artifact into the project. Returns the
// repo-relative paths written, for the caller to report.
export function setupAgentAlignment(opts: { cwd: string; env?: string }): string[] {
  writeClaudeCodeHook(opts.cwd, opts.env);
  writeManagedNudge(opts.cwd);
  writeAgentsNudge(opts.cwd);
  writeCursorRule(opts.cwd);
  // prod is the default env, so leave it off to keep the committed file portable -
  // the same rule advisoryCommand() applies to the hook.
  const env = opts.env === 'prod' ? undefined : opts.env;
  writeProjectMcpConfig(opts.cwd, env);
  writePiExtension(opts.cwd, env);
  writeGeminiHooks(opts.cwd, env);
  writeOpenCodePlugin(opts.cwd, env);
  return [
    '.claude/settings.json',
    'CLAUDE.md',
    'AGENTS.md',
    '.cursor/rules/align.md',
    '.mcp.json',
    '.pi/extensions/align.ts',
    '.gemini/settings.json',
    '.opencode/plugins/align.js',
  ];
}
