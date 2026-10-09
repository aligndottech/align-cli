import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { carriesLocalEnv, type OnForeign } from './foreign-env.js';
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
//  - 'opencode' JSON     {"mcp":{"align":{"type":"local","command":[...]}}}  OpenCode (command is ONE array)
export type McpFormat = 'mcpServers' | 'vscode' | 'zed' | 'codex' | 'pi' | 'copilot' | 'opencode';

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

/**
 * How a client should SPAWN the align MCP server, per platform (ALI-1135).
 *
 * An npm global install on Windows exposes `align.cmd`, a batch shim, and a Windows process
 * spawn resolves a `.cmd` only through a shell - Node's own child_process refuses one outright
 * without `shell: true` since CVE-2024-27980. So `command: "align"` names something the client
 * cannot launch, and it fails on OUR side, silently: our write succeeded, so nothing here has
 * an error to report, and the user sees an ENOENT from a config Align wrote for them.
 *
 * `cmd` is a real executable, so `cmd /c align mcp` launches whether or not the client spawns
 * through a shell of its own, and cmd resolves `align` -> `align.cmd` through PATH + PATHEXT.
 * That is the form the MCP ecosystem settled on for exactly this (microsoft/vscode#299595,
 * modelcontextprotocol/servers#3460), and the form this repo's own Windows smoke already
 * depends on (scripts/smoke-install.sh, the MCP handshake step).
 *
 * ONE writer of this fact, used by every format including the Codex TOML block, because the
 * reported site is a lower bound: every client in detectEditors() spawns the same way.
 */
function alignSpawn(env?: string): { command: string; args: string[] } {
  const args = alignArgs(env);
  return process.platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'align', ...args] }
    : { command: 'align', args };
}

// The per-format entry shape for the `align` server. VS Code requires `type`;
// Zed silently drops entries without `source: "custom"`. Exported so the shared
// project-local .mcp.json (agent-rules.ts) builds the entry from here rather than
// keeping a second copy that can drift from this one.
export function alignServerEntry(
  format: McpFormat,
  env?: string,
  opts: { committed?: boolean } = {},
): Record<string, unknown> {
  // `committed` is for a file that TRAVELS between machines - today only the project-local
  // `.mcp.json`, which agent-rules.ts writes once for the whole team. There is no string that
  // spawns on both platforms, so the Windows wrapper below is correct for the machine that ran
  // the command and wrong for everyone else's checkout. A per-machine config takes the
  // wrapper; a committed one stays portable and its Windows readers use their user-level
  // entry, which `align mcp --setup` writes with the wrapper (ALI-1135).
  const { command, args } = opts.committed ? { command: 'align', args: alignArgs(env) } : alignSpawn(env);
  switch (format) {
    case 'vscode':
      return { type: 'stdio', command, args };
    case 'zed':
      return { source: 'custom', command, args };
    case 'pi':
      // pi's MCP adapter is lazy by default: every server hides behind one proxy tool
      // the agent has to search before it can call anything. That directly undercuts
      // ALIGN_MCP_INSTRUCTIONS' "call align_check_alignment BEFORE writing code", so
      // ask for the tools to be registered directly.
      return { command, args, directTools: true };
    case 'copilot':
      // Copilot CLI requires `type` and a `tools` allowlist; without `tools` the server is
      // configured and none of its tools are callable (GitHub's MCP configuration docs).
      return { type: 'local', command, args, tools: ['*'] };
    case 'opencode':
      // OpenCode takes the executable and its arguments as a single `command` array.
      return { type: 'local', command: [command, ...args] };
    default:
      return { command, args };
  }
}

function jsonTopKey(format: McpFormat): string {
  switch (format) {
    case 'vscode':
      return 'servers';
    case 'zed':
      return 'context_servers';
    case 'opencode':
      return 'mcp';
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

  // OpenCode. Global config is ~/.config/opencode/opencode.json (opencode.ai/docs/config:
  // "~/.config/opencode/opencode.json for the main config"), honouring an absolute
  // $XDG_CONFIG_HOME like the rest of the XDG-based tools. A user who keeps opencode.jsonc
  // instead is fine: OpenCode merges every config it finds, so our file simply sits beside it.
  const xdgConfig = process.env['XDG_CONFIG_HOME'];
  const openCodeDir = path.join(xdgConfig && path.isAbsolute(xdgConfig) ? xdgConfig : path.join(home, '.config'), 'opencode');
  if (existsSync(openCodeDir)) {
    found.push({ name: 'OpenCode', configPath: path.join(openCodeDir, 'opencode.json'), format: 'opencode' });
  }

  return found;
}

// Codex uses TOML, not JSON. We manage only the `align` table via a marker-delimited
// block (the same idempotent pattern as the CLAUDE.md nudge) so re-runs replace it
// cleanly and the rest of config.toml - other servers, settings - is preserved.
const CODEX_BLOCK_START = '# >>> align (managed by `align setup` - do not edit) >>>';
const CODEX_BLOCK_END = '# <<< align <<<';

function codexBlock(env?: string): string {
  // Through alignSpawn, not a second `command = "align"` of its own: this block used to
  // carry the literal, so the platform fix would have landed on the JSON formats and left
  // Codex broken on Windows - two writers of one fact (code-style.md).
  const spawn = alignSpawn(env);
  const args = spawn.args.map((a) => `"${a}"`).join(', ');
  return [
    CODEX_BLOCK_START,
    '[mcp_servers.align]',
    `command = "${spawn.command}"`,
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

function writeCodexConfig(configPath: string, env?: string, onForeign?: OnForeign): boolean {
  const existing = readConfig(configPath, 'codex');
  const block = codexBlock(env);

  // Opt-in: only a caller that passes onForeign (the wizard's local wiring) preserves a team
  // entry. Explicit `align mcp --setup --env local` passes none, and overwrites by design.
  if (onForeign && env === 'local' && codexAlignTargetsElsewhere(existing)) {
    onForeign(configPath);
    return false;
  }

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
  return true;
}

/**
 * An `[mcp_servers.align]` table that is not our managed local block: hand-written, or our
 * block written for a team env. The local wizard leaves both alone.
 */
function codexAlignTargetsElsewhere(existing: string): boolean {
  if (!/^\s*\[mcp_servers\.align\]/m.test(existing)) return false;
  const start = existing.indexOf(CODEX_BLOCK_START);
  const end = existing.indexOf(CODEX_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return true;
  return !carriesLocalEnv(existing.slice(start, end));
}

/**
 * Whether this agent already has an `align` entry that is not pointed at the local graph. Used
 * by `align mcp --setup --env local` to say it REPLACED one. Never throws: an unreadable file
 * reads as "no".
 */
export function alignEntryTargetsElsewhere(target: EditorTarget): boolean {
  try {
    const raw = readConfig(target.configPath, target.format);
    if (!raw.trim()) return false;
    if (target.format === 'codex') return codexAlignTargetsElsewhere(raw);
    const servers = (JSON.parse(raw) as Record<string, unknown>)[jsonTopKey(target.format)] as Record<string, unknown> | undefined;
    return servers?.['align'] !== undefined && !carriesLocalEnv(JSON.stringify(servers['align']));
  } catch {
    return false;
  }
}

function writeJsonConfig(target: EditorTarget, env?: string, onForeign?: OnForeign): boolean {
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
  if (onForeign && env === 'local' && servers['align'] !== undefined && !carriesLocalEnv(JSON.stringify(servers['align']))) {
    onForeign(target.configPath);
    return false;
  }
  servers['align'] = alignServerEntry(target.format, env);
  existing[key] = servers;

  ensureDir(target.configPath);
  writeFileSync(target.configPath, JSON.stringify(existing, null, 2), 'utf8');
  return true;
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
export function writeMcpConfig(target: EditorTarget, env?: string, onForeign?: OnForeign): string[] {
  const written: string[] = [];
  const wroteMcp = target.format === 'codex'
    ? writeCodexConfig(target.configPath, env, onForeign)
    : writeJsonConfig(target, env, onForeign);
  if (wroteMcp) written.push(target.configPath);
  if (target.hooks && writeUserHooks(target.hooks, env, onForeign)) written.push(target.hooks.path);
  return written;
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
