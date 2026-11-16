import { readFile } from 'node:fs/promises';
import type { PersonalImportItem } from '../personal-import.js';

/**
 * Read a MIRSAD JSON export (a local agent-memory tool). Its decisions are recorded by their
 * owner and carry explicit `supersedes` links, so this reader asserts nothing: it maps fields.
 * The format is MIRSAD's; we map from it and do not ask for changes.
 *
 * `id` is assigned once and never reused, so `mirsad://decisions/<id>` is stable across
 * re-exports and a re-import updates the row instead of adding one (source-key.ts keys it).
 */

export class MirsadFileError extends Error {}

/** `newer` supersedes `older`, both MIRSAD ids. */
export interface MirsadLink { newer: number; older: number }
export interface MirsadRead { items: PersonalImportItem[]; links: MirsadLink[]; skipped: number }

export const mirsadUrl = (id: number): string => `mirsad://decisions/${id}`;

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A number, null or an array of numbers: anything else in the slot is ignored. */
function ids(v: unknown): number[] {
  return (Array.isArray(v) ? v : [v]).filter(isId);
}

const BARE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const OFFSET = /^(?:Z|[+-]\d{2}:\d{2})$/;

const iso = (ms: number): string | undefined => (Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined);

/** Date.parse rolls 30 February over to March; a date that is not on the calendar must stay unset. */
const onCalendar = (y: number, mo: number, day: number): boolean => {
  const d = new Date(Date.UTC(y, mo - 1, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === day;
};

/** A moment that names itself: an ISO 8601 string carrying Z or an offset, or a Unix epoch in seconds. */
function absolute(v: unknown): string | undefined {
  if (typeof v === 'number') return iso(v * 1000);
  const t = text(v);
  const [y, mo, day] = t.slice(0, 10).split('-').map(Number) as [number, number, number];
  return ISO_WITH_ZONE.test(t) && onCalendar(y, mo, day) ? iso(Date.parse(t)) : undefined;
}

/**
 * When the decision was made, or undefined. Never a guess. In order:
 *  1. `made_at_utc`, then `made_at_offset` with the bare `made_at` (the only two extra names read);
 *  2. `made_at` that names itself: an ISO string with Z or an offset, used as given, or a number of epoch seconds;
 *  3. `made_at` as the bare "YYYY-MM-DD HH:MM" MIRSAD exports today: local time, no zone. It is read as
 *     the local time of the machine running the import, an assumption, since the export carries no zone.
 * An unusable offset or utc field falls through to the next rule rather than failing the item.
 */
function madeAt(d: Raw): string | undefined {
  const utc = absolute(d['made_at_utc']);
  if (utc) return utc;
  const bare = BARE.exec(text(d['made_at']));
  if (bare) {
    const [y, mo, day, h, mi] = bare.slice(1).map(Number) as [number, number, number, number, number];
    const offset = text(d['made_at_offset']);
    if (OFFSET.test(offset) && onCalendar(y, mo, day)) {
      const pad = (n: number) => String(n).padStart(2, '0');
      return iso(Date.parse(`${y}-${pad(mo)}-${pad(day)}T${pad(h)}:${pad(mi)}:00${offset}`));
    }
    const date = new Date(y, mo - 1, day, h, mi);
    const real = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === day && date.getHours() === h && date.getMinutes() === mi;
    return real ? date.toISOString() : undefined;
  }
  return absolute(d['made_at']);
}

function line(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (isRecord(v) && typeof v['text'] === 'string') {
    const ref = text(v['ref']);
    return ref ? `${v['text'].trim()} (${ref})` : v['text'].trim();
  }
  return v === null || v === undefined ? '' : JSON.stringify(v);
}

function rawTextOf(d: Raw): string {
  const sections: Array<[string, unknown]> = [
    ['Reasons', d['reasons']], ['Alternatives rejected', d['alternatives_rejected']],
    ['Evidence', d['evidence']], ['Effects', d['effects']], ['Outcomes', d['outcomes']],
  ];
  const blocks = [text(d['description'])];
  for (const [label, v] of sections) {
    const lines = list(v).map(line).filter((l) => l !== '');
    if (lines.length) blocks.push(`${label}:\n${lines.map((l) => `- ${l}`).join('\n')}`);
  }
  return blocks.filter((b) => b !== '').join('\n\n');
}

export function parseMirsadExport(raw: string): MirsadRead {
  let data: unknown;
  try { data = JSON.parse(raw); } catch (e) { throw new MirsadFileError(`This is not valid JSON: ${(e as Error).message}`); }
  if (!Array.isArray(data)) throw new MirsadFileError('A MIRSAD export is a JSON array of decisions, and this is not an array.');

  const items: PersonalImportItem[] = [];
  const known = new Set<number>();
  const edges: MirsadLink[] = [];
  let skipped = 0;
  for (const d of data) {
    if (!isRecord(d) || !isId(d['id']) || text(d['title']) === '') { skipped++; continue; }
    const id = d['id'];
    const title = text(d['title']);
    const createdAt = madeAt(d);
    known.add(id);
    for (const older of ids(d['supersedes'])) edges.push({ newer: id, older });
    for (const newer of ids(d['superseded_by'])) edges.push({ newer, older: id });
    items.push({
      source_url: mirsadUrl(id),
      platform: 'mirsad',
      title,
      raw_text: rawTextOf(d) || title,
      ...(text(d['made_by']) ? { author: { name: text(d['made_by']) } } : {}),
      ...(createdAt ? { created_at: createdAt } : {}),
    });
  }
  if (items.length === 0) throw new MirsadFileError(`The file has no valid decisions (${skipped} skipped: each needs a numeric id and a title).`);

  // A pair is named from either end, and a link to an id outside the file has nothing to attach to.
  const seen = new Set<string>();
  const links = edges.filter((e) => {
    const key = `${e.newer}>${e.older}`;
    if (e.newer === e.older || !known.has(e.newer) || !known.has(e.older) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { items, links, skipped };
}

export async function readMirsadFile(path: string): Promise<MirsadRead> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch (e) { throw new MirsadFileError(`Cannot read ${path}: ${(e as Error).message}`); }
  return parseMirsadExport(raw);
}
