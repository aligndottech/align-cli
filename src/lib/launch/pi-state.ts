import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { ALIGN_NUDGE_START } from '../agent-rules.js';
import { isLocalAlignServer, readsLocal } from './project-state.js';

export interface PiProjectState {
  /** The extension would load AND do the same job: global, or project-local in a project pi trusts. */
  projectHasExtension: boolean;
  /** pi's MCP adapter already has a local align server (ours, or the user's own) in a file it reads. */
  projectHasMcp: boolean;
  projectHasBlock: boolean;
  /** pi-mcp-adapter is installed as a pi package, so an MCP entry would be read at all. */
  mcpAdapterInstalled: boolean;
  /** <agentDir>/mcp.json: the file the MCP entry is written to. */
  mcpFile: string;
}

type Json = Record<string, unknown>;

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file: string): Json | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

/** The cwd and every directory above it, to the filesystem root (pi's context files do not stop at a git root). */
function ancestors(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.dirname(dir) === dir) return dirs;
  }
}

/** PI_CODING_AGENT_DIR, else ~/.pi/agent. Read only: align never redirects it (it holds auth and history). */
export function piAgentDir(home: string, env: Record<string, string | undefined>): string {
  const set = env['PI_CODING_AGENT_DIR'];
  return set ? set : path.join(home, '.pi', 'agent');
}

/** The extension writer's own output: the check call for pi, and an optional `"--env", "<name>"` pair. */
function extensionReadsLocal(text: string | null, localIsDefault: boolean): boolean {
  if (text === null || !text.includes('"check", "--advisory", "--format", "pi"')) return false;
  const env = /"--env",\s*"([^"]+)"/.exec(text)?.[1];
  return readsLocal(env === undefined ? [] : ['--env', env], localIsDefault);
}

/**
 * Does pi load project-local extensions for this directory? README "Project Trust": project
 * extensions load only after the project is trusted. The saved decision is the nearest entry
 * (the folder or a parent) in <agentDir>/trust.json; with none, `defaultProjectTrust` in the
 * global settings decides, and only `always` trusts. Anything unreadable is "not trusted":
 * the cost of a wrong "no" is a duplicate check, the cost of a wrong "yes" is no check at all.
 */
function projectTrusted(cwd: string, agentDir: string): boolean {
  const trust = readJson(path.join(agentDir, 'trust.json')) ?? {};
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* keep cwd */ }
  for (const dir of [...ancestors(cwd), ...ancestors(real)]) {
    const v = trust[dir];
    if (typeof v === 'boolean') return v;
  }
  return readJson(path.join(agentDir, 'settings.json'))?.['defaultProjectTrust'] === 'always';
}

/** `packages` entries are strings or `{ source }` objects. */
function packageSources(settings: Json | null): string[] {
  const list = settings?.['packages'];
  return Array.isArray(list) ? list.map((p) => (typeof p === 'string' ? p : String((p as { source?: unknown } | null)?.source ?? ''))) : [];
}

/**
 * pi loads AGENTS.md (or CLAUDE.md) from the agent dir, every parent directory up from cwd, and
 * cwd; a directory's AGENTS.override.md is loaded instead of its AGENTS.md / CLAUDE.md (pi README,
 * "Context Files"). Per directory that is one file; which of AGENTS.md and CLAUDE.md wins when
 * both exist is not stated, so AGENTS.md is taken first.
 */
function contextFile(dir: string): string | null {
  for (const name of ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']) {
    const f = path.join(dir, name);
    if (existsSync(f)) return f;
  }
  return null;
}

/**
 * What pi would already load for this directory, so a per-session injection never doubles it.
 * "Present" means present AND doing the same job: an extension aimed at another graph does not
 * stand in for ours. Unreadable or malformed files count as absent: a wrong "absent" is a
 * duplicate, a throw is no session at all.
 */
export function readPiState(cwd: string, home: string, opts: { localIsDefault: boolean }, env: Record<string, string | undefined> = {}): PiProjectState {
  const { localIsDefault } = opts;
  const dirs = ancestors(cwd);
  const agentDir = piAgentDir(home, env);
  const mcpFile = path.join(agentDir, 'mcp.json');
  const trusted = projectTrusted(cwd, agentDir);
  const globalExt = extensionReadsLocal(readText(path.join(agentDir, 'extensions', 'align.ts')), localIsDefault);
  const projectExt = trusted && dirs.some((d) => extensionReadsLocal(readText(path.join(d, '.pi', 'extensions', 'align.ts')), localIsDefault));
  // pi-mcp-adapter reads the agent-dir file and the project's .mcp.json (agent-rules.ts).
  const servers = [mcpFile, path.join(cwd, '.mcp.json')].map((f) => readJson(f)?.['mcpServers'] as Json | undefined);
  const contextFiles = [...dirs.map(contextFile), contextFile(agentDir)].filter((f): f is string => f !== null);
  const settings = [readJson(path.join(agentDir, 'settings.json')), ...(trusted ? [readJson(path.join(cwd, '.pi', 'settings.json'))] : [])];
  return {
    projectHasExtension: globalExt || projectExt,
    projectHasMcp: servers.some((s) => s?.['align-local'] !== undefined || isLocalAlignServer(s?.['align'], localIsDefault)),
    projectHasBlock: contextFiles.some((f) => readText(f)?.includes(ALIGN_NUDGE_START) ?? false),
    mcpAdapterInstalled: settings.some((s) => packageSources(s).some((p) => p.includes('pi-mcp-adapter'))),
    mcpFile,
  };
}
