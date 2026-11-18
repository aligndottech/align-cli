import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PersonalImportItem } from '../personal-import.js';

/**
 * Read nightshift's parking lot (github.com/orwa-mahmoud/nightshift), a tool that lets a coding
 * agent work a long shift alone. When the agent hits a choice it cannot settle, it parks it as one
 * `- ` bullet below the `---` rule: context · the default it chose · why, with `Default:` and
 * `Rollback:` lines under it. The owner closes the entry by appending a disposition, and
 * `nightshift:archive` files closed entries under `.nightshift/archive/`. The format is
 * nightshift's; this reader maps from it, read-only.
 *
 * Only CLOSED entries are imported. An open one is the agent's unconfirmed default: it must never
 * govern an edit, and nightshift already shows it at the start of the next shift. Importing it as
 * a claim and then again once answered would leave two rows for one question.
 *
 * Identity is the question (the text before the first ` · `), so the same entry read from the live
 * file and later from an archive is one decision, and a re-import updates it.
 */

export class NightshiftError extends Error {}
export interface NightshiftRead { items: PersonalImportItem[]; open: number; files: number }

const SEP = ' · ';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** An answer that defers rather than decides. The entry still waits on the owner. */
const DEFERRED = /^(later|not now|skip|tbd)\.?$/i;

export const nightshiftUrl = (question: string): string =>
  `nightshift://parking-lot/${createHash('sha256').update(question.trim().toLowerCase()).digest('hex').slice(0, 16)}`;

/** The entries: each `- ` bullet with the lines that belong to it (indented, or a `Default:`/`Rollback:` bullet). */
function entries(text: string): string[][] {
  const lines = text.split(/\r?\n/);
  const rule = lines.findIndex((l) => l.trim() === '---');
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const raw of lines.slice(rule === -1 ? 0 : rule + 1)) {
    if (raw.trim() === '') continue;
    const bullet = /^- (.*)$/.exec(raw);
    if (bullet) {
      const body = bullet[1]!.replace(/\*\*/g, '').trim();
      if (current && /^(Default|Rollback):/i.test(body)) { current.push(body); continue; }
      current = [body];
      out.push(current);
    } else if (current && /^\s+\S/.test(raw)) {
      current.push(raw.trim().replace(/^- /, '').replace(/\*\*/g, ''));
    } else {
      current = null; // a paragraph or a Filed: pointer ends the entry and is not one
    }
  }
  return out;
}

type Disposition = { kind: 'answered' | 'accepted-tradeoff' | 'rejected-because' | 'fixed' | 'ignored'; text: string };

function dispositionOf(segment: string): Disposition | null {
  const m = /^(answered|accepted-tradeoff|rejected-because|fixed|ignored)\b[:\s]*(.*)$/i.exec(segment.trim());
  return m ? { kind: m[1]!.toLowerCase() as Disposition['kind'], text: m[2]!.trim() } : null;
}

const day = (d: string): string => `${d}T00:00:00.000Z`;

export function parseParkingLot(text: string, o: { fileDate?: string } = {}): { items: PersonalImportItem[]; open: number } {
  const items: PersonalImportItem[] = [];
  let open = 0;
  for (const [head, ...rest] of entries(text)) {
    const segments = head!.split(SEP).map((s) => s.trim()).filter((s) => s !== '');
    const at = segments.findIndex((s) => dispositionOf(s) !== null);
    const disposition = at === -1 ? null : dispositionOf(segments[at]!);
    if (!disposition || (disposition.kind === 'answered' && (disposition.text === '' || DEFERRED.test(disposition.text)))) { open++; continue; }
    if (disposition.kind === 'fixed' || disposition.kind === 'ignored') continue;
    const [question, ...context] = segments.slice(0, at);
    if (!question) continue;
    const trailing = segments.slice(at + 1);
    const date = trailing.find((s) => DATE.test(s)) ?? (o.fileDate && DATE.test(o.fileDate) ? o.fileDate : undefined);
    const outcome = disposition.kind === 'answered' ? `Answered: ${disposition.text}`
      : disposition.kind === 'accepted-tradeoff' ? `Accepted the agent's default${disposition.text ? `: ${disposition.text}` : ''}`
      : `Rejected the agent's default${disposition.text ? `: ${disposition.text}` : ''}`;
    const body = [
      question,
      ...(context[0] ? [`Agent's default: ${context[0]}`] : []),
      ...(context.length > 1 ? [`Why: ${context.slice(1).join(SEP)}`] : []),
      ...rest,
      outcome,
    ];
    items.push({
      source_url: nightshiftUrl(question),
      platform: 'nightshift',
      title: question,
      raw_text: body.join('\n'),
      ...(date ? { created_at: day(date) } : {}),
    });
  }
  return { items, open };
}

/** Every parking-lot.md under .nightshift, archive folders included, live file last so its answer wins. */
async function parkingLots(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name === 'parking-lot.md') found.push(p);
    }
  };
  await walk(dir);
  const archived = (p: string) => p.includes(`${path.sep}archive${path.sep}`);
  return found.sort((a, b) => Number(archived(b)) - Number(archived(a)) || a.localeCompare(b, 'en'));
}

export async function readNightshift(repoRoot: string): Promise<NightshiftRead> {
  const dir = path.join(repoRoot, '.nightshift');
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new NightshiftError(`There is no .nightshift folder in ${repoRoot}. Run this in a repo where nightshift has run a shift.`);
  }
  const files = await parkingLots(dir);
  const byUrl = new Map<string, PersonalImportItem>();
  let open = 0;
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep);
    const fileDate = rel[0] === 'archive' ? rel.slice(1).map((s) => /\d{4}-\d{2}-\d{2}/.exec(s)?.[0]).find(Boolean) : undefined;
    const parsed = parseParkingLot(await readFile(file, 'utf8'), fileDate ? { fileDate } : {});
    // Only the live file's open entries are still waiting; an archive keeps its own copy of history.
    if (rel[0] !== 'archive') open += parsed.open;
    for (const item of parsed.items) {
      const earlier = byUrl.get(item.source_url);
      // Archives first, live last: a later read of the same question replaces the earlier one, keeping the first date seen.
      byUrl.set(item.source_url, earlier?.created_at && !item.created_at ? { ...item, created_at: earlier.created_at } : item);
    }
  }
  return { items: [...byUrl.values()], open, files: files.length };
}
