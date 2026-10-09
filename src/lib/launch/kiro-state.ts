import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ancestors, readText } from './layer-files.js';
import { type AlignLocalState, isCanonicalLocalEntry, parseJsonc } from './strict-entry.js';

export interface KiroProjectState extends AlignLocalState {
  /** $KIRO_HOME/settings/mcp.json, else ~/.kiro/settings/mcp.json: the file align adds to. */
  mcpFile: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `.json` files in a directory, sorted; none when it is missing or unreadable. */
function jsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** KIRO_HOME "Override default ~/.kiro directory" (kiro.dev CLI reference). */
export function kiroDir(home: string, env: Record<string, string | undefined>): string {
  return env['KIRO_HOME'] ? path.resolve(env['KIRO_HOME']) : path.join(home, '.kiro');
}

/**
 * What Kiro CLI would already load for align, FROM ITS DOCS ONLY (agent configs included, below) (no binary was run; kiro.dev
 * docs/mcp/configuration): the global `~/.kiro/settings/mcp.json` and a workspace
 * `.kiro/settings/mcp.json`, merged "with workspace settings taking precedence", a higher
 * priority config "completely overrides lower ones for that specific server". So:
 *  - a canonical `align` or align-local in either file: present, nothing to add;
 *  - a non-canonical align-local in a workspace file (any directory from the cwd up, a superset
 *    of where Kiro looks) would replace ours: a conflict, nothing is written;
 *  - a non-canonical align-local in the global file: the writer never edits an existing entry,
 *    so that is a conflict too.
 */
export function readKiroState(cwd: string, home: string, opts: { localIsDefault: boolean }, env: Record<string, string | undefined>, platform: string): KiroProjectState {
  const o = { ...opts, platform, host: 'mcpServers' as const };
  const mcpFile = path.join(kiroDir(home, env), 'settings', 'mcp.json');
  const files = [mcpFile, ...ancestors(cwd).map((d) => path.join(d, '.kiro', 'settings', 'mcp.json')).filter((f) => f !== mcpFile)];
  const state: KiroProjectState = { present: false, overridden: [], mcpFile };
  for (const file of files) {
    const servers = parseJsonc(readText(file))?.['mcpServers'];
    if (!isObject(servers)) continue;
    if (isCanonicalLocalEntry(servers['align'], o) || isCanonicalLocalEntry(servers['align-local'], o)) state.present = true;
    else if ('align-local' in servers) state.conflict ??= file;
  }
  // Agent configs outrank both mcp.json files ("Agent Config - mcpServers field in agent JSON",
  // a same-named server is "completely" overridden). Every agent file in a workspace
  // .kiro/agents/ (cwd up) and the global agents dir is read, so whichever agent the user
  // selects (`--agent <name>`, or a default set with `kiro-cli agent set-default`) is covered.
  // A canonical entry there is no conflict, but it serves only that agent, so it is not "present".
  const agentDirs = [...ancestors(cwd).map((d) => path.join(d, '.kiro', 'agents')), path.join(kiroDir(home, env), 'agents')];
  for (const dir of agentDirs) {
    for (const file of jsonFiles(dir)) {
      const servers = parseJsonc(readText(file))?.['mcpServers'];
      if (isObject(servers) && 'align-local' in servers && !isCanonicalLocalEntry(servers['align-local'], o)) state.conflict ??= file;
    }
  }
  return state;
}
