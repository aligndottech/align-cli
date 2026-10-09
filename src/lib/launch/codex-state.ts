import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isLocalAlignServer } from './project-state.js';

export interface CodexProjectState {
  /** Codex would already start a local align server: our align-local, or the user's align at --env local. */
  projectHasMcp: boolean;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The cwd and each directory above it, up to and including the git root (or the filesystem root). */
function projectDirs(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return dirs;
  }
}

/**
 * The body of one `[mcp_servers.<name>]` table (bare or quoted key), up to the next table
 * header, or null when the file has no such table. Not a TOML parser: enough to read the
 * shapes `align setup` and `codex mcp add` write, and anything else reads as absent.
 */
function tableBody(text: string, name: string): string | null {
  const header = new RegExp(`^\\s*\\[mcp_servers\\.(?:${name}|"${name}")\\]\\s*$`, 'm');
  const m = header.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^\s*\[/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The `command` and `args` strings of a table body, as one token list. */
function bodyTokens(body: string): string[] {
  const line = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(body)?.[1] ?? '';
  return [...`${line('command')} ${line('args')}`.matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2] ?? '');
}

function hasLocalServer(text: string | null, localIsDefault: boolean): boolean {
  if (text === null) return false;
  if (tableBody(text, 'align-local') !== null) return true;
  const align = tableBody(text, 'align');
  if (align === null || /^\s*enabled\s*=\s*false\b/m.test(align)) return false;
  const tokens = bodyTokens(align);
  const [command, ...args] = tokens;
  return isLocalAlignServer({ command, args }, localIsDefault);
}

/**
 * What Codex would already load for this directory, so the per-session `-c` never doubles it:
 * $CODEX_HOME/config.toml (default ~/.codex) and each .codex/config.toml from cwd to the git
 * root. Unreadable counts as absent: a wrong "absent" is a duplicate, a throw is no session.
 */
export function readCodexState(cwd: string, home: string, opts: { localIsDefault: boolean }, env: Record<string, string | undefined> = {}): CodexProjectState {
  const codexHome = env['CODEX_HOME'] ? env['CODEX_HOME'] : path.join(home, '.codex');
  const files = [path.join(codexHome, 'config.toml'), ...projectDirs(cwd).map((d) => path.join(d, '.codex', 'config.toml'))];
  return { projectHasMcp: files.some((f) => hasLocalServer(readText(f), opts.localIsDefault)) };
}
