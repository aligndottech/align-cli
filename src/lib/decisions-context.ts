/**
 * Render the decisions file Align owns, and the one line that imports it.
 *
 * MECHANISM. Align owns `.align/decisions.md` outright and the user's CLAUDE.md gains a single
 * import line. That satisfies Tom's augment-never-overwrite constraint STRUCTURALLY rather than
 * carefully: nothing here parses a document containing content we did not write, so the worst
 * bug available is a wrong file that holds nothing of theirs.
 *
 * The alternative, splicing a managed block inside CLAUDE.md, needs a marker parser.
 * `fillGeneratedRegions` in align-stack is the one that already has the four guards for that
 * job, and `@align/docs-pipeline` is `private: true` in a different repo, so align-cli cannot
 * import it. A reimplementation would be a second lenient-matcher/strict-builder in the world -
 * the exact bug class those guards close (code-style.md).
 *
 * OPEN CORE. Nothing here selects or ranks anything. Which decisions are current, relevant and
 * unsuperseded is a gateway query; this module formats a list and writes a file, which is
 * plumbing.
 *
 * EXTERNAL STORAGE. A LOCAL graph's content is personal (built with the user's own
 * read-only tokens), so it must never be representable in the git working tree at all - not
 * even gitignored, which is a convention a `git add -f`, an edited line, or a merge dropping it
 * can all bypass silently. `{ external: true }` writes the real bytes to
 * `~/.align/contexts/<hash>/decisions.md` (the same home-directory convention that already
 * holds the saved connector tokens and the local graph DB itself - see private-files.ts) and
 * leaves a SYMLINK at `.align/decisions.md` pointing there. Every existing reader - the
 * CLAUDE.md import, `align context inject`, the gitignore/tracked-by-git checks in
 * commands/context.ts - keeps working completely unchanged, because `fs.readFileSync` and
 * `fs.existsSync` follow a symlink transparently; only the WRITE path needed to change.
 *
 * Symlinks need POSIX semantics Windows does not give an unprivileged process, so on win32 this
 * falls back to the plain in-repo file - today's behaviour, unprotected beyond gitignore, but
 * no worse than before. Best effort by platform, the same shape as every other
 * platform-dependent hardening in private-files.ts.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deciderLabel } from './decider-kind.js';
import { alignConfigDir, ensurePrivateDir, writePrivateFile } from './private-files.js';

export interface ContextDecision {
  title: string;
  /** e.g. `align-stack#1441`. Stable, human-quotable, and the deterministic sort key. */
  cite?: string;
  /** Where it was DECIDED. Never interchangeable with a decision_url into the Align app. */
  sourceUrl?: string;
  /** Who decided, and whether a human has stood behind it. The label built from
   *  these (deciderLabel) is what routes a row into the claims section below, and what gets
   *  printed on its line - this is the one surface where the label has to be IN THE TEXT,
   *  since the file is consumed by agents that only read files. */
  deciderKind?: string | null;
  ratifiedBy?: string | null;
  ratifiedAt?: string | null;
}

export const ALIGN_CONTEXT_PATH = '.align/decisions.md';
export const ALIGN_IMPORT_LINE = `@${ALIGN_CONTEXT_PATH}`;

/**
 * Deterministic order, independent of what the graph happened to return.
 *
 * Without this, a LIMIT with no ORDER BY upstream reorders the block between runs and defeats
 * idempotence without a single decision having changed (tdd.md's fourth shape).
 */
function ordered(decisions: ContextDecision[]): ContextDecision[] {
  return [...decisions].sort((a, b) =>
    (a.cite ?? '').localeCompare(b.cite ?? '') || a.title.localeCompare(b.title),
  );
}

/** The whole point of the split. An unratified agent claim must not render beside
 *  what the rest of the file states as fact - it goes in its own section, so a reader (human
 *  or agent) cannot mistake "said once, by an agent, mid-task" for "decided". */
function isUnratifiedClaim(d: ContextDecision): boolean {
  return deciderLabel({ decider_kind: d.deciderKind, ratified_by: d.ratifiedBy, ratified_at: d.ratifiedAt }) === 'agent-decided, unratified';
}

function line(d: ContextDecision): string {
  const cite = d.cite ? ` (${d.cite})` : '';
  const link = d.sourceUrl ? ` - ${d.sourceUrl}` : '';
  const label = deciderLabel({ decider_kind: d.deciderKind, ratified_by: d.ratifiedBy, ratified_at: d.ratifiedAt });
  const decider = label ? ` [${label}]` : '';
  return `- ${d.title}${cite}${link}${decider}`;
}

/**
 * Render the file. Byte-identical for identical input, which is the acceptance test for the
 * whole feature: a file that differs between runs turns every regeneration into a git diff.
 *
 * NOTE THE ABSENCE OF A TIMESTAMP, which is deliberate and load-bearing. "Generated on <date>"
 * is the obvious header to write and it breaks idempotence a day later. It also passes a naive
 * idempotence test, because two calls inside one test produce the same date - so the no-date
 * assertion is a separate test rather than an implied one.
 */
export function renderDecisionsFile(decisions: ContextDecision[]): string {
  const header = [
    '# Decisions (generated by Align)',
    '',
    'Generated from your decision graph. Edits here are overwritten; this file is owned by',
    '`align`. Re-run the generator to bring it up to date.',
    '',
  ];

  if (decisions.length === 0) {
    // "Nothing found" and "the fetch failed" must not look alike, so say which this is.
    // An empty section reads as a claim that no decisions exist (new surface).
    return `${[...header, 'No decisions have been captured for this repository yet.'].join('\n')}\n`;
  }

  const all = ordered(decisions);
  const claims = all.filter(isUnratifiedClaim);
  const rest = all.filter((d) => !isUnratifiedClaim(d));

  const body = rest.map(line);
  const claimsSection = claims.length
    ? [
        '',
        '## Agent-decided, not yet ratified by a human',
        '',
        "These were said by an agent, not decided by your team - don't treat them as governing until a human runs `align ratify <id>`.",
        '',
        ...claims.map(line),
      ]
    : [];

  return `${[...header, ...body, ...claimsSection].join('\n')}\n`;
}

/** Does this file already import the generated context? */
export function hasImportLine(claudeMd: string): boolean {
  return claudeMd.includes(ALIGN_IMPORT_LINE);
}

/**
 * Append the import line, once.
 *
 * The only write to a file the user owns, and deliberately the dumbest possible one: an append
 * cannot reorder or delete what is already there. It does not parse, so a file that merely
 * mentions align is not mistaken for one that imports it.
 */
export function appendImportLine(claudeMd: string): string {
  if (hasImportLine(claudeMd)) return claudeMd;
  const separator = claudeMd.endsWith('\n') ? '' : '\n';
  return `${claudeMd}${separator}\n${ALIGN_IMPORT_LINE}\n`;
}

export interface WriteResult {
  /** Repo-relative path of the file Align owns. */
  contextPath: string;
  /** True only when this run added the import line, so a caller can say so once. */
  importAdded: boolean;
}

/**
 * Where a LOCAL graph's decisions file lives outside the repo, keyed by the repo's resolved
 * absolute path so two repos (or two worktrees of the same repo) never collide and never share
 * a file. A regenerable cache, not identity-critical data: re-running `align context sync`
 * rebuilds it, so a hash collision or a moved/renamed checkout costs a re-sync, not data loss.
 */
export function externalContextPath(repoRoot: string): string {
  const key = createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 16);
  return path.join(alignConfigDir(), 'contexts', key, 'decisions.md');
}

/**
 * Best effort: write `rendered` to the external per-repo path and leave a symlink at
 * `inRepoTarget` pointing there. Returns false (never throws) on any failure - a read-only
 * filesystem, a POSIX symlink permission denied by an unusual mount, or simply win32, which
 * this does not even attempt - so the caller can fall through to a plain in-repo file exactly
 * as before this option existed.
 */
function tryWriteExternalAndLink(repoRoot: string, inRepoTarget: string, rendered: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    const external = externalContextPath(repoRoot);
    ensurePrivateDir(path.dirname(external));
    writePrivateFile(external, rendered);
    // A prior run (plain file, or an old version's committed copy - the migration case) must
    // not block the symlink: unlink whatever is there first, ENOENT included.
    fs.rmSync(inRepoTarget, { force: true });
    fs.symlinkSync(external, inRepoTarget);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the owned context file, and add the import line to CLAUDE.md if it is there.
 *
 * Deliberately does NOT create CLAUDE.md when the repo has none. Inventing a file the user
 * never had is a different and worse surprise than the one the constraint is about; the caller
 * prints the line instead, the way `align setup` treats MCP config.
 *
 * Idempotent on disk, which is the acceptance test for the whole feature rather than a detail:
 * a file that differs between runs turns every regeneration into a git diff in someone else's
 * repo. The renderer carries no timestamp for exactly this reason.
 *
 * `opts.external`: the local-graph case (see the file header). Every existing caller
 * omits it and gets byte-for-byte the same plain-file behaviour as before this option existed.
 */
export async function writeDecisionsContext(
  repoRoot: string,
  decisions: ContextDecision[],
  opts: { external?: boolean } = {},
): Promise<WriteResult> {
  const target = path.join(repoRoot, ALIGN_CONTEXT_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  const rendered = renderDecisionsFile(decisions);
  const linked = opts.external ? tryWriteExternalAndLink(repoRoot, target, rendered) : false;
  if (!linked) await writeFile(target, rendered, 'utf8');

  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  let importAdded = false;
  try {
    const existing = await readFile(claudePath, 'utf8');
    const updated = appendImportLine(existing);
    // Only touch their file when there is something to change. Rewriting identical bytes
    // still updates mtime and shows up in tooling that watches the file.
    if (updated !== existing) {
      await writeFile(claudePath, updated, 'utf8');
      importAdded = true;
    }
  } catch (err) {
    // ENOENT is the "repo has no CLAUDE.md" case above and is not a failure. Anything else
    // is, and must not be swallowed into a silent success.
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }

  return { contextPath: ALIGN_CONTEXT_PATH, importAdded };
}
