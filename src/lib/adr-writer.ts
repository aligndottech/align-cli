/**
 * Write an ADR into the repo for a decision made in a commit, a PR or a ticket that never got one.
 *
 * Everything in the file comes from the source: its title, the reason it stated, an excerpt of its text,
 * and a link to where it was decided. Nothing is generated, so a section the source never covered says so.
 * Files are created with the `wx` flag: an existing file is never replaced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ADR_DIR_CANDIDATES } from './fetchers/docs.js';
import { currentRepoIdentitySync, repoFromSourceUrl } from './repo-identity.js';
import { extractReason, stripImporterMetadata } from './reason-extract.js';

const NUMBERED = /^(\d+)-.*\.md$/i;

const isDir = (dir: string) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };
const hasMarkdown = (dir: string) => { try { return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.md')); } catch { return false; } };
const adrCandidateDirs = () => ADR_DIR_CANDIDATES.filter((rel) => !rel.includes('rfc'));

/** The repo's own ADR folder: the first candidate holding a markdown file, else the first that exists even if empty, else docs/adr. */
export function adrDirFor(repoRoot: string): string {
  const dirs = adrCandidateDirs();
  return dirs.find((rel) => hasMarkdown(path.join(repoRoot, rel)))
    ?? dirs.find((rel) => isDir(path.join(repoRoot, rel)))
    ?? 'docs/adr';
}

/** The number after the highest existing ADR, padded to the width the folder already uses (4 when empty). */
export function nextAdrNumber(dir: string): string {
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { /* missing folder: first ADR */ }
  let max = 0;
  let width = 4;
  for (const f of files) {
    const m = NUMBERED.exec(f);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= max) { max = n; width = Math.max(m[1].length, 1); }
  }
  return String(max + 1).padStart(width, '0');
}

export interface AdrInput {
  number: string;
  title: string;
  date: string;
  reason?: string | null;
  excerpt?: string | null;
  sourceUrl?: string | null;
}

export function renderAdr(a: AdrInput): string {
  const excerpt = (a.excerpt ?? '').trim();
  const context = [
    a.reason ? `The reason given at the time: ${a.reason}` : 'The source states no reason.',
    excerpt ? `\nFrom the source:\n\n${excerpt.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}` : '',
  ].join('\n');
  return [
    `# ${Number(a.number)}. ${a.title}`,
    '',
    `Date: ${a.date}`,
    '',
    '## Status',
    '',
    'Accepted',
    '',
    '## Context',
    '',
    context,
    '',
    '## Decision',
    '',
    a.title,
    '',
    a.sourceUrl ? `Decided in ${a.sourceUrl}` : 'Where it was decided was not recorded.',
    '',
    '## Consequences',
    '',
    'Not recorded in the source. Add them here.',
    '',
    '<!-- Drafted by `align adr write` from the source above. Edit freely. -->',
    '',
  ].join('\n');
}

export interface AdrRow { title: string; platform?: string; summary?: string | null; source_url?: string | null; body?: string | null; created_at?: string | null }
export interface AdrCandidate { title: string; sourceUrl?: string | null; reason?: string | null; excerpt?: string | null; date?: string | null }

/** Every complete URL that any ADR in any convention folder mentions (trailing sentence punctuation dropped). */
function linkedFromAdrs(repoRoot: string): Set<string> {
  const urls = new Set<string>();
  for (const rel of adrCandidateDirs()) {
    const dir = path.join(repoRoot, rel);
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.md')) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/(?:https?|git):\/\/[^\s<>()[\]"'`]+/g)) urls.add(m[0].replace(/[.,;:!?]+$/, ''));
    }
  }
  return urls;
}

/** Decisions that are not ADRs already (docs rows) and that no existing ADR links to. */
export function adrCandidates(rows: AdrRow[], repoRoot: string): AdrCandidate[] {
  const existing = linkedFromAdrs(repoRoot);
  const out: AdrCandidate[] = [];
  for (const r of rows) {
    if (r.platform === 'docs') continue;
    if (r.source_url && existing.has(r.source_url)) continue;
    const stored = r.body ?? r.summary ?? '';
    const body = stripImporterMetadata(stored);
    // The reason is read from the stored text: extractReason drops a commit's trailers, and it knows a
    // commit by the importer block that `body` no longer has.
    out.push({ title: r.title, sourceUrl: r.source_url, reason: extractReason(r.title, stored), excerpt: body.slice(0, 1200), date: r.created_at?.slice(0, 10) ?? null });
  }
  return out;
}

/**
 * Only the rows whose source is this repo. A cloud graph holds every repo in the tenant and listDecisions has no repo filter there,
 * so without this another repo's decision could be drafted into this repo's ADR folder. Ticket and unlinked rows carry no repo identity and are dropped.
 */
export function rowsOfThisRepo<T extends { source_url?: string | null }>(rows: T[], repoRoot: string): T[] {
  const repo = currentRepoIdentitySync({ cwd: repoRoot });
  const hosted = repo !== null && /^(github|gitlab)\.com\//.test(repo);
  return rows.filter((r) => {
    const url = r.source_url;
    if (!url) return false;
    if (url.startsWith('git://')) return !hosted;
    return repo !== null && repoFromSourceUrl(url) === repo;
  });
}

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');

/** Write one ADR and return its repo-relative path. Throws rather than replace an existing file. */
export function writeAdr(repoRoot: string, c: AdrCandidate, today: string, o: { number?: string } = {}): string {
  const rel = adrDirFor(repoRoot);
  const dir = path.join(repoRoot, rel);
  fs.mkdirSync(dir, { recursive: true });
  const number = o.number ?? nextAdrNumber(dir);
  const file = path.posix.join(rel, `${number}-${slug(c.title)}.md`);
  fs.writeFileSync(path.join(repoRoot, file), renderAdr({ number, title: c.title, date: c.date ?? today, reason: c.reason, excerpt: c.excerpt, sourceUrl: c.sourceUrl }), { flag: 'wx' });
  return file;
}
