import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface EditorTarget {
  name: string;
  configPath: string;
  configKey: string;
}

function alignServerEntry(env?: string) {
  return env ? { command: 'align', args: ['mcp', '--env', env] } : { command: 'align', args: ['mcp'] };
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
      configKey: 'mcpServers',
    });
  }

  // Claude Code (global ~/.claude.json)
  const claudeCodeConfig = path.join(home, '.claude.json');
  if (existsSync(claudeCodeConfig)) {
    found.push({
      name: 'Claude Code',
      configPath: claudeCodeConfig,
      configKey: 'mcpServers',
    });
  }

  // Cursor (~/.cursor/mcp.json)
  const cursorDir = path.join(home, '.cursor');
  if (existsSync(cursorDir)) {
    found.push({
      name: 'Cursor',
      configPath: path.join(cursorDir, 'mcp.json'),
      configKey: 'mcpServers',
    });
  }

  return found;
}

export function writeMcpConfig(target: EditorTarget, env?: string): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(target.configPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      throw new Error(`${target.configPath} contains invalid JSON - fix it manually before running align mcp --setup`);
    }
  }

  const servers = (existing[target.configKey] ?? {}) as Record<string, unknown>;
  servers['align'] = alignServerEntry(env);
  existing[target.configKey] = servers;

  const dir = path.dirname(target.configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(target.configPath, JSON.stringify(existing, null, 2), 'utf8');
}
