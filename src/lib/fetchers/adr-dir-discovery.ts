import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * ADR directories found by NAME anywhere in the tree, for repos that keep them outside the
 * ADR_DIR_CANDIDATES list (adda/DECISIONS, .specs/project/ADRs, knowledge/decisions ...).
 *
 * A directory counts when its name is one of ADR_DIR_NAMES (case-insensitive) AND it holds at
 * least MIN_RECORDS record-shaped markdown files: a leading number or date, never README,
 * template or index. The second test is what keeps a `decisions/` folder of meeting notes out.
 *
 * The walk is bounded (depth, directories visited, discovered dirs) and skips vendored and
 * build directories plus the simple patterns of the root .gitignore. It is a plain fs walk, not
 * `git ls-files`, because the docs fetcher is credential- and git-free by design.
 */
export const ADR_DIR_NAMES = new Set([
  'adr', 'adrs', 'decisions', 'decision', 'decision-records', 'decision-log', 'architecture-decisions',
]);
export const MAX_DISCOVERED_DIRS = 5;
const MIN_RECORDS = 2;
const MAX_DEPTH = 6;
const MAX_VISITED = 4000;
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '.git', '.hg', '.svn', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.cache', '.idea', '.gradle', 'bower_components', 'third_party',
]);
const DOC_FILE = /\.(mdx?|adoc|asciidoc)$/i;
const RECORD_NAME = /^(?:adr[-_ ]?)?\d{1,5}[-_.]|^\d{4}-\d{2}-\d{2}/i;
const NOT_RECORD = /^(?:readme|template|index)\b|[-_]template\b/i;

/** `x/y` is anchored to the root, `x` matches a directory of that name anywhere; `*` matches within one segment. */
function gitignoreMatchers(content: string): Array<(rel: string, name: string) => boolean> {
  const out: Array<(rel: string, name: string) => boolean> = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const anchored = line.replace(/\/+$/, '').includes('/');
    const body = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!body) continue;
    const re = new RegExp(`^${body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\uE000').replace(/\*/g, '[^/]*').replace(/\uE000/g, '.*').replace(/\?/g, '[^/]')}$`);
    out.push(anchored ? (rel) => re.test(rel) : (_rel, name) => re.test(name));
  }
  return out;
}

export function isRecordName(name: string): boolean {
  return DOC_FILE.test(name) && RECORD_NAME.test(name) && !NOT_RECORD.test(name);
}

export interface DiscoveredAdrDirs {
  /** Repo-relative, forward slashes, sorted; at most MAX_DISCOVERED_DIRS. */
  dirs: string[];
  /** Qualifying directories beyond the cap, left unread. */
  omitted: string[];
}

/** `seenReal` holds real paths of directories already read (the candidate list); they are not returned again. */
export async function discoverAdrDirs(repoRoot: string, seenReal: ReadonlySet<string>): Promise<DiscoveredAdrDirs> {
  const ignore = gitignoreMatchers(await readFile(path.join(repoRoot, '.gitignore'), 'utf8').catch(() => ''));
  const found: string[] = [];
  const foundReal = new Set<string>();
  let visited = 0;
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  while (queue.length > 0 && visited < MAX_VISITED) {
    const { rel, depth } = queue.shift()!;
    visited++;
    let entries;
    try {
      entries = await readdir(path.join(repoRoot, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (rel && ADR_DIR_NAMES.has(path.posix.basename(rel).toLowerCase())) {
      const records = entries.filter((e) => e.isFile() && isRecordName(e.name)).length;
      if (records >= MIN_RECORDS) {
        const real = await realpath(path.join(repoRoot, rel)).catch(() => null);
        if (real !== null && !seenReal.has(real) && !foundReal.has(real)) {
          foundReal.add(real);
          found.push(rel);
        }
        continue; // an ADR directory is a leaf: do not look for ADR directories inside it
      }
    }
    if (depth >= MAX_DEPTH) continue;
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue; // symlinked dirs are not followed
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (ignore.some((m) => m(childRel, e.name))) continue;
      queue.push({ rel: childRel, depth: depth + 1 });
    }
  }
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { dirs: found.slice(0, MAX_DISCOVERED_DIRS), omitted: found.slice(MAX_DISCOVERED_DIRS) };
}
