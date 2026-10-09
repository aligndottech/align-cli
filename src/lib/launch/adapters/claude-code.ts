import { alignClaudeHooks, alignNudgeBody } from '../../agent-rules.js';
import { alignServerEntry } from '../../mcp-setup.js';

export interface LaunchFile {
  name: string;
  content: string;
}

/** What to run: pure data, so the builder is testable without spawning anything. */
export interface LaunchSpec {
  bin: string;
  args: string[];
  /** Variables ADDED to the child's environment. Never the whole of process.env. */
  env: Record<string, string>;
  /** Launch files the args point at. Commands and text only, never secrets. */
  files: LaunchFile[];
}

export interface LaunchContext {
  passthrough: string[];
  projectHasHooks: boolean;
  projectHasMcp: boolean;
  projectHasBlock: boolean;
  /** Absolute path a launch file will have once written. */
  cachePath(name: string): string;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Claude Code, per session, nothing written to the user's own config. No --strict-mcp-config
 * on purpose: strict mode would drop the user's own servers and the project's .mcp.json.
 * Each injection is skipped when the project already carries it, so nothing runs twice.
 */
export function buildClaudeLaunch(c: LaunchContext): LaunchSpec {
  const args: string[] = [];
  const files: LaunchFile[] = [];
  if (!c.projectHasMcp) {
    files.push({ name: 'claude-mcp.json', content: json({ mcpServers: { align: alignServerEntry('mcpServers', 'local') } }) });
    args.push('--mcp-config', c.cachePath('claude-mcp.json'));
  }
  if (!c.projectHasHooks) {
    files.push({ name: 'claude-settings.json', content: json({ hooks: alignClaudeHooks('local') }) });
    args.push('--settings', c.cachePath('claude-settings.json'));
  }
  if (!c.projectHasBlock) {
    files.push({ name: 'align-instructions.md', content: `${alignNudgeBody()}\n` });
    args.push('--append-system-prompt-file', c.cachePath('align-instructions.md'));
  }
  return { bin: 'claude', args: [...args, ...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files };
}
