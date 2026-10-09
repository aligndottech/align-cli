import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ALIGN_NUDGE_START } from '../agent-rules.js';
import { isLocalAlignServer, readsLocal } from './project-state.js';

export interface PiProjectState {
  /** A pi extension in the project, or pi's own extensions dir, already runs the local pre/post-edit check. */
  projectHasExtension: boolean;
  /** pi's MCP adapter already has a local align server (ours, or the user's own) in a file it reads. */
  projectHasMcp: boolean;
  projectHasBlock: boolean;
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

/** The cwd and each directory above it, up to and including the git root (none: all the way up). */
function projectDirs(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return dirs;
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
 * What pi would already load for this directory, so a per-session injection never doubles it.
 * "Present" means present AND doing the same job: an extension aimed at another graph does not
 * stand in for ours. Unreadable or malformed files count as absent: a wrong "absent" is a
 * duplicate, a throw is no session at all.
 */
export function readPiState(cwd: string, home: string, opts: { localIsDefault: boolean }, env: Record<string, string | undefined> = {}): PiProjectState {
  const { localIsDefault } = opts;
  const dirs = projectDirs(cwd);
  const agentDir = piAgentDir(home, env);
  const mcpFile = path.join(agentDir, 'mcp.json');
  const extensionFiles = [...dirs.map((d) => path.join(d, '.pi', 'extensions', 'align.ts')), path.join(agentDir, 'extensions', 'align.ts')];
  // pi-mcp-adapter reads the agent-dir file and the project's .mcp.json (agent-rules.ts).
  const servers = [mcpFile, path.join(cwd, '.mcp.json')].map((f) => readJson(f)?.['mcpServers'] as Json | undefined);
  const contextFiles = [...dirs.flatMap((d) => [path.join(d, 'AGENTS.md'), path.join(d, 'CLAUDE.md')]), path.join(agentDir, 'AGENTS.md')];
  return {
    projectHasExtension: extensionFiles.some((f) => extensionReadsLocal(readText(f), localIsDefault)),
    projectHasMcp: servers.some((s) => s?.['align-local'] !== undefined || isLocalAlignServer(s?.['align'], localIsDefault)),
    projectHasBlock: contextFiles.some((f) => readText(f)?.includes(ALIGN_NUDGE_START) ?? false),
    mcpFile,
  };
}
