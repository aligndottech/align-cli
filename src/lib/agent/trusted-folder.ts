import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { geminiFolderTrust } from '../launch/gemini-trust.js';
import { qwenFolderTrust } from '../launch/qwen-trust.js';
import { parseJsonc } from '../launch/strict-entry.js';

/**
 * Has the user already trusted this folder in a coding agent they use, or in Align itself? Each
 * agent keeps its own record, and any one of them counts, so the repo's skills and settings load
 * whichever agent or model the user picked. We only read these files, never write them:
 *  - Claude Code: `projects[<path>].hasTrustDialogAccepted === true` in `$CLAUDE_CONFIG_DIR/.claude.json`
 *    when that variable is set and non-empty, else `~/.claude.json` (Claude Code 2.1.322 reads
 *    `join(CLAUDE_CONFIG_DIR || home, '.claude.json')`, so a stale home file never grants trust).
 *  - Codex: `[projects."<path>"] trust_level = "trusted"` in `$CODEX_HOME/config.toml` (else ~/.codex).
 *  - Gemini CLI and Qwen Code: their own folder-trust verdict (gemini-trust.ts, qwen-trust.ts).
 *  - Copilot CLI: a path listed in `trusted_folders` in `$COPILOT_HOME/config.json` (else ~/.copilot).
 *  - Align: a path listed in `folders` in `~/.align/trusted-folders.json`, written when the user
 *    says yes to Align's own prompt.
 *
 * Fails CLOSED: a missing, unreadable or malformed file, or a value that is not exactly the trusted
 * one, all mean "no record". The candidates are the folder and each parent up to the nearest
 * directory holding `.git` (a folder or a file); with no `.git` above, the folder alone. The home
 * directory and the filesystem root never count. Claude Code, Codex, Copilot and Align records
 * must name a candidate exactly; Gemini and Qwen apply their own rules, which cover subfolders.
 */
const real = (p: string): string | undefined => {
  try { return realpathSync(p); } catch { return undefined; }
};

function repoChain(cwd: string): string[] {
  const start = real(cwd);
  if (start === undefined) return [];
  const chain: string[] = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    chain.push(dir);
    if (existsSync(path.join(dir, '.git'))) return chain;
    if (path.dirname(dir) === dir) return [start];
  }
}

/** The nearest ancestor of `cwd` holding `.git`; `cwd` itself when there is none. */
export function repoRoot(cwd: string): string {
  const chain = repoChain(cwd);
  return chain.length === 0 ? cwd : chain[chain.length - 1]!;
}

/** The agent folders whose `skills` the Align engine reads, in the home directory and, once trusted, in the repo. */
export const SKILL_DIRS = ['.pi', '.claude', '.agents', '.codex', '.gemini'] as const;

/** Does the repo root carry harness content a trusted session would load? */
export function repoHasHarness(cwd: string): boolean {
  const root = repoRoot(cwd);
  return ['.claude', '.agents', '.pi'].some((d) => existsSync(path.join(root, d)))
    || ['.codex', '.gemini'].some((d) => existsSync(path.join(root, d, 'skills')));
}

export type TrustSource = 'Claude Code' | 'Codex' | 'Gemini CLI' | 'Qwen Code' | 'Copilot CLI' | 'Align';
export interface FolderTrustOpts {
  home: string;
  env: Record<string, string | undefined>;
  platform: string;
  /** Align's own config folder, holding trusted-folders.json. */
  alignDir: string;
}

const readJsonFile = (file: string): unknown => {
  try { return JSON.parse(readFileSync(file, 'utf8')) as unknown; } catch { return undefined; }
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const realSet = (paths: string[]): Set<string> => new Set(paths.map((p) => real(p) ?? p));
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

function claudeTrusted(o: FolderTrustOpts): Set<string> {
  const projects = (readJsonFile(path.join(nonEmpty(o.env['CLAUDE_CONFIG_DIR']) ?? o.home, '.claude.json')) as { projects?: unknown } | undefined)?.projects;
  if (!isRecord(projects)) return new Set();
  return realSet(Object.keys(projects).filter((k) => (projects[k] as { hasTrustDialogAccepted?: unknown } | null)?.hasTrustDialogAccepted === true));
}

function codexTrusted(o: FolderTrustOpts): Set<string> {
  let projects: unknown;
  try {
    projects = (parseToml(readFileSync(path.join(nonEmpty(o.env['CODEX_HOME']) ?? path.join(o.home, '.codex'), 'config.toml'), 'utf8')) as { projects?: unknown }).projects;
  } catch {
    return new Set();
  }
  if (!isRecord(projects)) return new Set();
  return realSet(Object.keys(projects).filter((k) => (projects[k] as { trust_level?: unknown } | null)?.trust_level === 'trusted'));
}

function copilotTrusted(o: FolderTrustOpts): Set<string> {
  let config: unknown;
  try {
    config = parseJsonc(readFileSync(path.join(nonEmpty(o.env['COPILOT_HOME']) ?? path.join(o.home, '.copilot'), 'config.json'), 'utf8'));
  } catch {
    return new Set();
  }
  return realSet(stringList(isRecord(config) ? config['trusted_folders'] : undefined));
}

const alignTrustFile = (alignDir: string): string => path.join(alignDir, 'trusted-folders.json');
const alignTrustedList = (alignDir: string): string[] => {
  const data = readJsonFile(alignTrustFile(alignDir));
  return stringList(isRecord(data) ? data['folders'] : undefined);
};

/** Records the user's yes to Align's own trust prompt, so the next session in this folder loads it too. */
export function rememberAlignTrust(dir: string, alignDir: string): void {
  const folders = alignTrustedList(alignDir);
  if (folders.includes(dir)) return;
  mkdirSync(alignDir, { recursive: true, mode: 0o700 });
  writeFileSync(alignTrustFile(alignDir), `${JSON.stringify({ folders: [...folders, dir] }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The nearest candidate folder (this one, then parents up to the repo root) that any agent's record
 * trusts, and which agent said so; undefined when none does.
 */
export function folderTrust(cwd: string, o: FolderTrustOpts): { dir: string; by: TrustSource } | undefined {
  const resolvedHome = real(o.home) ?? o.home;
  const candidates = repoChain(cwd).filter((dir) => dir !== resolvedHome && dir !== path.parse(dir).root);
  if (candidates.length === 0) return undefined;
  const exact: Array<[TrustSource, () => Set<string>]> = [
    ['Claude Code', () => claudeTrusted(o)],
    ['Codex', () => codexTrusted(o)],
    ['Copilot CLI', () => copilotTrusted(o)],
    ['Align', () => realSet(alignTrustedList(o.alignDir))],
  ];
  // GEMINI_CLI_TRUST_WORKSPACE trusts every folder for Gemini; only a recorded rule counts here.
  const recordsOnly = { ...o.env, GEMINI_CLI_TRUST_WORKSPACE: undefined };
  const sets = exact.map(([by, read]) => [by, read()] as const);
  for (const dir of candidates) {
    const hit = sets.find(([, set]) => set.has(dir));
    if (hit) return { dir, by: hit[0] };
    if (geminiFolderTrust(dir, o.home, recordsOnly, o.platform) === 'trusted') return { dir, by: 'Gemini CLI' };
    if (qwenFolderTrust(dir, o.home, o.env, o.platform) === 'trusted') return { dir, by: 'Qwen Code' };
  }
  return undefined;
}
