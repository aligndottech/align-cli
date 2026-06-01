import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ALI-121: the deterministic auto-alignment layer. ALI-120 gave the MCP server
// instructions (model discretion); these project-local, committed files make the
// alignment context fire regardless of which agent/model the user runs:
//  - .claude/settings.json  PostToolUse hook -> `align check --advisory` (Claude Code)
//  - CLAUDE.md               managed nudge block (Claude Code / generic agents)
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
  // Strip any prior align-managed group so re-runs stay idempotent and pick up env changes.
  const existing = (Array.isArray(hooks['PostToolUse']) ? hooks['PostToolUse'] : []) as unknown[];
  const preserved = existing.filter((g) => !isAlignHookGroup(g));

  preserved.push({
    matcher: 'Write|Edit',
    hooks: [{ type: 'command', command: advisoryCommand(env), timeout: HOOK_TIMEOUT_SECONDS }],
  });

  hooks['PostToolUse'] = preserved;
  settings['hooks'] = hooks;

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function managedNudgeBlock(): string {
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
    '- A PostToolUse hook also surfaces conflicting decisions automatically after edits.',
    ALIGN_NUDGE_END,
  ].join('\n');
}

// Append (or replace) a marker-delimited Align block in the project CLAUDE.md. Only the
// content between the markers is managed; everything else the user wrote is preserved.
export function writeManagedNudge(cwd: string): void {
  const file = path.join(cwd, 'CLAUDE.md');
  const block = managedNudgeBlock();

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

// Write all three deterministic-alignment artifacts into the project. Returns the
// repo-relative paths written, for the caller to report.
export function setupAgentAlignment(opts: { cwd: string; env?: string }): string[] {
  writeClaudeCodeHook(opts.cwd, opts.env);
  writeManagedNudge(opts.cwd);
  writeCursorRule(opts.cwd);
  return ['.claude/settings.json', 'CLAUDE.md', '.cursor/rules/align.md'];
}
