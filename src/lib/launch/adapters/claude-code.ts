import { alignClaudeHooks, alignNudgeBody } from '../../agent-rules.js';
import { alignServerEntry } from '../../mcp-setup.js';
import type { ConfigWrite } from '../config-writes.js';

export interface LaunchFile {
  name: string;
  content: string;
  /** File mode, for a file that copies something of the user's (Gemini's system settings). */
  mode?: number;
}

/** What to run: pure data, so the builder is testable without spawning anything. */
export interface LaunchSpec {
  bin: string;
  args: string[];
  /** Variables ADDED to the child's environment. Never the whole of process.env. */
  env: Record<string, string>;
  /** Launch files the args point at. Commands and text only, never secrets. */
  files: LaunchFile[];
  /** Tidy `<prefix>*` launch files: refresh `keep`, delete `remove`, and age out the rest (pruneLaunchFiles). */
  prune?: { prefix: string; keep?: string; remove?: string };
  /** Lines align prints to stderr before launching (why an injection was skipped). */
  notes?: string[];
  /** Files in the user's own agent config to add to ONCE (C4). Applied after the dry-run exit, never before. */
  writes?: ConfigWrite[];
}

export interface LaunchContext {
  passthrough: string[];
  /** The project already runs an align PreToolUse / PostToolUse hook against the local graph. */
  projectHasPreHook: boolean;
  projectHasPostHook: boolean;
  projectHasMcp: boolean;
  projectHasBlock: boolean;
  /** Absolute path a launch file will have once written. */
  cachePath(name: string): string;
}

/**
 * Not `align`: claude 2.1.291 lets a --mcp-config server REPLACE a same-named server the user
 * configured (verified: user `align`=A plus injected `align`=B starts only B). Injecting under
 * `align` would silently swap a user's prod or team graph for the local one.
 */
const INJECTED_SERVER_NAME = 'align-local';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Claude Code, per session, nothing written to the user's own config. No --strict-mcp-config
 * on purpose: strict mode would drop the user's own servers and the project's .mcp.json.
 * Each injection is skipped when the project already carries it, so nothing runs twice.
 *
 * ORDER MATTERS: the user's pass-through args come first and --mcp-config comes last.
 * claude's --mcp-config is variadic, so anything after it (a positional prompt) is read as
 * another config file path.
 */
export function buildClaudeLaunch(c: LaunchContext): LaunchSpec {
  const args: string[] = [...c.passthrough];
  const files: LaunchFile[] = [];
  const missing = (['PreToolUse', 'PostToolUse'] as const).filter((e) => !(e === 'PreToolUse' ? c.projectHasPreHook : c.projectHasPostHook));
  if (missing.length > 0) {
    const all = alignClaudeHooks('local');
    const name = missing.length === 2 ? 'claude-settings.json' : `claude-settings-${missing[0] === 'PreToolUse' ? 'pre' : 'post'}.json`;
    files.push({ name, content: json({ hooks: Object.fromEntries(missing.map((e) => [e, all[e]])) }) });
    args.push('--settings', c.cachePath(name));
  }
  if (!c.projectHasBlock) {
    files.push({ name: 'align-instructions.md', content: `${alignNudgeBody()}\n` });
    args.push('--append-system-prompt-file', c.cachePath('align-instructions.md'));
  }
  if (!c.projectHasMcp) {
    files.push({ name: 'claude-mcp.json', content: json({ mcpServers: { [INJECTED_SERVER_NAME]: alignServerEntry('mcpServers', 'local') } }) });
    args.push('--mcp-config', c.cachePath('claude-mcp.json'));
  }
  return { bin: 'claude', args, env: { ALIGN_WRAPPED: '1' }, files };
}
