import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { removeUserHooks, type UserHookTarget, writeUserHooks } from './user-hooks.js';

// Align is agent-agnostic: any MCP-capable client is a first-class setup target.
// Clients fall into a few config shapes, so each target carries a `format` the
// writer dispatches on:
//  - 'mcpServers' JSON   {"mcpServers":{"align":{"command","args"}}}        Claude Desktop/Code, Cursor, Windsurf, Gemini CLI
//  - 'vscode' JSON       {"servers":{"align":{"type":"stdio","command","args"}}}   VS Code (Copilot)
//  - 'zed' JSON          {"context_servers":{"align":{"source":"custom","command","args"}}}  Zed
//  - 'codex' TOML        [mcp_servers.align] table                          OpenAI Codex CLI
//  - 'pi' JSON           {"mcpServers":{"align":{...,"directTools":true}}}   pi (pi.dev)
//  - 'copilot' JSON      {"mcpServers":{"align":{"type":"local","command","args","tools":["*"]}}}  GitHub Copilot CLI
export type McpFormat = 'mcpServers' | 'vscode' | 'zed' | 'codex' | 'pi' | 'copilot';

export interface EditorTarget {
  name: string;
  configPath: string;
  format: McpFormat;
  /**
   * The host's USER-level hook file, for the hosts that have one (ALI-952: Codex, Cursor,
   * Copilot CLI). writeMcpConfig writes the advisory pre-edit hook there next to the MCP
   * entry, and removeMcpConfig takes it out again. Absent on hosts with no hook API.
   */
  hooks?: UserHookTarget;
}

function alignArgs(env?: string): string[] {
  return env ? ['mcp', '--env', env] : ['mcp'];
}

// The per-format entry shape for the `align` server. VS Code requires `type`;
// Zed silently drops entries without `source: "custom"`. Exported so the shared
// project-local .mcp.json (agent-rules.ts) builds the entry from here rather than
// keeping a second copy that can drift from this one.
export function alignServerEntry(format: McpFormat, env?: string): Record<string, unknown> {
  const args = alignArgs(env);
  switch (format) {
    case 'vscode':
      return { type: 'stdio', command: 'align', args };
    case 'zed':
      return { source: 'custom', command: 'align', args };
    case 'pi':
      // pi's MCP adapter is lazy by default: every server hides behind one proxy tool
      // the agent has to search before it can call anything. That directly undercuts
      // ALIGN_MCP_INSTRUCTIONS' "call align_check_alignment BEFORE writing code", so
      // ask for the tools to be registered directly.
      return { command: 'align', args, directTools: true };
    case 'copilot':
      // Copilot CLI requires `type` and a `tools` allowlist; without `tools` the server is
      // configured and none of its tools are callable (GitHub's MCP configuration docs).
      return { type: 'local', command: 'align', args, tools: ['*'] };
    default:
      return { command: 'align', args };
  }
}

function jsonTopKey(format: McpFormat): string {
  switch (format) {
    case 'vscode':
      return 'servers';
    case 'zed':
      return 'context_servers';
    default:
      return 'mcpServers';
  }
}

function vscodeUserDir(home: string): string {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  if (process.platform === 'win32') return path.join(process.env['APPDATA'] ?? home, 'Code', 'User');
  return path.join(home, '.config', 'Code', 'User');
}

export function detectEditors(): EditorTarget[] {
  const home = os.homedir();
  const found: EditorTarget[] = [];

  // Claude Desktop
  let claudeDesktopDir: string;
  if (process.platform === 'darwin') {
    claudeDesktopDir = path.join(home, 'Library', 'Application Support', 'Claude');
  } else if (process.platform === 'win32') {
    claudeDesktopDir = path.join(process.env['APPDATA'] ?? home, 'Claude');
  } else {
    claudeDesktopDir = path.join(home, '.config', 'Claude');
  }
  if (existsSync(claudeDesktopDir)) {
    found.push({
      name: 'Claude Desktop',
      configPath: path.join(claudeDesktopDir, 'claude_desktop_config.json'),
      format: 'mcpServers',
    });
  }

  // Claude Code (global ~/.claude.json)
  if (existsSync(path.join(home, '.claude.json'))) {
    found.push({ name: 'Claude Code', configPath: path.join(home, '.claude.json'), format: 'mcpServers' });
  }

  // Cursor (~/.cursor/mcp.json). Hooks: ~/.cursor/hooks.json, Cursor 1.7+ (ALI-952).
  if (existsSync(path.join(home, '.cursor'))) {
    found.push({
      name: 'Cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      format: 'mcpServers',
      hooks: { host: 'cursor', path: path.join(home, '.cursor', 'hooks.json') },
    });
  }

  // Windsurf (~/.codeium/windsurf/mcp_config.json)
  if (existsSync(path.join(home, '.codeium', 'windsurf'))) {
    found.push({
      name: 'Windsurf',
      configPath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      format: 'mcpServers',
    });
  }

  // VS Code (Copilot) - user-profile mcp.json, top-level `servers`, entry needs type:stdio
  const vscodeDir = vscodeUserDir(home);
  if (existsSync(vscodeDir)) {
    found.push({ name: 'VS Code', configPath: path.join(vscodeDir, 'mcp.json'), format: 'vscode' });
  }

  // Zed (~/.config/zed/settings.json, `context_servers`)
  if (existsSync(path.join(home, '.config', 'zed'))) {
    found.push({ name: 'Zed', configPath: path.join(home, '.config', 'zed', 'settings.json'), format: 'zed' });
  }

  // OpenAI Codex CLI (~/.codex/config.toml). Hooks: ~/.codex/hooks.json (ALI-952).
  if (existsSync(path.join(home, '.codex'))) {
    found.push({
      name: 'Codex',
      configPath: path.join(home, '.codex', 'config.toml'),
      format: 'codex',
      hooks: { host: 'codex', path: path.join(home, '.codex', 'hooks.json') },
    });
  }

  // GitHub Copilot CLI (~/.copilot/mcp-config.json). Hooks: one file of ours under
  // ~/.copilot/hooks/, which Copilot loads alongside any others there (ALI-952).
  if (existsSync(path.join(home, '.copilot'))) {
    found.push({
      name: 'Copilot CLI',
      configPath: path.join(home, '.copilot', 'mcp-config.json'),
      format: 'copilot',
      hooks: { host: 'copilot', path: path.join(home, '.copilot', 'hooks', 'align.json') },
    });
  }

  // pi (pi.dev) - MCP comes from the `pi-mcp-adapter` package, which reads the Pi agent
  // dir (~/.pi/agent by default, relocatable via $PI_CODING_AGENT_DIR). Write the Pi-owned
  // override rather than a shared file: it is where adapter-only settings like directTools
  // belong, and it never rewrites another host's config.
  const piAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const piRoot = piAgentDir ?? path.join(home, '.pi');
  if (existsSync(piRoot)) {
    found.push({
      name: 'pi',
      configPath: path.join(piAgentDir ?? path.join(home, '.pi', 'agent'), 'mcp.json'),
      format: 'pi',
    });
  }

  // Gemini CLI (~/.gemini/settings.json, `mcpServers`)
  if (existsSync(path.join(home, '.gemini'))) {
    found.push({ name: 'Gemini CLI', configPath: path.join(home, '.gemini', 'settings.json'), format: 'mcpServers' });
  }

  return found;
}

// Codex uses TOML, not JSON. We manage only the `align` table via a marker-delimited
// block (the same idempotent pattern as the CLAUDE.md nudge) so re-runs replace it
// cleanly and the rest of config.toml - other servers, settings - is preserved.
const CODEX_BLOCK_START = '# >>> align (managed by `align setup` - do not edit) >>>';
const CODEX_BLOCK_END = '# <<< align <<<';

function codexBlock(env?: string): string {
  const args = alignArgs(env).map((a) => `"${a}"`).join(', ');
  return [
    CODEX_BLOCK_START,
    '[mcp_servers.align]',
    'command = "align"',
    `args = [${args}]`,
    CODEX_BLOCK_END,
  ].join('\n');
}

function readConfig(configPath: string, format: McpFormat): string {
  try {
    return readFileSync(configPath, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      // JSON formats fail loudly on a corrupt file so we never clobber it; TOML is
      // edited as text so a read error there is genuinely just a missing file.
      if (format !== 'codex') {
        throw new Error(`${configPath} contains invalid JSON - fix it manually before running align mcp --setup`);
      }
    }
    return '';
  }
}

function ensureDir(configPath: string): void {
  const dir = path.dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeCodexConfig(configPath: string, env?: string): void {
  const existing = readConfig(configPath, 'codex');
  const block = codexBlock(env);

  let content: string;
  const start = existing.indexOf(CODEX_BLOCK_START);
  const end = existing.indexOf(CODEX_BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    content = `${existing.slice(0, start)}${block}${existing.slice(end + CODEX_BLOCK_END.length)}`;
  } else if (existing.trim()) {
    content = `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
  } else {
    content = `${block}\n`;
  }

  ensureDir(configPath);
  writeFileSync(configPath, content, 'utf8');
}

function writeJsonConfig(target: EditorTarget, env?: string): void {
  const raw = readConfig(target.configPath, target.format);
  let existing: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`${target.configPath} contains invalid JSON - fix it manually before running align mcp --setup`);
    }
  }

  const key = jsonTopKey(target.format);
  const servers = (existing[key] ?? {}) as Record<string, unknown>;
  servers['align'] = alignServerEntry(target.format, env);
  existing[key] = servers;

  ensureDir(target.configPath);
  writeFileSync(target.configPath, JSON.stringify(existing, null, 2), 'utf8');
}

/**
 * Take Align back out of an agent's MCP config (ALI-776).
 *
 * Setup wires detected agents automatically rather than asking, which is only defensible
 * because the write is additive AND reversible. This is the reversible half - without it,
 * "you can hand-edit the JSON" is the undo, and that is not one.
 *
 * Removes exactly the `align` entry and nothing else, mirroring what writeMcpConfig added.
 * Returns whether there was anything to remove, so the caller can say "nothing to undo"
 * rather than implying it did something.
 *
 * Throws on a config it cannot parse rather than rewriting it - the same rule
 * writeJsonConfig follows, and for the same reason: a rewrite would destroy whatever the
 * user was part-way through editing.
 */
export function removeMcpConfig(target: EditorTarget): boolean {
  // The hook file first, and unconditionally: it is a separate file, so an MCP config that
  // was already hand-cleaned must not leave the hook behind (ALI-952).
  const hookRemoved = target.hooks ? removeUserHooks(target.hooks) : false;
  return removeMcpEntry(target) || hookRemoved;
}

function removeMcpEntry(target: EditorTarget): boolean {
  if (!existsSync(target.configPath)) return false;

  if (target.format === 'codex') {
    const existing = readConfig(target.configPath, 'codex');
    const start = existing.indexOf(CODEX_BLOCK_START);
    const end = existing.indexOf(CODEX_BLOCK_END);
    // Both markers, in order. A half-present fence means someone edited inside it, and
    // guessing where the block ends would take their work with it.
    if (start === -1 || end === -1 || end < start) return false;
    const without = `${existing.slice(0, start)}${existing.slice(end + CODEX_BLOCK_END.length)}`;
    writeFileSync(target.configPath, `${without.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '')}`, 'utf8');
    return true;
  }

  const raw = readConfig(target.configPath, target.format);
  if (!raw.trim()) return false;
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${target.configPath} contains invalid JSON - fix it manually, or delete the "align" entry by hand`);
  }
  const key = jsonTopKey(target.format);
  const servers = existing[key] as Record<string, unknown> | undefined;
  if (!servers || !('align' in servers)) return false;
  delete servers['align'];
  writeFileSync(target.configPath, JSON.stringify(existing, null, 2), 'utf8');
  return true;
}

/**
 * Wire one agent: its MCP entry, plus the user-level advisory hook on the hosts that have
 * one (ALI-952). Returns every file it wrote, in order, for the caller to disclose - the
 * hook file is the one a user would not expect to have been touched.
 */
export function writeMcpConfig(target: EditorTarget, env?: string): string[] {
  if (target.format === 'codex') {
    writeCodexConfig(target.configPath, env);
  } else {
    writeJsonConfig(target, env);
  }
  if (!target.hooks) return [target.configPath];
  writeUserHooks(target.hooks, env);
  return [target.configPath, target.hooks.path];
}

/**
 * ALI-950: is Align already in this agent's config? The second-run card names the agents
 * wired NOW, which is a different question from detectEditors' "installed": an agent whose
 * write failed, or that `align mcp --remove` ran on, is installed and not connected, and
 * telling someone to open it hands them an agent that cannot answer.
 *
 * Never throws - the card must never error - so an unparseable config reads as not wired.
 * Mirrors removeMcpConfig's own lookup (JSON key per format, marker block for Codex).
 */
export function hasAlignEntry(target: EditorTarget): boolean {
  try {
    const raw = readConfig(target.configPath, target.format);
    if (!raw.trim()) return false;
    if (target.format === 'codex') {
      const start = raw.indexOf(CODEX_BLOCK_START);
      const end = raw.indexOf(CODEX_BLOCK_END);
      return start !== -1 && end !== -1 && end > start;
    }
    const servers = (JSON.parse(raw) as Record<string, unknown>)[jsonTopKey(target.format)];
    return typeof servers === 'object' && servers !== null && 'align' in servers;
  } catch {
    return false;
  }
}

export function detectWiredEditors(): EditorTarget[] {
  return detectEditors().filter(hasAlignEntry);
}

/**
 * The agent wired through this repo's project config. `.mcp.json` is what
 * setupAgentAlignment writes (agent-rules.ts); Claude Code reads it as a project config.
 * (pi reads it too, via pi-mcp-adapter, but only when installed - naming an agent that may
 * not exist on the machine is the same error as naming one that is not connected.)
 */
export function projectMcpAgents(cwd: string): string[] {
  try {
    const raw = readFileSync(path.join(cwd, '.mcp.json'), 'utf8');
    const servers = (JSON.parse(raw) as Record<string, unknown>)['mcpServers'];
    return typeof servers === 'object' && servers !== null && 'align' in servers ? ['Claude Code'] : [];
  } catch {
    return [];
  }
}
