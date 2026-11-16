import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Decision log files a repo keeps by hand: a numbered log (`## D17 - title`, `D181: ...`) or a
 * ledger (`id: D-001 · status: test · modified: 2026-10-27`, then text). Only the repo root and
 * docs/ are listed, so `.align/` (Align's own generated decisions file, align-cli#116) is never
 * reached. docs/decisions/ is an ADR directory and is read by docs.ts, not here.
 */
const LOG_FILE = /^(?:decisions?[-_]log|decisions|.*ledger.*)\.md$/i;
const LOG_DIRS = ['', 'docs'];

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
/** `id: X`, or a bare id-like token (D-001, D181, ADR-7), at the start of a top-level line. */
const ID_START = /^(?:[-*]\s+)?(?:id:\s*([\w.-]+)|([A-Za-z]{1,6}-?\d+))(?![\w])/i;
const ID_IN_HEADING = /^(?:id:\s*([\w.-]+)|([A-Za-z]{1,6}-?\d+))(?![\w])/i;
const FIELD = /^([a-z_]+):\s*(.*)$/i;
const MIN_ENTRY_CHARS = 20;

export interface LogEntry {
  id: string | null;
  heading: string | null;
  title: string;
  text: string;
}

export async function findDecisionLogFiles(repoRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of LOG_DIRS) {
    const entries = await readdir(path.join(repoRoot, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isFile() && LOG_FILE.test(e.name)) out.push(dir ? `${dir}/${e.name}` : e.name);
  }
  return out.sort();
}

function fieldsOf(line: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const seg of line.split(/\s*[·|]\s*/)) {
    const m = seg.trim().match(FIELD);
    if (m) fields.set(m[1].toLowerCase(), m[2].trim());
  }
  return fields;
}

/** The first line with its `key: value` segments removed; empty when the line was all fields. */
function textOutsideFields(line: string): string {
  return line.split(/\s*[·|]\s*/).filter((seg) => !/^[a-z_]+:\s/i.test(seg.trim()) && !/^[a-z_]+:$/i.test(seg.trim())).join(' ').trim();
}

export function splitDecisionLog(content: string): LogEntry[] {
  const blocks: Array<{ id: string | null; heading: string | null; level: number; lines: string[] }> = [];
  let fence: string | null = null;
  for (const line of content.split('\n')) {
    const fenceMark = line.match(/^\s*(```|~~~)/)?.[1];
    // Lines inside a fenced block belong to the enclosing entry, whatever they look like.
    if (fence !== null || fenceMark) {
      if (fenceMark && (fence === null || fenceMark === fence)) fence = fence === null ? fenceMark : null;
      if (blocks.length > 0) blocks[blocks.length - 1].lines.push(line);
      continue;
    }
    const h = line.match(HEADING);
    const topLevel = !/^\s/.test(line);
    const idMatch = h ? h[1].match(ID_IN_HEADING) : topLevel ? line.match(ID_START) : null;
    if (h || idMatch) {
      blocks.push({ id: idMatch ? (idMatch[1] ?? idMatch[2]) : null, heading: h ? h[1] : null, level: h ? line.indexOf(' ') : 0, lines: [line] });
    } else if (blocks.length > 0) blocks[blocks.length - 1].lines.push(line);
  }
  // A leading id-less H1 is the file's title, not a decision.
  if (blocks[0] && blocks[0].level === 1 && blocks[0].id === null) blocks.shift();
  return blocks
    .map((b) => {
      const text = b.lines.join('\n').trim();
      const first = b.lines[0].replace(/^#+\s+/, '').replace(/^[-*]\s+/, '').trim();
      // A heading keeps its first segment whole ("Decision: use pnpm"); only trailing fields go.
      const remainder = b.heading ? first.split(/\s*[·|]\s*/)[0].trim() : textOutsideFields(first);
      const body = b.lines.slice(1).find((l) => l.trim() !== '')?.trim();
      return { id: b.id, heading: b.heading, title: (remainder || body || b.id || '').slice(0, 120), text };
    })
    .filter((e) => e.title !== '' && (e.id !== null || (e.heading !== null && e.text.length >= MIN_ENTRY_CHARS)));
}

/** The first parseable date field. No git fallback: one file holds many decisions, so the
 *  file's history says nothing true about when any single entry was decided. */
export function entryDate(text: string): string | undefined {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) for (const [k, v] of fieldsOf(line.replace(/^\s*[-*]\s+/, ''))) if (!fields.has(k)) fields.set(k, v);
  for (const key of ['date', 'decided', 'modified']) {
    const day = fields.get(key)?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (!day) continue;
    const d = new Date(`${day}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day) return d.toISOString();
  }
  return undefined;
}

export async function readLogFile(repoRoot: string, rel: string): Promise<string> {
  return readFile(path.join(repoRoot, rel), 'utf8');
}
