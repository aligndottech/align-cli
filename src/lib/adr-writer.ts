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
import { extractReason, stripImporterMetadata } from './reason-extract.js';

const NUMBERED = /^(\d+)-.*\.md$/i;

/** The repo's own ADR folder (the first candidate that holds a markdown file), else docs/adr. */
export function adrDirFor(repoRoot: string): string {
  for (const rel of ADR_DIR_CANDIDATES) {
    if (rel.includes('rfc')) continue;
    const dir = path.join(repoRoot, rel);
    try {
      if (fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.md'))) return rel;
    } catch { /* not there */ }
  }
  return 'docs/adr';
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

/** Every source URL any existing ADR in the folder already links to. */
function linkedFromAdrs(dir: string): string {
  let text = '';
  try {
    for (const f of fs.readdirSync(dir)) if (f.toLowerCase().endsWith('.md')) text += fs.readFileSync(path.join(dir, f), 'utf8') + '\n';
  } catch { /* no folder yet */ }
  return text;
}

/** Decisions that are not ADRs already (docs rows) and that no existing ADR links to. */
export function adrCandidates(rows: AdrRow[], repoRoot: string): AdrCandidate[] {
  const existing = linkedFromAdrs(path.join(repoRoot, adrDirFor(repoRoot)));
  const out: AdrCandidate[] = [];
  for (const r of rows) {
    if (r.platform === 'docs') continue;
    if (r.source_url && existing.includes(r.source_url)) continue;
    const body = stripImporterMetadata(r.body ?? r.summary ?? '');
    out.push({ title: r.title, sourceUrl: r.source_url, reason: extractReason(r.title, body), excerpt: body.slice(0, 1200), date: r.created_at?.slice(0, 10) ?? null });
  }
  return out;
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
