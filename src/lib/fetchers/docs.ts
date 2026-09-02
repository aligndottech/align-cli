import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildBlobUrl, getCurrentBranch, getRemoteUrl } from '../git.js';
import { ALIGN_NUDGE_END, ALIGN_NUDGE_START } from '../agent-rules.js';
import { ALIGN_IMPORT_LINE } from '../decisions-context.js';
import type { PersonalImportItem } from '../personal-import.js';
import type { CaptureFetchResult } from './capture.js';

/**
 * ALI-793: read what the repo already wrote down, credential-free. Two sources:
 *
 *  - ADR directories, the common naming conventions. ADRs are decision-shaped by
 *    construction (title, status, context, decision) - highest precision, lowest
 *    ambiguity, so this is the source worth building the reader for first.
 *  - CLAUDE.md / AGENTS.md content the user wrote themselves, minus the block and
 *    import line Align itself put there (align-cli#116: Align owns `.align/`
 *    outright and must never re-ingest its own output - that is a feedback loop).
 *
 * Both are filed under platform: 'docs', a value distinct from 'git'. ALI-804 measured
 * a git-only import at 1,484 rows of "what changed and almost no why"; an ADR is exactly
 * the "why" a commit subject cannot carry, and collapsing the two under one platform
 * would destroy the only cheap way to select on that distinction later.
 *
 * NO RELATIONSHIP MACHINERY HERE. An ADR marked "Superseded by 0007-xyz.md" is a
 * supersession edge, but the code path that finds it is the SAME LLM relationship
 * analysis every other ingested item already goes through (POST /ingest/batch ->
 * brain synthesis) - so the whole job here is to not throw that status line away.
 * Nothing is parsed or interpreted beyond title/heading extraction.
 */

/** ADR directory conventions, checked in this order; EVERY one that exists is scanned -
 *  a repo can legitimately carry more than one (a migration between conventions, or
 *  doc/adr and docs/decisions covering different eras of the same project). */
const ADR_DIR_CANDIDATES = ['docs/adr', 'doc/adr', 'docs/decisions', 'doc/decisions', 'adr'];

/** Root-level only, matching the two write-only surfaces ALI-793 names. Nested
 *  per-package CLAUDE.md/AGENTS.md files are a real convention in this repo's own
 *  monorepo, but scoping to root for the first cut keeps the read side of the two
 *  files the CLI already knows how to write. */
const AGENT_RULES_FILES = ['CLAUDE.md', 'AGENTS.md'];

/** Below this many characters a chunk is a bare heading or a one-line pointer, not a
 *  decision - the prose equivalent of git.ts's isDecisionCommit length filter. */
const MIN_CHUNK_CHARS = 20;

function humanizeFilename(file: string): string {
  return path
    .basename(file, path.extname(file))
    .replace(/^\d+[-_]?/, '') // ADR numeric prefixes: 0007-use-cockroachdb.md
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function firstHeading(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

async function readAdrFiles(repoRoot: string): Promise<Array<{ relPath: string; content: string }>> {
  const out: Array<{ relPath: string; content: string }> = [];
  for (const dir of ADR_DIR_CANDIDATES) {
    let entries;
    try {
      entries = await readdir(path.join(repoRoot, dir), { withFileTypes: true });
    } catch {
      continue; // convention not used in this repo - not an error
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.mdx?$/i.test(entry.name)) continue;
      const relPath = `${dir}/${entry.name}`;
      const content = await readFile(path.join(repoRoot, dir, entry.name), 'utf8');
      out.push({ relPath, content });
    }
  }
  // readdir order is not guaranteed sorted or stable across platforms, and it decides which
  // ADRs survive `limit` when there are more than it allows - sort so that choice is the same
  // on every run rather than whatever the filesystem happened to hand back.
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

function adrItem(relPath: string, content: string, remoteUrl: string | null, branch: string): PersonalImportItem {
  return {
    source_url: buildBlobUrl(remoteUrl, branch, relPath),
    platform: 'docs',
    raw_text: content,
    title: firstHeading(content) ?? humanizeFilename(relPath),
  };
}

/**
 * Strip Align's own managed nudge block (the exact marker pair `writeManagedNudge` in
 * agent-rules.ts uses) and the `.align/decisions.md` import line `appendImportLine` in
 * decisions-context.ts appends. Reuses both modules' exported constants rather than
 * re-spelling the marker text here, so a future change to either writer can't silently
 * desync from what this reader strips (code-style.md, two writers/readers of one fact).
 */
function stripAlignOwnedContent(content: string): string {
  let out = content;
  const start = out.indexOf(ALIGN_NUDGE_START);
  const end = out.indexOf(ALIGN_NUDGE_END);
  if (start !== -1 && end !== -1 && end > start) {
    out = out.slice(0, start) + out.slice(end + ALIGN_NUDGE_END.length);
  }
  out = out
    .split('\n')
    .filter((line) => line.trim() !== ALIGN_IMPORT_LINE)
    .join('\n');
  return out;
}

/** Split on H2 (`## `) boundaries. Content before the first H2 (an H1 title, an intro
 *  paragraph) is its own headingless section, so a file with no H2s still yields one
 *  chunk instead of zero. */
function splitIntoSections(content: string): Array<{ heading: string | null; body: string }> {
  const sections: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  for (const line of content.split('\n')) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) sections.push({ heading: h2[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections.map((s) => ({ heading: s.heading, body: s.lines.join('\n').trim() }));
}

async function readAgentRulesItems(
  repoRoot: string,
  remoteUrl: string | null,
  branch: string,
): Promise<{ items: PersonalImportItem[]; droppedShort: number }> {
  const items: PersonalImportItem[] = [];
  // ALI-827: headed sections the length floor dropped, so the capture report can name
  // them. The headingless preamble (an H1 line, an intro sentence) is not counted when it
  // is dropped: nobody wrote it as a section, so nobody will look for it in the graph.
  let droppedShort = 0;
  for (const file of AGENT_RULES_FILES) {
    let raw: string;
    try {
      raw = await readFile(path.join(repoRoot, file), 'utf8');
    } catch {
      continue; // file not present in this repo - not an error
    }
    const stripped = stripAlignOwnedContent(raw);
    // Two `## Section` with the same text (a Database section under both a gateway and a
    // brain heading, say) would otherwise slugify to the same anchor and collide on
    // source_url, which is the dedup/identity key downstream - one of the two would be
    // silently dropped rather than imported.
    const seenSlugs = new Map<string, number>();
    for (const section of splitIntoSections(stripped)) {
      if (section.body.length < MIN_CHUNK_CHARS) {
        if (section.heading) droppedShort++;
        continue;
      }
      const title = section.heading ?? firstHeading(section.body) ?? humanizeFilename(file);
      let anchor = '';
      if (section.heading) {
        const slug = slugify(section.heading);
        const seen = seenSlugs.get(slug) ?? 0;
        seenSlugs.set(slug, seen + 1);
        anchor = `#${slug}${seen > 0 ? `-${seen + 1}` : ''}`;
      }
      items.push({
        source_url: `${buildBlobUrl(remoteUrl, branch, file)}${anchor}`,
        platform: 'docs',
        raw_text: section.body,
        title,
      });
    }
  }
  return { items, droppedShort };
}

async function readDocsItems(opts: { limit: number; cwd?: string }): Promise<{
  items: PersonalImportItem[];
  /** Every ADR file and every headed section seen, kept or dropped. */
  scanned: number;
  /** Whether the limit left something unread or unreturned. */
  capped: boolean;
  droppedShort: number;
}> {
  const repoRoot = opts.cwd ?? process.cwd();
  const gitOpts = opts.cwd ? { cwd: opts.cwd } : undefined;
  const [remoteUrl, branch, adrFiles] = await Promise.all([
    getRemoteUrl(gitOpts),
    getCurrentBranch(gitOpts).catch(() => 'main'),
    readAdrFiles(repoRoot),
  ]);

  const adrItems = adrFiles
    .slice(0, opts.limit)
    .map(({ relPath, content }) => adrItem(relPath, content, remoteUrl, branch));

  // ADRs alone already fill the limit: reading and stripping CLAUDE.md/AGENTS.md would be
  // work whose result gets sliced away, so skip it rather than doing it and throwing it out.
  const remaining = opts.limit - adrItems.length;
  // Capped even at exact equality: the agent-rules files were never opened BECAUSE the
  // limit was already full, so something may have been left out and nobody counted it.
  if (remaining <= 0) return { items: adrItems, scanned: adrFiles.length, capped: true, droppedShort: 0 };

  const { items: agentRulesItems, droppedShort } = await readAgentRulesItems(repoRoot, remoteUrl, branch);
  const candidates = adrFiles.length + agentRulesItems.length;
  return {
    items: [...adrItems, ...agentRulesItems].slice(0, opts.limit),
    scanned: candidates + droppedShort,
    // Strictly more than the limit: everything was read, so the cap bound the read only
    // if the slice actually cut something.
    capped: candidates > opts.limit,
    droppedShort,
  };
}

/**
 * ALI-827: the same read, plus its capture report. A local read has no page size to fall
 * off and no access to lack, so the one thing it drops is a headed section under the
 * length floor, and that is the one skip it reports. `scanned` is every ADR file and
 * headed section seen; the cap is echoed only when it bounded the read - "8 ADRs and
 * sections of up to 500 requested" on every run says nothing (the same rule as
 * gitCaptureReport). When it did bind, fetched equals the cap and the renderer prints no
 * clause: the user got what they asked for, and how many more exist is unknown when the
 * ADRs alone fill the limit, so no count is invented for it.
 */
export async function fetchDocsItems(opts: { limit: number; cwd?: string }): Promise<CaptureFetchResult> {
  const { items, scanned, capped, droppedShort } = await readDocsItems(opts);
  return {
    items,
    report: {
      scanned,
      ...(capped ? { requested: opts.limit } : {}),
      skips: droppedShort > 0
        ? [{ count: droppedShort, detail: `sections under ${MIN_CHUNK_CHARS} characters (a bare heading or a one-line pointer)` }]
        : [],
    },
  };
}
