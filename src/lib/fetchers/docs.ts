import { stripLeadingHtmlComments } from './strip-leading-comments.js';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { buildBlobUrl, getCurrentBranch, getRemoteUrl } from '../git.js';
import { adrDecisionDate, GIT_CONCURRENCY, isShallowRepo, mapLimit } from './adr-date.js';
import { ALIGN_NUDGE_END, ALIGN_NUDGE_START } from '../agent-rules.js';
import { ALIGN_IMPORT_LINE, isGeneratedDecisionsFile } from '../decisions-context.js';
import type { PersonalImportItem } from '../personal-import.js';
import type { CaptureFetchResult } from './capture.js';
import type { CoChangeRule } from '../co-change-rule.js';
import {
  CHANGELOG_FILES, CONTRIBUTING_FILES, type DocKind, inferCoChangeRule, isRuleSection, isVersionedReleaseHeading, README_FILES, sectionBody,
} from './docs-conventions.js';
import { discoverAdrDirs, loadRootIgnore } from './adr-dir-discovery.js';
import { createHash } from 'node:crypto';
import { splitRuleList } from './docs-rule-list.js';
import { entryDate, findDecisionLogFiles, readLogFile, splitDecisionLog } from './docs-decision-log.js';

/**
 * Read what the repo already wrote down, credential-free. Four sources:
 *
 *  - ADR directories, the common naming conventions. ADRs are decision-shaped by
 *    construction (title, status, context, decision) - highest precision, lowest
 *    ambiguity, so this is the source worth building the reader for first.
 *  - CLAUDE.md / AGENTS.md / tenets / architecture doc content the user wrote themselves, minus the block and
 *    import line Align itself put there (align-cli#116: Align owns `.align/`
 *    outright and must never re-ingest its own output - that is a feedback loop).
 *  - Decision log files (DECISIONS.md, a ledger), one item per entry (docs-decision-log.ts).
 *  - The rule-bearing sections of README.md, CONTRIBUTING.md and the changelog's policy
 *    sections (docs-conventions.ts). Never a changelog's release entries: those are history.
 *
 * All are filed under platform: 'docs', a value distinct from 'git'. a measurement of
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
export const ADR_DIR_CANDIDATES = [
  'docs/adr', 'doc/adr', 'docs/decisions', 'doc/decisions', 'adr',
  'docs/adrs', 'src/docs/adrs', 'src/docs/adr', 'docs/architecture/adr', 'docs/architecture/decisions', 'docs/architecture-decisions',
  // RFC folders: one decision per file, dated like an ADR.
  'docs/rfcs', 'docs/rfc', 'rfcs', 'rfc',
];

/** Root-level only, matching the two write-only surfaces it names. Nested
 *  per-package CLAUDE.md/AGENTS.md files are a real convention in this repo's own
 *  monorepo, but scoping to root for the first cut keeps the read side of the two
 *  files the CLI already knows how to write. */
const AGENT_RULES_FILES = [
  'CLAUDE.md', 'AGENTS.md',
  // Rule documents, read per `##` section like CLAUDE.md (they state rules to follow, not one decision).
  'tenets.md', 'TENETS.md', 'docs/tenets.md', 'docs/TENETS.md',
  'architecture.md', 'ARCHITECTURE.md', 'docs/architecture.md', 'docs/ARCHITECTURE.md',
  // code-conductor's committed team memory: one `##` section per checkpoint, holding decisions and conventions.
  '.claude/memory/project.md',
];

/** Files whose untitled opening is the tool's own boilerplate ("Shared team memory..."), never a decision. */
const NO_PREAMBLE = new Set(['.claude/memory/project.md']);

/** A section's text without HTML comments. A template section holding only `<!-- ... -->` is empty, not a decision. */
function withoutComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/** Below this many characters a chunk is a bare heading or a one-line pointer, not a
 *  decision - the prose equivalent of git.ts's isDecisionCommit length filter. */
const MIN_CHUNK_CHARS = 20;

export function humanizeFilename(file: string): string {
  return path
    .basename(file, path.extname(file))
    .replace(/^\d+[-_]?/, '') // ADR numeric prefixes: 0007-use-cockroachdb.md
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function firstHeading(content: string): string | null {
  // `# Title` (Markdown) or `= Title` (AsciiDoc: a single `=`, never a `==` section).
  const m = content.match(/^(?:#|=)\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

type AdrFile = { relPath: string; content: string; discoveredDir?: string };

async function readAdrDirs(
  repoRoot: string,
  dirs: readonly string[],
  seen: Set<string>,
  out: AdrFile[],
  unreadable: Set<string>,
  discovered = false,
  isIgnored: (rel: string, name: string) => boolean = () => false,
): Promise<void> {
  for (const dir of dirs) {
    let entries;
    try {
      const real = await realpath(path.join(repoRoot, dir));
      if (seen.has(real)) continue;
      seen.add(real);
      entries = await readdir(path.join(repoRoot, dir), { withFileTypes: true });
    } catch {
      continue; // convention not used in this repo - not an error
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(mdx?|adoc|asciidoc)$/i.test(entry.name)) continue;
      const relPath = `${dir}/${entry.name}`;
      if (discovered && isIgnored(relPath, entry.name)) continue; // root .gitignore applies to discovered dirs only
      try {
        const content = await readFile(path.join(repoRoot, dir, entry.name), 'utf8');
        // `--out docs/decisions/x.md` lands here: Align's own output is not an ADR.
        if (isGeneratedDecisionsFile(content)) continue;
        out.push({ relPath, content, ...(discovered ? { discoveredDir: dir } : {}) });
      } catch {
        unreadable.add(relPath); // one unreadable file must not stop the import
      }
    }
  }
}

interface AdrRead {
  /** Candidate-list files first (sorted), then discovered dirs in rank order. NOT yet sliced to the limit. */
  files: AdrFile[];
  discoveredDirs: string[];
  omittedDirs: string[];
  unreadable: number;
  stoppedAtVisited?: number;
  depthLimited: boolean;
}

async function readAdrFiles(repoRoot: string): Promise<AdrRead> {
  const candidates: AdrFile[] = [];
  const found: AdrFile[] = [];
  const unreadable = new Set<string>();
  const seen = new Set<string>(); // real paths already scanned: a symlinked dir must not import twice
  await readAdrDirs(repoRoot, ADR_DIR_CANDIDATES, seen, candidates, unreadable);
  // Then any ADR-named directory elsewhere in the tree. `seen` keeps a dir from being read twice.
  const disc = await discoverAdrDirs(repoRoot, seen, unreadable);
  await readAdrDirs(repoRoot, disc.dirs, seen, found, unreadable, true, await loadRootIgnore(repoRoot));
  // readdir order is not guaranteed sorted or stable across platforms, and it decides which
  // ADRs survive `limit` when there are more than it allows - sort so that choice is the same
  // on every run. Candidates keep their own order and always come before discovered files, so
  // a repo on the candidate list is unchanged by discovery; discovered files keep rank order.
  candidates.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return {
    files: [...candidates, ...found],
    discoveredDirs: disc.dirs,
    omittedDirs: disc.omitted,
    unreadable: unreadable.size,
    ...(disc.stoppedAtVisited !== undefined ? { stoppedAtVisited: disc.stoppedAtVisited } : {}),
    depthLimited: disc.depthLimited,
  };
}

/** The scope note, built from what the import actually did: only discovered dirs that
 *  contributed items after the limit slice are named as read. */
function adrScopeNote(read: AdrRead, kept: readonly AdrFile[]): string | undefined {
  const contributed = new Set(kept.map((f) => f.discoveredDir).filter((d): d is string => d !== undefined));
  const readDirs = read.discoveredDirs.filter((d) => contributed.has(d));
  const cut = read.discoveredDirs.filter((d) => !contributed.has(d));
  const parts: string[] = [];
  if (readDirs.length > 0) {
    parts.push(`ADRs from directories found by name: ${readDirs.join(', ')}${read.omittedDirs.length > 0 ? ` (${read.omittedDirs.length} more not read, cap ${read.discoveredDirs.length}: ${read.omittedDirs.join(', ')})` : ''}`);
  } else if (read.omittedDirs.length > 0) {
    parts.push(`${read.omittedDirs.length} ADR directories found by name not read, cap ${read.discoveredDirs.length}: ${read.omittedDirs.join(', ')}`);
  }
  if (cut.length > 0) parts.push(`found by name but cut by the limit: ${cut.join(', ')}`);
  if (read.unreadable > 0) parts.push(`${read.unreadable} unreadable ADR file${read.unreadable === 1 ? '' : 's'} skipped`);
  if (read.stoppedAtVisited !== undefined) parts.push(`scan stopped at ${read.stoppedAtVisited} dirs`);
  if (read.depthLimited) parts.push('deeper than 6 levels not scanned');
  return parts.length > 0 ? parts.join('; ') : undefined;
}

async function adrItem(repoRoot: string, useGit: boolean, relPath: string, content: string, remoteUrl: string | null, branch: string): Promise<PersonalImportItem> {
  const decided = await adrDecisionDate(repoRoot, relPath, content, useGit);
  return {
    source_url: buildBlobUrl(remoteUrl, branch, relPath),
    platform: 'docs',
    raw_text: stripLeadingHtmlComments(content),
    title: firstHeading(content) ?? humanizeFilename(relPath),
    ...(decided ? { created_at: decided.date } : {}),
    // Only a git date is marked: it may be the day the ADRs were moved, not the day anyone decided.
    ...(decided?.source === 'first-commit' ? { date_source: 'first-commit' as const } : {}),
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
): Promise<{ items: PersonalImportItem[]; droppedShort: number; droppedRelease: number; droppedRules: Array<{ section: string; count: number }> }> {
  const items: PersonalImportItem[] = [];
  // Headed sections the length floor dropped, so the capture report can name
  // them. The headingless preamble (an H1 line, an intro sentence) is not counted when it
  // is dropped: nobody wrote it as a section, so nobody will look for it in the graph.
  let droppedShort = 0;
  // Release batch notes in project.md: history, counted so the report can say they were left out.
  let droppedRelease = 0;
  // Rules past the per-section cap, so the capture report can name the section that lost them.
  const droppedRules: Array<{ section: string; count: number }> = [];
  const seenReal = new Set<string>(); // a case-insensitive filesystem answers tenets.md and TENETS.md with one file
  for (const candidate of AGENT_RULES_FILES) {
    let raw: string;
    let file = candidate;
    try {
      const real = await realpath(path.join(repoRoot, candidate));
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      raw = await readFile(path.join(repoRoot, candidate), 'utf8');
      // On a case-insensitive filesystem `tenets.md` opens `TENETS.md`. Name the file as it is stored,
      // so the source_url (the identity key) is the same on every platform.
      const dir = path.posix.dirname(candidate);
      const entries = await readdir(path.join(repoRoot, dir));
      const base = path.posix.basename(candidate);
      const stored = entries.find((e) => e === base) ?? entries.find((e) => e.toLowerCase() === base.toLowerCase()) ?? base;
      file = dir === '.' ? stored : `${dir}/${stored}`;
    } catch {
      continue; // file not present in this repo - not an error
    }
    const stripped = stripAlignOwnedContent(raw.replace(/\r\n?/g, '\n'));
    // Two `## Section` with the same text (a Database section under both a gateway and a
    // brain heading, say) would otherwise slugify to the same anchor and collide on
    // source_url, which is the dedup/identity key downstream - one of the two would be
    // silently dropped rather than imported.
    const seenSlugs = new Map<string, number>();
    for (const section of splitIntoSections(stripped)) {
      if (!section.heading && NO_PREAMBLE.has(candidate)) continue;
      if (section.heading && NO_PREAMBLE.has(candidate) && isVersionedReleaseHeading(section.heading)) {
        droppedRelease++;
        continue;
      }
      if (withoutComments(section.body).length < MIN_CHUNK_CHARS) {
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
      const list = section.heading ? splitRuleList(withoutComments(section.body)) : null;
      if (list) {
        // One decision per rule. The title is the rule as written (the privacy check for --out needs it verbatim in
        // the committed file); the section travels in the text as context.
        // The url is `<section anchor>~<rule key>`: slugify cannot emit `~`, so the parent anchor is recoverable exactly.
        // The key is the rule's slug plus a hash of its text. Stable: inserting, removing or reordering OTHER rules, and
        // adding a sibling that shares a prefix. Not stable: REWORDING the rule, which is a new rule (new row, the old
        // wording stays in the graph; the importer cannot tell a reword from a new rule).
        if (list.overflow.length > 0) droppedRules.push({ section: section.heading!, count: list.overflow.length });
        const seenKeys = new Map<string, number>();
        const base = `${buildBlobUrl(remoteUrl, branch, file)}${anchor}`;
        for (const rule of list.rules) {
          const slug = slugify(rule.text).slice(0, 60).replace(/-+$/, '');
          const hash = createHash('sha1').update(rule.text).digest('hex').slice(0, 8);
          const key = slug ? `${slug}-${hash}` : hash;
          const n = seenKeys.get(key) ?? 0;
          seenKeys.set(key, n + 1); // only an exact repeat of the same rule text needs a counter
          const prefix = rule.group ? `${section.heading}, ${rule.group}` : section.heading!;
          items.push({
            source_url: `${base}~${key}${n > 0 ? `-${n + 1}` : ''}`,
            platform: 'docs',
            raw_text: `${rule.full}\n\nFrom the "${prefix}" section.`,
            title: rule.text,
          });
        }
        if (list.overflow.length > 0) {
          // Rules past the cap stay in the graph, and so checkable, as one row rather than vanishing. The trailing marker
          // makes it graph-only: its title is not in the committed file, so listing it in DECISIONS.md would make --out refuse.
          const title = `Further rules from the ${section.heading} section`;
          items.push({
            source_url: `${base}~further-rules`,
            platform: 'docs',
            raw_text: `${title}\n\n${list.overflow.map((t) => `- ${t}`).join('\n')}\n\nFrom the "${section.heading}" section. (further rules, graph only)`,
            title,
          });
        }
        continue;
      }
      items.push({
        source_url: `${buildBlobUrl(remoteUrl, branch, file)}${anchor}`,
        platform: 'docs',
        raw_text: stripLeadingHtmlComments(section.body),
        title,
      });
    }
  }
  return { items, droppedShort, droppedRelease, droppedRules };
}


const CONVENTION_SOURCES: Array<{ kind: DocKind; files: string[] }> = [
  { kind: 'readme', files: README_FILES },
  { kind: 'contributing', files: CONTRIBUTING_FILES },
  { kind: 'changelog', files: CHANGELOG_FILES },
];

/** An imported doc item, plus the structured co-change rule when its text states one. */
export type DocsItem = PersonalImportItem & { co_change_rule?: CoChangeRule };

/**
 * README / CONTRIBUTING / changelog: only the sections that state a rule (see
 * docs-conventions.ts). A headed section that does not is counted, so the capture report can
 * say how many were left out; the headingless preamble is not, as in readAgentRulesItems.
 */
async function readConventionItems(
  repoRoot: string,
  remoteUrl: string | null,
  branch: string,
): Promise<{ items: DocsItem[]; droppedNonRule: number; droppedShort: number }> {
  const items: DocsItem[] = [];
  let droppedNonRule = 0;
  let droppedShort = 0;
  const seenFiles = new Set<string>();
  for (const { kind, files } of CONVENTION_SOURCES) {
    for (const file of files) {
      // A case-insensitive filesystem answers CHANGELOG.md and changelog.md with one file.
      const key = file.toLowerCase();
      if (seenFiles.has(key)) continue;
      let raw: string;
      try {
        raw = await readFile(path.join(repoRoot, file), 'utf8');
      } catch {
        continue;
      }
      seenFiles.add(key);
      const seenSlugs = new Map<string, number>();
      for (const section of splitIntoSections(stripAlignOwnedContent(raw))) {
        if (!section.heading) continue;
        const body = sectionBody(kind, section.body).replace(/\n+---+\s*$/, '').trim();
        if (!isRuleSection(kind, section.heading, body)) { droppedNonRule++; continue; }
        if (body.length < MIN_CHUNK_CHARS) { droppedShort++; continue; }
        const slug = slugify(section.heading);
        const seen = seenSlugs.get(slug) ?? 0;
        seenSlugs.set(slug, seen + 1);
        const rule = await inferCoChangeRule(body, repoRoot);
        items.push({
          source_url: `${buildBlobUrl(remoteUrl, branch, file)}#${slug}${seen > 0 ? `-${seen + 1}` : ''}`,
          platform: 'docs',
          raw_text: body,
          title: section.heading,
          ...(rule ? { co_change_rule: rule } : {}),
        });
      }
    }
  }
  return { items, droppedNonRule, droppedShort };
}

/** Decision log files (docs-decision-log.ts): one item per entry, anchored on the entry's id so a
 *  re-import updates it. Status (retired, superseded) stays in raw_text: PersonalImportItem has no
 *  status field, and the ingest relationship analysis reads it from the text. */
async function readDecisionLogItems(repoRoot: string, remoteUrl: string | null, branch: string): Promise<DocsItem[]> {
  const items: DocsItem[] = [];
  for (const file of await findDecisionLogFiles(repoRoot)) {
    const seen = new Map<string, number>();
    const content = await readLogFile(repoRoot, file);
    // `align up --out DECISIONS.md` writes here; reading it back would import Align's own output.
    if (isGeneratedDecisionsFile(content)) continue;
    for (const entry of splitDecisionLog(content)) {
      const slug = slugify(entry.id ?? entry.heading ?? entry.title);
      const n = seen.get(slug) ?? 0;
      seen.set(slug, n + 1);
      const created = entryDate(entry.text);
      items.push({
        source_url: `${buildBlobUrl(remoteUrl, branch, file)}#${slug}${n > 0 ? `-${n + 1}` : ''}`,
        platform: 'docs',
        raw_text: entry.text,
        title: entry.title,
        ...(created ? { created_at: created } : {}),
      });
    }
  }
  return items;
}

async function readDocsItems(opts: { limit: number; cwd?: string }): Promise<{
  items: DocsItem[];
  /** Every ADR file and every headed section seen, kept or dropped. */
  scanned: number;
  /** Whether the limit left something unread or unreturned. */
  capped: boolean;
  droppedShort: number;
  /** README/CONTRIBUTING/changelog sections that state no rule. */
  droppedNonRule: number;
  /** Which ADR directories were found by name outside the candidate list; absent when none. */
  discoveryNote?: string;
  /** Rules past a section's cap, by section. */
  droppedRules: Array<{ section: string; count: number }>;
}> {
  const repoRoot = opts.cwd ?? process.cwd();
  const gitOpts = opts.cwd ? { cwd: opts.cwd } : undefined;
  const [remoteUrl, branch, adrRead] = await Promise.all([
    getRemoteUrl(gitOpts),
    getCurrentBranch(gitOpts).catch(() => 'main'),
    readAdrFiles(repoRoot),
  ]);

  const adrFiles = adrRead.files;
  const keptAdrFiles = adrFiles.slice(0, opts.limit);
  const note = adrScopeNote(adrRead, keptAdrFiles);
  const discovery = note ? { discoveryNote: note } : {};
  // Once per import: a shallow clone's history says nothing true about when an ADR was added.
  const useGit = !(await isShallowRepo(repoRoot));
  const adrItems = await mapLimit(keptAdrFiles, GIT_CONCURRENCY, ({ relPath, content }) =>
    adrItem(repoRoot, useGit, relPath, content, remoteUrl, branch));

  // ADRs alone already fill the limit: reading and stripping CLAUDE.md/AGENTS.md would be
  // work whose result gets sliced away, so skip it rather than doing it and throwing it out.
  const remaining = opts.limit - adrItems.length;
  // Capped even at exact equality: the agent-rules files were never opened BECAUSE the
  // limit was already full, so something may have been left out and nobody counted it.
  if (remaining <= 0) return { items: adrItems, scanned: adrFiles.length, capped: true, droppedShort: 0, droppedNonRule: 0, droppedRules: [], ...discovery };

  const { items: agentRulesItems, droppedShort, droppedRelease, droppedRules } = await readAgentRulesItems(repoRoot, remoteUrl, branch);
  const conventions = await readConventionItems(repoRoot, remoteUrl, branch);
  const logItems = await readDecisionLogItems(repoRoot, remoteUrl, branch);
  const candidates = adrFiles.length + agentRulesItems.length + conventions.items.length + logItems.length;
  return {
    items: [...adrItems, ...agentRulesItems, ...conventions.items, ...logItems].slice(0, opts.limit),
    scanned: candidates + droppedShort + conventions.droppedShort + conventions.droppedNonRule + droppedRelease,
    // Strictly more than the limit: everything was read, so the cap bound the read only
    // if the slice actually cut something.
    capped: candidates > opts.limit,
    droppedShort: droppedShort + conventions.droppedShort,
    droppedNonRule: conventions.droppedNonRule + droppedRelease,
    ...discovery,
    droppedRules,
  };
}

/**
 * The same read, plus its capture report. A local read has no page size to fall
 * off and no access to lack, so the one thing it drops is a headed section under the
 * length floor, and that is the one skip it reports. `scanned` is every ADR file and
 * headed section seen; the cap is echoed only when it bounded the read - "8 ADRs and
 * sections of up to 500 requested" on every run says nothing (the same rule as
 * gitCaptureReport). When it did bind, fetched equals the cap and the renderer prints no
 * clause: the user got what they asked for, and how many more exist is unknown when the
 * ADRs alone fill the limit, so no count is invented for it.
 */
export async function fetchDocsItems(opts: { limit: number; cwd?: string }): Promise<CaptureFetchResult> {
  const { items, scanned, capped, droppedShort, droppedNonRule, droppedRules, discoveryNote } = await readDocsItems(opts);
  return {
    items,
    report: {
      scanned,
      ...(capped ? { requested: opts.limit } : {}),
      ...(discoveryNote ? { scopeNote: discoveryNote } : {}),
      skips: [
        ...(droppedShort > 0
          ? [{ count: droppedShort, detail: `sections under ${MIN_CHUNK_CHARS} characters (a bare heading or a one-line pointer)` }]
          : []),
        ...droppedRules.map(({ section, count }) => ({ count, detail: `rules past the 30 kept from the "${section}" section` })),
        ...(droppedNonRule > 0
          ? [{ count: droppedNonRule, detail: 'README, CONTRIBUTING and changelog sections that state no rule (install steps, release entries)' }]
          : []),
      ],
    },
  };
}
