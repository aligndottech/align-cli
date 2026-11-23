import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * ADR directories found by NAME anywhere in the tree, for repos that keep them outside the
 * ADR_DIR_CANDIDATES list (adda/DECISIONS, .specs/project/ADRs, knowledge/decisions ...).
 *
 * A directory counts when its name is one of ADR_DIR_NAMES (case-insensitive) AND it holds at
 * least MIN_RECORDS record-shaped markdown files: a leading number or date in the name, never
 * README, template or index, AND record-like content (a Decision heading or label plus one of
 * Status, Context, Consequences or Date in the first 40 lines). The last two tests keep a
 * `decisions/` folder of meeting notes or dated standups out.
 *
 * Principle: a wrongly skipped dir is a visible, explainable gap; a wrongly imported junk dir is
 * noise in a team's decision graph. So the filters lean conservative, and every limit that cut
 * the scan (cap, visited, depth, unreadable files) is returned so the caller can say so.
 *
 * The walk is bounded (depth, directories visited, discovered dirs) and skips vendored, build,
 * test-fixture and dot directories plus the simple patterns of the ROOT .gitignore. Nested
 * .gitignore files are NOT read. It is a plain fs walk, not `git ls-files`, because the docs
 * fetcher is credential- and git-free by design.
 */
export const ADR_DIR_NAMES = new Set([
  'adr', 'adrs', 'decisions', 'decision', 'decision-records', 'decision-log', 'architecture-decisions',
]);
export const MAX_DISCOVERED_DIRS = 5;
const MIN_RECORDS = 2;
const MAX_DEPTH = 6;
const MAX_VISITED = 4000;
/** Compared lower-cased. Any dot-directory is also skipped unless listed in DOT_DIRS_ALLOWED. */
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', 'venv', '__pycache__',
  'bower_components', 'third_party', 'pods', 'site', 'public', 'tmp',
  'test', 'tests', '__tests__', 'fixtures', 'fixture', 'examples', 'testdata',
]);
/** The only dot-directories that legitimately hold ADRs. Every other one (.claude worktree copies,
 *  .svelte-kit, .turbo, .output, .angular, .terraform, .cache ...) is generated or foreign. */
const DOT_DIRS_ALLOWED = new Set(['.specs', '.agents']);
const HEAD_LINES = 40;
const LABEL = /^\s*(?:#{1,6}\s*|[*_]{1,2}|[-*+]\s+)?(decision|status|context|consequences|date)\b/i;
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
    let body = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!body) continue;
    // A leading `**/` means "in any directory, including the root", so it may match zero segments.
    let prefix = '';
    if (body.startsWith('**/')) {
      prefix = '(?:.*/)?';
      body = body.slice(3);
      if (!body) continue;
    }
    const re = new RegExp(`^${prefix}${body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\uE000').replace(/\*/g, '[^/]*').replace(/\uE000/g, '.*').replace(/\?/g, '[^/]')}$`);
    out.push(anchored ? (rel) => re.test(rel) : (_rel, name) => re.test(name));
  }
  return out;
}

export function isRecordName(name: string): boolean {
  return DOC_FILE.test(name) && RECORD_NAME.test(name) && !NOT_RECORD.test(name);
}

/** Record-like content: a Decision heading or label plus one of Status, Context, Consequences or Date, in the first lines. */
export function hasRecordContent(content: string): boolean {
  const found = new Set<string>();
  for (const line of content.split('\n').slice(0, HEAD_LINES)) {
    const m = LABEL.exec(line);
    if (m) found.add(m[1].toLowerCase());
  }
  return found.has('decision') && found.size >= 2;
}

export interface DiscoveredAdrDirs {
  /** Repo-relative, forward slashes, ranked by depth then path; at most MAX_DISCOVERED_DIRS. */
  dirs: string[];
  /** Qualifying directories beyond the cap, left unread. */
  omitted: string[];
  /** Set when MAX_VISITED stopped the walk: how many directories had been visited. */
  stoppedAtVisited?: number;
  /** Set when directories below MAX_DEPTH were left unscanned. */
  depthLimited: boolean;
}

const depthOf = (rel: string): number => rel.split('/').length;

/**
 * `seenReal` holds real paths of directories already read (the candidate list); they are not returned again.
 * `unreadable` collects repo-relative paths of record-named files that could not be read; they are skipped.
 */
export async function discoverAdrDirs(
  repoRoot: string,
  seenReal: ReadonlySet<string>,
  unreadable: Set<string> = new Set(),
): Promise<DiscoveredAdrDirs> {
  const ignore = gitignoreMatchers(await readFile(path.join(repoRoot, '.gitignore'), 'utf8').catch(() => ''));
  const found: string[] = [];
  const foundReal = new Set<string>();
  let visited = 0;
  let depthLimited = false;
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
      const names = entries.filter((e) => e.isFile() && isRecordName(e.name)).map((e) => e.name);
      let records = 0;
      for (const name of names) {
        if (records >= MIN_RECORDS) break;
        try {
          const content = await readFile(path.join(repoRoot, rel, name), 'utf8');
          if (hasRecordContent(content)) records++;
        } catch {
          unreadable.add(`${rel}/${name}`);
        }
      }
      if (records >= MIN_RECORDS) {
        const real = await realpath(path.join(repoRoot, rel)).catch(() => null);
        if (real !== null && !seenReal.has(real) && !foundReal.has(real)) {
          foundReal.add(real);
          found.push(rel);
        }
        continue; // an ADR directory is a leaf: do not look for ADR directories inside it
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue; // symlinked dirs are not followed
      const lower = e.name.toLowerCase();
      if (SKIP_DIRS.has(lower) || (lower.startsWith('.') && !DOT_DIRS_ALLOWED.has(lower))) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (ignore.some((m) => m(childRel, e.name))) continue;
      if (depth >= MAX_DEPTH) {
        depthLimited = true;
        continue;
      }
      queue.push({ rel: childRel, depth: depth + 1 });
    }
  }
  found.sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0));
  return {
    dirs: found.slice(0, MAX_DISCOVERED_DIRS),
    omitted: found.slice(MAX_DISCOVERED_DIRS),
    ...(queue.length > 0 ? { stoppedAtVisited: visited } : {}),
    depthLimited,
  };
}
