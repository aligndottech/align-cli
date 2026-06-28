import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Align is agent-agnostic: any MCP-capable client is a first-class setup target.
// Clients fall into a few config shapes, so each target carries a `format` the
// writer dispatches on:
//  - 'mcpServers' JSON   {"mcpServers":{"align":{"command","args"}}}        Claude Desktop/Code, Cursor, Windsurf, Gemini CLI
//  - 'vscode' JSON       {"servers":{"align":{"type":"stdio","command","args"}}}   VS Code (Copilot)
//  - 'zed' JSON          {"context_servers":{"align":{"source":"custom","command","args"}}}  Zed
//  - 'codex' TOML        [mcp_servers.align] table                          OpenAI Codex CLI
export type McpFormat = 'mcpServers' | 'vscode' | 'zed' | 'codex';

export interface EditorTarget {
  name: string;
  configPath: string;
  format: McpFormat;
}

function alignArgs(env?: string): string[] {
  return env ? ['mcp', '--env', env] : ['mcp'];
}

// The per-format entry shape for the `align` server. VS Code requires `type`;
// Zed silently drops entries without `source: "custom"`.
function alignServerEntry(format: McpFormat, env?: string): Record<string, unknown> {
  const args = alignArgs(env);
  switch (format) {
    case 'vscode':
      return { type: 'stdio', command: 'align', args };
    case 'zed':
      return { source: 'custom', command: 'align', args };
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

  // Cursor (~/.cursor/mcp.json)
  if (existsSync(path.join(home, '.cursor'))) {
    found.push({ name: 'Cursor', configPath: path.join(home, '.cursor', 'mcp.json'), format: 'mcpServers' });
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

  // OpenAI Codex CLI (~/.codex/config.toml)
  if (existsSync(path.join(home, '.codex'))) {
    found.push({ name: 'Codex', configPath: path.join(home, '.codex', 'config.toml'), format: 'codex' });
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

export function writeMcpConfig(target: EditorTarget, env?: string): void {
  if (target.format === 'codex') {
    writeCodexConfig(target.configPath, env);
    return;
  }
  writeJsonConfig(target, env);
}