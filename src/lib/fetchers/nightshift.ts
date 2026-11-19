import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PersonalImportItem } from '../personal-import.js';
import { currentRepoIdentity } from '../repo-identity.js';

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
export interface NightshiftRead { items: PersonalImportItem[]; open: number; files: number; planOpen: number; planFiles: number }

const SEP = ' · ';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** An answer that defers rather than decides. The entry still waits on the owner. */
const DEFERRED = /^(later|not now|skip|tbd)\.?$/i;

/** Keyed by the repo and the question, so the live and archived copies of one entry are one decision,
 *  and the same question parked in two repos is two. */
export const nightshiftUrl = (question: string, repo = ''): string =>
  `nightshift://parking-lot/${createHash('sha256').update(`${repo}\n${question.trim().toLowerCase()}`).digest('hex').slice(0, 16)}`;

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

/** The owner's dispositions. Unlike fixed/ignored, these never open an agent's default. */
const OWNER = new Set<Disposition['kind']>(['answered', 'accepted-tradeoff', 'rejected-because']);
/** A runtime permission request (`park-needs`), not a decision. */
const PERMISSION = /^needs allowance\b/i;
const TITLE_MAX = 100;

const segmentsOf = (line: string): string[] =>
  line.replace(/^·\s*/, '').split(SEP).map((s) => s.trim().replace(/^·\s*/, '')).filter((s) => s !== '');

/** A label repeated by the agent or a template ("Default: Default: kept off") is said once. */
const oneLabel = (s: string): string => s.replace(/^(Default|Rollback):\s*(?:(?:Default|Rollback):\s*)+/i, '$1: ');

/** A status note the runtime parks for the owner ("stalled - needs human: ..."), not a decision. */
const STATUS = /^stalled\b/i;
/** A line that is a labelled part of the entry, not a soft wrap of its text. */
const LABELLED = /^(Default|Rollback|Why|Outcome):/i;
/** Abbreviations whose period does not end a sentence. */
const ABBREV = /\b(?:vs|e\.g|i\.e|etc|cf|approx|no)\.$/i;

/** The first sentence when the question is too long for a title, else a cut at a word boundary. */
function titleOf(question: string): string {
  if (question.length <= TITLE_MAX) return question;
  for (const m of question.matchAll(/[.?!](?=\s+[A-Z0-9])/g)) {
    const sentence = question.slice(0, m.index + 1);
    if (sentence.length > TITLE_MAX) break;
    if (sentence.length >= 20 && !ABBREV.test(sentence)) return sentence;
  }
  const cut = question.slice(0, TITLE_MAX - 3);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length)}...`;
}

export function parseParkingLot(text: string, o: { fileDate?: string; repo?: string } = {}): { items: PersonalImportItem[]; open: number; openUrls: string[] } {
  const items: PersonalImportItem[] = [];
  const openUrls: string[] = [];
  let open = 0;
  for (const [first, ...more] of entries(text)) {
    // Identity stays on the bullet's first line exactly as 0.86.1 read it, so a re-import updates rather than duplicates.
    const key = segmentsOf(first!)[0];
    if (!key) continue;
    // A soft wrap continues the entry's text; a labelled line (Default:, Rollback:, ...) is its own part.
    const rest = more.filter((l) => LABELLED.test(l));
    const head = [first!, ...more.filter((l) => !LABELLED.test(l))].join(' ');
    const headSegments = segmentsOf(head);
    // A bold item number ("**14.** ...") is a list position, not part of the question.
    const question = headSegments[0]!.replace(/^\d+\.\s+/, '');
    if (!question) continue;
    // Every segment of the entry, wrapped lines included: the owner may append the answer to the last wrapped line.
    const all = [...headSegments.map((s) => ({ s, line: 0 })), ...rest.flatMap((l, i) => segmentsOf(l).map((s) => ({ s, line: i + 1 })))];
    // The owner's answer is the LAST owner disposition anywhere in the entry. The runtime may append after it
    // (`outcome: ...`, `reconciled <date>`), so it is not the last segment. fixed/ignored only close an entry
    // as its last head segment, so a default that starts with "fixed" is never read as one.
    let at = -1;
    for (let i = all.length - 1; i > 0; i--) { const d = dispositionOf(all[i]!.s); if (d && OWNER.has(d.kind)) { at = i; break; } }
    if (at === -1) {
      let last = headSegments.length - 1;
      while (last > 0 && DATE.test(headSegments[last]!)) last--;
      const closing = last > 0 ? dispositionOf(headSegments[last]!) : null;
      if (closing && !OWNER.has(closing.kind)) continue; // fixed or ignored: not a decision
    }
    const disposition = at === -1 ? null : dispositionOf(all[at]!.s)!;
    if (!disposition || (disposition.kind === 'answered' && (disposition.text === '' || DEFERRED.test(disposition.text)))) {
      open++;
      openUrls.push(nightshiftUrl(key, o.repo));
      continue;
    }
    if (PERMISSION.test(question) || STATUS.test(question)) continue;
    const answerLine = all[at]!.line;
    // Agent's default and why: the head segments before the answer, dates aside.
    const headContext = (answerLine === 0 ? headSegments.slice(1, at) : headSegments.slice(1));
    // A segment the agent labelled goes under its own label; an unlabelled one by position (default, then why).
    const undated = headContext.filter((s) => !DATE.test(s));
    const labelled = (l: string) => undated.map((s) => new RegExp(`^(?:${l}:\\s*)+`, 'i').exec(s) ? s.replace(new RegExp(`^(?:${l}:\\s*)+`, 'i'), '') : null).filter((s): s is string => s !== null);
    const plain = undated.filter((s) => !/^(Default|Why|Rollback):/i.test(s));
    const defaults = [...labelled('Default'), ...(labelled('Default').length ? [] : plain.slice(0, 1))];
    const whys = [...labelled('Why'), ...plain.slice(labelled('Default').length ? 0 : 1)];
    const rollbacks = labelled('Rollback');
    const trailing = all.slice(at + 1).map((x) => x.s);
    const date = [...trailing, ...headContext].find((s) => DATE.test(s)) ?? (o.fileDate && DATE.test(o.fileDate) ? o.fileDate : undefined);
    const outcomeNotes = trailing.map((s) => /^outcome:\s*(.+)$/i.exec(s)?.[1]).filter((s): s is string => Boolean(s)).map((s) => `Outcome: ${s}`);
    // Wrapped lines, minus the answer and what follows it.
    const wrapped = rest
      // With the answer on the bullet's own line every wrapped line is context; otherwise the lines before it, and
      // the part of its own line before the answer.
      .map((l, i) => (answerLine === 0 || i + 1 < answerLine ? segmentsOf(l) : i + 1 === answerLine ? segmentsOf(l).filter((s) => !all.slice(at).some((x) => x.s === s && x.line === i + 1)) : []))
      .map((segs) => oneLabel(segs.join(SEP)))
      .filter((l) => l !== '');
    const outcome = disposition.kind === 'answered' ? `Answered: ${disposition.text}`
      : disposition.kind === 'accepted-tradeoff' ? `Accepted the agent's default${disposition.text ? `: ${disposition.text}` : ''}`
      : `Rejected the agent's default${disposition.text ? `: ${disposition.text}` : ''}`;
    const body = [
      question,
      ...(defaults[0] ? [`Agent's default: ${defaults.join(SEP)}`] : []),
      ...(whys.length ? [`Why: ${whys.join(SEP)}`] : []),
      ...rollbacks.map((r) => `Rollback: ${r}`),
      ...wrapped,
      outcome,
      ...outcomeNotes,
    ];
    items.push({
      source_url: nightshiftUrl(key, o.repo),
      platform: 'nightshift',
      title: titleOf(question),
      raw_text: body.join('\n'),
      ...(date ? { created_at: day(date) } : {}),
    });
  }
  return { items, open, openUrls };
}

/** Planning-menu choices nightshift records as `Decided:` lines. They steer the planning, not the project. */
const MENU_CHOICE = /^(planning depth|evidence lines|edge-case pass|pre-mortem|ordering( and risk)? check|research|receipts\.\S+)$/i;
/** A decision is parted from its why by a dash: nightshift writes an em dash, a hyphen is read too. */
const WHY_SPLIT = /\s+(?:\u2014|\u2013|-)\s+/;

interface PlanEntry { topic: string; date?: string; closed: 'captured' | 'dropped' | null; lines: { label: string; text: string; note?: string }[] }

/** The plan record's entries: a `- **topic**` bullet, its labelled notes indented under it, wrapped lines joined. */
function planEntries(text: string): PlanEntry[] {
  const lines = text.split(/\r?\n/);
  const rule = lines.findIndex((l) => l.trim() === '---');
  const out: PlanEntry[] = [];
  let current: PlanEntry | null = null;
  for (const raw of lines.slice(rule === -1 ? 0 : rule + 1)) {
    if (raw.trim() === '') continue;
    const head = /^- \*\*(.+?)\*\*(.*)$/.exec(raw);
    if (head) {
      const rest = segmentsOf(head[2]!);
      const closing = rest.map((s) => /^(captured|dropped)\b/i.exec(s)?.[1]?.toLowerCase()).find(Boolean) as PlanEntry['closed'] | undefined;
      const date = /open since\s+(\d{4}-\d{2}-\d{2})/i.exec(head[2]!)?.[1];
      current = { topic: head[1]!.trim(), ...(date ? { date } : {}), closed: closing ?? null, lines: [] };
      out.push(current);
      continue;
    }
    // A label can carry a note before the colon: `Decided (docs, 2026-10-22): ...`.
    const note = /^\s+- (Where we are|Decided|Rejected|Open)(?:\s*\(([^)]*)\))?:\s*(.*)$/i.exec(raw);
    if (current && note) {
      const aside = note[2]?.trim();
      current.lines.push({ label: note[1]!.toLowerCase(), text: note[3]!.replace(/\*\*/g, '').trim(), ...(aside ? { note: aside } : {}) });
    }
    else if (current && /^\s+\S/.test(raw) && current.lines.length > 0) {
      const last = current.lines[current.lines.length - 1]!;
      last.text = `${last.text} ${raw.trim()}`;
    } else current = null; // a Filed: pointer, a paragraph or "(empty)" ends the entry and is not one
  }
  return out;
}

/** Keyed by the repo, the plan, the kind and the decision (not its why), so an edited reason, and the filed copy, update one row. */
export const planRecordUrl = (kind: 'decided' | 'rejected', topic: string, subject: string, repo = ''): string =>
  `nightshift://plan-record/${createHash('sha256').update(`${repo}\n${topic.trim().toLowerCase()}\n${kind}\n${subject.trim().toLowerCase()}`).digest('hex').slice(0, 16)}`;

/**
 * The plan room's notebook. Each `Decided:` line is a decision and each `Rejected:` line a rejected option,
 * both with the why after the dash. `Open:` lines are questions nobody answered, so they stay in nightshift
 * (counted, never imported), and a dropped plan's lines are not decisions at all.
 */
export function parsePlanRecord(text: string, o: { fileDate?: string; repo?: string } = {}): { items: PersonalImportItem[]; open: number } {
  const items: PersonalImportItem[] = [];
  let open = 0;
  for (const entry of planEntries(text)) {
    if (entry.closed === 'dropped') continue;
    const date = entry.date ?? (o.fileDate && DATE.test(o.fileDate) ? o.fileDate : undefined);
    for (const line of entry.lines) {
      if (line.label === 'open') { if (line.text) open++; continue; }
      if (line.label !== 'decided' && line.label !== 'rejected') continue;
      const [subject = '', ...why] = line.text.split(WHY_SPLIT);
      const reason = why.join(' - ').trim();
      if (!subject.trim() || (line.label === 'decided' && MENU_CHOICE.test(subject.trim()))) continue;
      const rejected = line.label === 'rejected';
      const noted = /\b\d{4}-\d{2}-\d{2}\b/.exec(line.note ?? '')?.[0];
      const lineDate = noted && !Number.isNaN(Date.parse(day(noted))) ? noted : date;
      items.push({
        source_url: planRecordUrl(rejected ? 'rejected' : 'decided', entry.topic, subject, o.repo),
        platform: 'nightshift',
        title: titleOf(rejected ? `Rejected: ${subject.trim()}` : subject.trim()),
        raw_text: [rejected ? `Rejected: ${subject.trim()}` : subject.trim(), ...(reason ? [`Why: ${reason}`] : []), ...(line.note ? [`Note: ${line.note}`] : []), `Plan: ${entry.topic}`].join('\n'),
        ...(lineDate ? { created_at: day(lineDate) } : {}),
      });
    }
  }
  return { items, open };
}

const DEFAULT_ROOT = ['archive'];
/** Folders the live records sit in. A root inside one would file the running shift on top of itself, so nightshift refuses it. */
const LIVE_FOLDERS = ['receipts', 'inbox', 'staging', 'product', 'run'];

/** An `archive.root` as path segments, or null when nightshift would refuse it (absolute, `..`, hidden, empty, or a live folder). */
function rootSegments(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.trim() === '' || /^([/\\~]|[A-Za-z]:)/.test(value.trim())) return null;
  const segs = value.trim().split(/[/\\]/).filter((s) => s !== '');
  if (segs.length === 0 || segs.some((s) => s === '.' || s === '..' || s.startsWith('.'))) return null;
  return LIVE_FOLDERS.includes(segs[0]!) ? null : segs;
}

async function readText(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

/**
 * Where nightshift files finished shifts: `archive.root` and `archive.layout`, from the settings file, the policy
 * frozen for the running shift, and the marker an ended shift leaves (a shift filed under an earlier root is still
 * archived). The default `archive` always counts. A file that cannot be read adds nothing.
 */
async function archiveSettings(dir: string): Promise<{ roots: string[][]; layouts: Map<string, Set<string>> }> {
  const roots: string[][] = [DEFAULT_ROOT];
  const layouts = new Map<string, Set<string>>(); // root -> the layouts declared for that root
  const take = (root: unknown, layout: unknown) => {
    // No root named is nightshift's default; a root named and refused takes its layout with it.
    const named = typeof root === 'string' && root.trim() !== '';
    const segs = named ? rootSegments(root) : DEFAULT_ROOT;
    if (!segs) return;
    if (!roots.some((r) => r.join('/') === segs.join('/'))) roots.push(segs);
    if (typeof layout === 'string' && layout) layouts.set(segs.join('/'), (layouts.get(segs.join('/')) ?? new Set()).add(layout));
  };
  for (const file of [path.join(dir, 'rules.json'), path.join(dir, 'run', 'shift-policy.json')]) {
    const text = await readText(file);
    if (text === null) continue;
    try {
      const block = (JSON.parse(text) as { archive?: { root?: unknown; layout?: unknown } } | null)?.archive;
      if (block && typeof block === 'object') take(block.root, block.layout);
    } catch { /* unreadable: today's behaviour */ }
  }
  const ended = await readText(path.join(dir, 'run', '.ended'));
  if (ended !== null) take(/^archiveRoot=(.*)$/m.exec(ended)?.[1]?.trim(), /^archiveLayout=(.*)$/m.exec(ended)?.[1]?.trim());
  return { roots, layouts };
}

/** The archive folder a file sits in, as `[...root, folder]`, or null for a live file. The longest root wins. */
function archiveFolder(rel: string[], roots: string[][]): string[] | null {
  let best: string[] | null = null;
  for (const root of roots) {
    if (rel.length > root.length + 1 && root.every((s, i) => rel[i] === s) && (!best || root.length > best.length - 1)) best = rel.slice(0, root.length + 1);
  }
  return best;
}

/** A folder's day: its own date when the layout names folders by date, else the `createdAt` of the shift policy filed in it. */
async function folderDate(dir: string, folder: string[], layouts: Map<string, Set<string>>): Promise<string | undefined> {
  // Only the layouts declared for this folder's own root decide; none declared trusts a date in the name.
  if ([...(layouts.get(folder.slice(0, -1).join('/')) ?? [])].every((l) => l === 'date' || l === 'date-name')) {
    const named = /^\d{4}-\d{2}-\d{2}/.exec(folder[folder.length - 1]!)?.[0];
    if (named) return named;
  }
  const text = await readText(path.join(dir, ...folder, 'run', 'shift-policy.json'));
  if (text === null) return undefined;
  try {
    const created = (JSON.parse(text) as { createdAt?: unknown } | null)?.createdAt;
    return typeof created === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(created)?.[0] : undefined;
  } catch { return undefined; }
}

/** Every file with one of these names under .nightshift, archive folders included. */
async function findFiles(dir: string, accept: (rel: string[]) => boolean): Promise<string[]> {
  const found: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && accept(path.relative(dir, p).split(path.sep))) found.push(p);
    }
  };
  await walk(dir);
  return found;
}

/** Archives first, live last, so the live file's answer wins. */
const archivesFirst = (dir: string, roots: string[][]) => (a: string, b: string): number => {
  const archived = (p: string) => Number(archiveFolder(path.relative(dir, p).split(path.sep), roots) !== null);
  return archived(b) - archived(a) || a.localeCompare(b, 'en');
};

export async function readNightshift(repoRoot: string): Promise<NightshiftRead> {
  const dir = path.join(repoRoot, '.nightshift');
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new NightshiftError(`There is no .nightshift folder in ${repoRoot}. Run this in a repo where nightshift has run a shift.`);
  }
  const { roots, layouts } = await archiveSettings(dir);
  const order = archivesFirst(dir, roots);
  const files = (await findFiles(dir, (rel) => rel[rel.length - 1] === 'parking-lot.md')).sort(order);
  // The plan record lives at staging/plan-record.md, live or filed. The older flat layout is not read.
  const plans = (await findFiles(dir, (rel) => rel[rel.length - 1] === 'plan-record.md' && rel[rel.length - 2] === 'staging')).sort(order);
  const repo = (await currentRepoIdentity({ cwd: repoRoot })) ?? path.resolve(repoRoot);
  const byUrl = new Map<string, PersonalImportItem>();
  const keep = (item: PersonalImportItem) => {
    const earlier = byUrl.get(item.source_url);
    // A later read of the same entry replaces the earlier one, keeping the first date seen.
    byUrl.set(item.source_url, earlier?.created_at && !item.created_at ? { ...item, created_at: earlier.created_at } : item);
  };
  let open = 0;
  let planOpen = 0;
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep);
    const folder = archiveFolder(rel, roots);
    const fileDate = folder ? await folderDate(dir, folder, layouts) : undefined;
    const parsed = parseParkingLot(await readFile(file, 'utf8'), { repo, ...(fileDate ? { fileDate } : {}) });
    // Only the live file's open entries are still waiting; an archive keeps its own copy of history. A question
    // parked again and still open in the live file is waiting on the owner, so an older archived answer does not stand.
    if (!folder) {
      open += parsed.open;
      for (const url of parsed.openUrls) byUrl.delete(url);
    }
    parsed.items.forEach(keep);
  }
  for (const file of plans) {
    const folder = archiveFolder(path.relative(dir, file).split(path.sep), roots);
    const fileDate = folder ? await folderDate(dir, folder, layouts) : undefined;
    const parsed = parsePlanRecord(await readFile(file, 'utf8'), { repo, ...(fileDate ? { fileDate } : {}) });
    if (!folder) planOpen += parsed.open;
    parsed.items.forEach(keep);
  }
  return { items: [...byUrl.values()], open, files: files.length, planOpen, planFiles: plans.length };
}
