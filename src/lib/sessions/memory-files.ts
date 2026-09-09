/**
 * ALI-810: Claude Code's own auto-memory as a second, already-curated decision source.
 *
 * ALI-808 mines raw transcripts. This reads the notes the harness already decided were worth
 * keeping: `~/.claude/projects/<project>/memory/*.md`, one fact per file, with a `type` in
 * frontmatter. Higher precision per file and far cheaper to parse - no noise filtering, no
 * repeat-loop exclusion, no plan-file resolution.
 *
 * ## What is verified, and what is not
 *
 * There is no captured memory-file fixture, because this environment has no memory directory
 * at all (checked: `find ~/.claude -type d -name memory` is empty while `~/.claude/projects`
 * exists). Under ALI-808's own gate - "the gate is the fixture, not the agent name" - that
 * would normally mean shipping `locate` and refusing to parse, the way `gemini-cli` and
 * `cursor` do.
 *
 * The difference here is that the format is DOCUMENTED by its producer rather than reverse
 * engineered, so the fixtures are built from Anthropic's own published description rather
 * than from a guess (https://code.claude.com/docs/en/memory, read 2026-09-09). Everything
 * this module relies on is quoted from that page:
 *
 *   - the directory is `~/.claude/projects/<project>/memory/`, `<project>` derived from the
 *     git repository, so all worktrees and subdirectories of one repo share it;
 *   - it holds a `MEMORY.md` index plus one topic file per memory, with arbitrary names;
 *   - Claude records the kind in a `type` frontmatter field with exactly four values:
 *     `user`, `feedback`, `project`, `reference`;
 *   - a `modified` frontmatter field carries an ISO-8601 write time;
 *   - "Claude Code never adds frontmatter to a file that has none", so a memory file may
 *     legitimately carry no frontmatter at all;
 *   - `autoMemoryDirectory` in settings.json relocates the directory.
 *
 * **The ALI-810 ticket also names `description` and `originSessionId` frontmatter fields.
 * The documentation describes neither.** They may well exist - the ticket was written from a
 * real machine and this one has no memory directory to check - but nothing here depends on
 * them, because a field this module cannot confirm is a field it must not require. If they
 * turn out to be real, `parseMemoryFile` already returns them under `extra` and a follow-up
 * can promote them without touching any caller.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { findFilesRecursive, sortByMtimeDesc } from './fs-scan.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';

/** The four kinds Claude Code records, verbatim from the documentation. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * The two kinds that are decision-shaped.
 *
 * `project` is "ongoing work, deadlines, and decisions that Claude can't derive from the code
 * or git history" and `feedback` is "corrections you give Claude and approaches you confirm" -
 * both are things somebody decided. `user` is a person's role and working preferences, and
 * `reference` is where to find a dashboard. Neither is a decision, and importing them would
 * put personal notes into a decision graph.
 */
export const DECISION_MEMORY_TYPES: readonly MemoryType[] = ['project', 'feedback'];

/** The index file, never a memory in its own right. */
export const MEMORY_INDEX_FILENAME = 'MEMORY.md';

export interface MemoryFile {
  filePath: string;
  /** Null when the file carries no frontmatter, or carries frontmatter with no `type`, or a
   *  `type` outside the four documented values. All three are "cannot classify", which is a
   *  different fact from "classified as something we skip" - see extractMemoryDecisions. */
  type: MemoryType | null;
  /** ISO-8601 from the `modified` field, or null when absent (the field only appears on files
   *  Claude has written since v2.1.214, and never on a file that has no frontmatter). */
  modified: string | null;
  /** Every other scalar frontmatter key, unparsed. Nothing depends on these; they exist so a
   *  later ticket can confirm `description`/`originSessionId` from real data without a reparse. */
  extra: Record<string, string>;
  /** The markdown below the frontmatter, trimmed. */
  body: string;
}

export interface MemoryDecisionCandidate {
  filePath: string;
  type: MemoryType;
  /** The file's first markdown heading, else its filename stem with separators as spaces. */
  title: string;
  body: string;
  /** ISO-8601 or null, from `modified`. */
  timestamp: string | null;
  /** The memory directory this file came from, used to build a stable source_url. */
  memoryDir: string;
}

/**
 * Where this project's memory directory is, if anywhere.
 *
 * Resolution order, and the reason for it:
 *
 * 1. `autoMemoryDirectory` from `~/.claude/settings.json`. Reading it matters because the
 *    failure direction without it is silent: a user who relocated the directory would get an
 *    empty list, which is indistinguishable from "no memories yet".
 * 2. Otherwise, the `memory/` sibling of this project's Claude Code session files. The docs
 *    say `<project>` is derived from the git repository, and the exact slug encoding is not
 *    documented - so rather than guess at it, this reuses the cwd matching ALI-808 already
 *    proved (each session file records its own `cwd`) and takes the directory those files
 *    sit in. That is correct for worktrees and subdirectories for free, because they share
 *    one project directory.
 *
 * Returns [] when the agent has never run here, which is the normal case and not an error.
 */
export function locateMemoryDirs(cwd: string): string[] {
  const configured = readAutoMemoryDirectory();
  if (configured) return [configured];

  const sessionFiles = claudeCodeAdapter.locateSessionFiles(cwd);
  const dirs = new Set<string>();
  for (const file of sessionFiles) dirs.add(join(dirname(file), 'memory'));
  return [...dirs];
}

/** Memory topic files for this project, newest first. `MEMORY.md` is excluded: it is an index
 *  of the others, so importing it would duplicate every memory as one more candidate. */
export function locateMemoryFiles(cwd: string): string[] {
  const found: string[] = [];
  for (const dir of locateMemoryDirs(cwd)) {
    for (const file of findFilesRecursive(dir, /\.md$/)) {
      if (basename(file) !== MEMORY_INDEX_FILENAME) found.push(file);
    }
  }
  return sortByMtimeDesc(found);
}

function readAutoMemoryDirectory(): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A settings file we cannot parse is not ours to repair, and guessing past it would be
    // worse than falling back to the documented default location.
    return null;
  }
  const value = (parsed as Record<string, unknown> | null)?.['autoMemoryDirectory'];
  if (typeof value !== 'string' || value.length === 0) return null;
  // Documented constraint: "must be an absolute path or start with ~/".
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Parses one memory file.
 *
 * The frontmatter reader deliberately handles only `key: value` scalars on one line, which is
 * every field the documentation describes. Anything else - a nested map, a list, a block
 * scalar - is left in `extra` as its raw text if it is a simple scalar and otherwise ignored,
 * rather than half-understood. js-yaml is a devDependency here, not a runtime one, so pulling
 * a YAML parser into shipped CLI code would be a new dependency for two scalar fields.
 *
 * Returns null only for an unreadable file.
 */
export function parseMemoryFile(filePath: string): MemoryFile | null {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const { frontmatter, body } = splitFrontmatter(text);
  const rawType = frontmatter['type'];
  const type = isMemoryType(rawType) ? rawType : null;
  const modified = frontmatter['modified'] ?? null;

  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (k !== 'type' && k !== 'modified') extra[k] = v;
  }

  return { filePath, type, modified, extra, body };
}

function isMemoryType(value: string | undefined): value is MemoryType {
  return value !== undefined && (MEMORY_TYPES as readonly string[]).includes(value);
}

/**
 * Splits `---\n...\n---\n` off the front. A file with no frontmatter is the documented normal
 * case, not a malformed one, so it yields an empty map and the whole text as the body.
 */
function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { frontmatter: {}, body: normalized.trim() };

  const end = normalized.indexOf('\n---', 3);
  if (end === -1) {
    // An opening fence with no closing one is not frontmatter. Treating the rest of the file
    // as key/value would silently swallow the content.
    return { frontmatter: {}, body: normalized.trim() };
  }

  const block = normalized.slice(4, end);
  const after = normalized.slice(end + 4);
  const frontmatter: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key || !value) continue;
    // Strip one layer of matching quotes, which is how an ISO timestamp is often written.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: after.trim() };
}

/** First markdown heading, else the filename stem with `_`/`-` as spaces. */
function titleFor(file: MemoryFile): string {
  const heading = file.body.split('\n').find(l => /^#{1,6}\s+\S/.test(l));
  if (heading) return heading.replace(/^#{1,6}\s+/, '').trim();
  return basename(file.filePath).replace(/\.md$/, '').replace(/[_-]+/g, ' ').trim();
}

/**
 * The decision-shaped memories among these files.
 *
 * Three separate reasons a file is dropped, all deliberate:
 *   - `type` is `user` or `reference`: classified, and not a decision.
 *   - `type` is absent or unrecognised: NOT classified. Importing it would be a guess about
 *     personal notes, so it is skipped rather than defaulted into a decision.
 *   - the body is empty: nothing to review.
 */
export function extractMemoryDecisions(filePaths: string[]): MemoryDecisionCandidate[] {
  const candidates: MemoryDecisionCandidate[] = [];
  for (const filePath of filePaths) {
    const parsed = parseMemoryFile(filePath);
    if (!parsed) continue;
    // This null check is RUNTIME-REDUNDANT and kept deliberately. Replacing it with a no-op
    // leaves every test green, because DECISION_MEMORY_TYPES cannot contain null so the next
    // line drops an unclassified file anyway. Deleting it does NOT leave the suite green:
    // `tsc` then reports TS2345 and TS2322, because the narrowing to MemoryType is what lets
    // the next line and the push below compile. The enforcing mechanism is the compiler
    // rather than a test, which is the honest reason it survives a mutation run - so do not
    // remove it as dead code.
    if (parsed.type === null) continue;
    if (!DECISION_MEMORY_TYPES.includes(parsed.type)) continue;
    if (parsed.body.length === 0) continue;
    candidates.push({
      filePath,
      type: parsed.type,
      title: titleFor(parsed),
      body: parsed.body,
      timestamp: parsed.modified,
      memoryDir: dirname(filePath),
    });
  }
  return candidates;
}
