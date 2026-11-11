import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import type { HookToolInput } from '../hook-payload.js';

/**
 * Deterministic dependency intent for the advisory hook.
 *
 * Retrieval embeds the raw new text of an edit, and a JSON line or an `import` line scores far
 * under the relates threshold against a rule like "No new dependencies without review", while a
 * sentence about the same change does not. So when an edit ADDS a dependency, the hook also asks
 * retrieval a synthesized sentence. No model call and no new threshold: the sentence is built from
 * what the edit changes in an npm manifest, or from bare-package imports the nearest package.json
 * does not list. Fails open to null on any read or parse problem.
 *
 * Covered: npm (package.json; `dependencies`, `devDependencies`, `peerDependencies`,
 * `optionalDependencies`) and JS/TS import, export-from, require and dynamic import.
 * NOT covered yet: pyproject.toml, requirements.txt, go.mod, Cargo.toml, Gemfile, pom.xml and
 * Gradle manifests, Python/Go/Rust imports, and package-manager commands run through Bash (the
 * hook matcher does not include Bash).
 */
const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.svelte', '.vue']);
const MAX_NAMED = 3;
const MAX_LEVELS_UP = 12;
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '').split('/')[0]!));

type Edit = { old_string?: string; new_string?: string };
const editsOf = (input: HookToolInput): Edit[] => {
  if (Array.isArray(input.edits)) return input.edits;
  if (typeof input.new_string === 'string') return [{ old_string: input.old_string, new_string: input.new_string }];
  return [];
};

function readOrNull(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/** The file before and after the edit. The hook may run before the edit lands (disk is "before") or after it (disk is "after"). */
function beforeAfter(disk: string | null, input: HookToolInput): { before: string; after: string } | null {
  if (typeof input.content === 'string') return { before: disk ?? '', after: input.content };
  const edits = editsOf(input);
  if (disk === null || !edits.length) return null;
  const apply = (text: string, from: 'old_string' | 'new_string', to: 'old_string' | 'new_string'): string | null => {
    let out = text;
    for (const e of edits) {
      const a = e[from] ?? '';
      if (!a || !out.includes(a)) return null;
      out = out.replace(a, () => e[to] ?? '');
    }
    return out;
  };
  // Already landed (a post-edit hook) wins when the edit's new text is on disk: an old string that is a
  // substring of the new one (adding a key beside an existing one) would otherwise read as "not landed".
  const back = apply(disk, 'new_string', 'old_string');
  if (back !== null) return { before: back, after: disk };
  const forward = apply(disk, 'old_string', 'new_string');
  return forward !== null ? { before: disk, after: forward } : null;
}

function depNames(manifestText: string): Set<string> | null {
  try {
    const json = JSON.parse(manifestText) as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of DEP_KEYS) {
      const group = json[key];
      if (group && typeof group === 'object') for (const n of Object.keys(group)) names.add(n);
    }
    return names;
  } catch {
    return null;
  }
}

const IMPORT_RE = /(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s[^'"()]*?\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])([^'"\n]+)\1/g;

/** Bare package names an import or require in `text` points at. */
function importedPackages(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IMPORT_RE)) {
    // `import type` / `export type` are erased at compile time: no runtime dependency.
    if (/^(?:import|export)\s+type\b/.test(m[0])) continue;
    const spec = m[2]!;
    if (/^[./$~#]/.test(spec) || spec.startsWith('@/') || spec.includes(':')) continue;
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    if (!name || (spec.startsWith('@') && parts.length < 2)) continue;
    if (BUILTINS.has(name)) continue;
    out.add(name);
  }
  return [...out];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readOrNull(file) ?? '');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Names of the packages a workspace root declares (`workspaces: ["packages/*", "tools/cli"]`). */
function workspacePackageNames(rootDir: string, json: Record<string, unknown>): string[] {
  const ws = json.workspaces;
  const patterns = Array.isArray(ws) ? ws : ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: unknown[] }).packages : [];
  const dirs: string[] = [];
  for (const p of patterns) {
    if (typeof p !== 'string' || p.includes('..')) continue;
    if (p.endsWith('/*')) {
      try {
        const base = path.join(rootDir, p.slice(0, -2));
        for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) dirs.push(path.join(base, e.name));
      } catch { /* missing workspace folder */ }
    } else if (!p.includes('*')) dirs.push(path.join(rootDir, p));
  }
  return dirs.map((d) => readJson(path.join(d, 'package.json'))?.name).filter((n): n is string => typeof n === 'string');
}

/**
 * Every name the edit may import without adding a dependency: the nearest manifest's deps and name,
 * plus, walking up, any enclosing manifest's (a monorepo hoists shared deps to the root) and the
 * packages its workspaces declare (a sibling workspace package is linked, not installed).
 */
function knownPackages(fromFile: string, cwd: string): { manifest: string; known: Set<string> } | null {
  let dir = path.dirname(path.resolve(cwd, fromFile));
  let manifest: string | null = null;
  const known = new Set<string>();
  for (let i = 0; i < MAX_LEVELS_UP; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      const json = readJson(candidate);
      const deps = depNames(readOrNull(candidate) ?? '');
      if (!json || !deps) return manifest ? { manifest, known } : null;
      manifest ??= candidate;
      for (const n of deps) known.add(n);
      if (typeof json.name === 'string') known.add(json.name);
      for (const n of workspacePackageNames(dir, json)) known.add(n);
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return manifest ? { manifest, known } : null;
}

function sentence(names: string[], manifestPath: string, cwd: string): string {
  const shown = names.slice(0, MAX_NAMED).join(', ');
  const rel = path.relative(cwd, manifestPath);
  return `Add dependency ${shown} to ${rel && !rel.startsWith('..') ? rel : path.basename(manifestPath)}`;
}

/** A sentence describing the dependency this edit adds, or null when it adds none. */
export function dependencyIntentQuery(input: HookToolInput | undefined, cwd: string): string | null {
  try {
    if (!input?.file_path) return null;
    const file = path.resolve(cwd, input.file_path);
    const disk = readOrNull(file);
    const change = beforeAfter(disk, input);
    if (!change) return null;

    if (path.basename(file) === 'package.json') {
      const before = depNames(change.before.trim() ? change.before : '{}');
      const after = depNames(change.after);
      if (!before || !after) return null;
      const added = [...after].filter((n) => !before.has(n));
      return added.length ? sentence(added, file, cwd) : null;
    }

    if (!SOURCE_EXT.has(path.extname(file))) return null;
    const found = knownPackages(file, cwd);
    if (!found) return null;
    const root = path.dirname(found.manifest);
    // A baseUrl import (`src/foo`, `components/x`) names a project folder, not a package.
    const isFolder = (n: string): boolean => !n.startsWith('@') && existsSync(path.join(root, n));
    const already = new Set(importedPackages(change.before));
    const added = importedPackages(change.after).filter((n) => !found.known.has(n) && !already.has(n) && !isFolder(n));
    return added.length ? sentence(added, found.manifest, cwd) : null;
  } catch {
    return null;
  }
}
