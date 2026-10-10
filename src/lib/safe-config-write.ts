import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

/*
 * The one way align writes to a config file that belongs to someone else (an agent's MCP
 * config, its hook file). Promises, each of which a plain writeFileSync breaks:
 *  1. The FIRST content is kept in `<file>.align-backup` and never overwritten.
 *  2. The file is re-read after our new content is staged. If another program changed it in
 *     the meantime we recompute once from what is there now, and give up if it moves again.
 *  3. The new content lands by an exclusive temp file + rename, keeping the old file's mode.
 *  4. It never writes through a symlink: not the file, and not a directory between the user's
 *     home and the file (a linked agent dir usually points at another product's config).
 *  5. It records WHAT it added (the keys it owns, or the managed block), so `align use --undo`
 *     can take out align's own entries and nothing else.
 */

export const BACKUP_SUFFIX = '.align-backup';
export type SafeWriteStatus = 'written' | 'unchanged' | 'declined' | 'symlink';

/** The fs calls the writer makes. A parameter so a test can change the file mid-write. */
export interface SafeFs {
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  copyFileSync: typeof copyFileSync;
  lstatSync: typeof lstatSync;
  readlinkSync: typeof readlinkSync;
  chmodSync: typeof chmodSync;
  unlinkSync: typeof unlinkSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
}

// Built on use, not at import: a test that mocks node:fs with a few names must still be able
// to import anything that reaches this module.
const realFs = (): SafeFs => ({ readFileSync, writeFileSync, renameSync, copyFileSync, lstatSync, readlinkSync, chmodSync, unlinkSync, mkdirSync, readdirSync });

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** JSON with sorted keys, so a hash does not depend on key order. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
const shaOf = (v: unknown): string => sha(canon(v));

/** One value or array element align put in a JSON config. Hashes only, never the value. */
export interface OwnedItem {
  path: string[];
  kind: 'value' | 'array-item';
  sha256: string;
  /** Prune ancestors back to this path length if they end up empty (the parents align created). */
  createdDepth: number;
  /**
   * The key existed before align's first write and align overwrote it. `beforeSha256` is the
   * hash of the user's value; the value itself comes back from align's backup.
   */
  replaced?: boolean;
  beforeSha256?: string;
  /** Which snapshot holds the user's value: 0 is `<file>.align-backup`, n is `<file>.align-backup.<n>`. */
  snapshot?: number;
  /** align's write took this key (or this whole array) away; undo puts the user's original back when it is still gone. */
  removed?: boolean;
}

/** One file align wrote, as the manifest remembers it. */
export interface WrittenConfig {
  /** The file did not exist before align's first write. */
  created: boolean;
  /** sha256 of what align last wrote. */
  sha256: string;
  /**
   * sha256 of what align wrote FIRST. A whole-file undo needs the file to equal this AND the last
   * write: a later align rewrite folds the user's edits into the file, so matching only the last
   * write proves nothing about whether they edited it in between.
   */
  firstSha256: string;
  /** 'made': align made the backup. 'foreign': one was already there and is not trusted. 'none': no original to keep. */
  backup: 'made' | 'foreign' | 'none';
  backupSha256?: string;
  owned?: OwnedItem[];
  /**
   * Extra copies of the file taken just before a write that found it changed by someone else
   * (`<file>.align-backup.<n>`, 0600). Hashes only: the manifest never holds config values.
   */
  snapshots?: Array<{ n: number; sha256: string }>;
  /** Text files: the managed block align wrote. */
  block?: {
    start: string;
    end: string;
    sha256: string;
    /** a block was already there, and align's replaced it: the original is in the backup */
    replaced?: boolean;
    snapshot?: number;
    /**
     * TOML only: the one table the block holds, and the hash of its parsed value. Lets undo take
     * that table out when another program re-serialised the file and dropped the markers.
     */
    table?: { path: string[]; sha256: string };
  };
}

/** Fold one write into what the manifest already holds for that file. */
export function mergeWrittenConfig(prev: WrittenConfig | undefined, next: WrittenConfig): WrittenConfig {
  if (!prev) return next;
  const key = (i: OwnedItem) => `${i.kind}\u0000${i.path.join('\u0000')}${i.kind === 'array-item' ? `\u0000${i.sha256}` : ''}`;
  const owned = new Map((prev.owned ?? []).map((i) => [key(i), i]));
  for (const i of next.owned ?? []) {
    const old = owned.get(key(i));
    // `replaced` is a fact about the user's value before align: a value align itself rewrote is not that.
    if (!old) {
      owned.set(key(i), i);
      continue;
    }
    // The first write decides whether this was the user's value; later rewrites only move the hash.
    if (i.replaced) {
      // The user put a value of their own there since align's last write and this write replaced it:
      // that value (in the snapshot taken just now) is the one to give back.
      owned.set(key(i), { ...i, createdDepth: old.createdDepth });
      continue;
    }
    const { replaced: _r, beforeSha256: _b, snapshot: _s, ...rest } = i;
    owned.set(key(i), { ...rest, createdDepth: old.createdDepth, ...(old.replaced ? { replaced: true, beforeSha256: old.beforeSha256, snapshot: old.snapshot } : {}) });
  }
  return {
    created: prev.created,
    sha256: next.sha256,
    firstSha256: prev.firstSha256,
    backup: prev.backup,
    ...(prev.backupSha256 ? { backupSha256: prev.backupSha256 } : {}),
    ...(owned.size > 0 ? { owned: [...owned.values()] } : {}),
    ...((prev.snapshots?.length || next.snapshots?.length) ? { snapshots: [...(prev.snapshots ?? []), ...(next.snapshots ?? [])] } : {}),
    ...(next.block
      ? { block: { ...next.block, ...(prev.block ? (prev.block.replaced ? { replaced: true } : {}) : next.block.replaced ? { replaced: true } : {}) } }
      : prev.block ? { block: prev.block } : {}),
  };
}

let recorder: ((file: string, entry: WrittenConfig) => void) | undefined;
let lookup: ((file: string) => WrittenConfig | undefined) | undefined;

/**
 * Where the writer reports each file it wrote (`record`, handed only what THIS write added;
 * the store merges) and how it reads back what is already recorded (`get`). Installed once by
 * the CLI (cli.ts), never by a test, so a test that writes a config does not touch the real store.
 */
export function setWriteRecorder(record: ((file: string, entry: WrittenConfig) => void) | undefined, get?: (file: string) => WrittenConfig | undefined): void {
  recorder = record;
  lookup = get;
}

export interface SafeWriteOptions {
  /** One line to the user, stderr. Defaults to console.error. */
  note?: (line: string) => void;
  fs?: SafeFs;
  /** JSON only: end the file with a newline (default false, matching the older writers). */
  trailingNewline?: boolean;
  /** Directories at or above this are the user's own and are not checked for links. Default: the home dir. */
  root?: string;
  /** Text only: the markers of the block align manages, so undo can take just that block out. */
  markers?: { start: string; end: string };
  /** TOML only: the table (e.g. ['mcp_servers', 'align-local']) the managed block holds. */
  tomlTable?: string[];
  /** The tail of the invalid-JSON message: what to do about it. */
  invalidJsonAdvice?: string;
}

export class SafeWriteConflictError extends Error {
  constructor(file: string) {
    super(`${file} was changed by another program while align was writing it. Align left it as that program wrote it. Run the command again.`);
    this.name = 'SafeWriteConflictError';
  }
}

const invalidJson = (file: string, advice = ', then run align again'): Error => new Error(`${file} contains invalid JSON - fix it manually${advice}`);

function readCurrent(fs: SafeFs, file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw new Error(`${file} could not be read (${(err as { code?: string }).code ?? 'unknown error'}): ${(err as Error).message}`);
  }
}

function linkAt(fs: SafeFs, p: string): { path: string; target: string } | null | 'missing' {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return null;
    return { path: p, target: fs.readlinkSync(p) };
  } catch (err) {
    return (err as { code?: string }).code === 'ENOENT' ? 'missing' : null;
  }
}

/**
 * Directories at or above the root are the user's own and are not checked. A file under neither
 * the given root nor the home dir is checked from `/`, so a PI_CODING_AGENT_DIR that is itself a
 * link is caught too.
 */
function effectiveRoot(file: string, root: string | undefined): string {
  const home = os.homedir();
  for (const r of [root, home]) if (r && file.startsWith(r + path.sep)) return r;
  return path.parse(file).root;
}

/** The first symlink on the way from the root down to (and including) the file, if any. */
function symlinkOnPath(fs: SafeFs, file: string, root: string | undefined): { path: string; target: string } | null {
  const base = effectiveRoot(file, root);
  let cur = base;
  for (const seg of path.relative(base, path.dirname(file)).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    const hit = linkAt(fs, cur);
    if (hit === 'missing') break;
    // A top-level link such as /tmp or /var (macOS) is the system's, not a redirected config dir.
    if (hit && path.dirname(cur) !== path.parse(cur).root) return hit;
  }
  const hit = linkAt(fs, file);
  return hit && hit !== 'missing' ? hit : null;
}

function modeOf(fs: SafeFs, file: string): number | null {
  try {
    return fs.lstatSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

/** 'made' only when this call created the backup. Anything already at that path is not ours. */
function backupOnce(fs: SafeFs, file: string): { state: 'made' | 'foreign'; sha256?: string } {
  const backup = `${file}${BACKUP_SUFFIX}`;
  if (linkAt(fs, backup) !== 'missing') return { state: 'foreign' };
  try {
    fs.copyFileSync(file, backup, 1); // COPYFILE_EXCL
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') return { state: 'foreign' };
    throw err;
  }
  return { state: 'made', sha256: sha(fs.readFileSync(backup)) };
}

/**
 * A copy of the file as it is right now, for the case where someone changed it after align's
 * last write: the backup from before align's first write cannot hold what they added since.
 * `<file>.align-backup.<n>`, exclusive, 0600 (it may hold secrets), never overwritten.
 */
function takeSnapshot(fs: SafeFs, file: string, content: string, taken: number[]): { n: number; sha256: string } {
  for (let n = Math.max(0, ...taken) + 1; n <= MAX_SNAPSHOTS; n++) {
    const target = `${file}${BACKUP_SUFFIX}.${n}`;
    if (linkAt(fs, target) !== 'missing') continue;
    try {
      fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') continue;
      throw err;
    }
    return { n, sha256: sha(content) };
  }
  throw new Error(`${file} already has ${taken.length} snapshots from align. Run \`align use --undo\` to clear them, then try again.`);
}

/** Delete snapshots THIS call made (verified: a regular file whose hash is the one taken). */
function dropSnapshots(fs: SafeFs, file: string, list: Array<{ n: number; sha256: string }>): void {
  for (const { n, sha256: want } of list) {
    const target = `${file}${BACKUP_SUFFIX}.${n}`;
    try {
      if (fs.lstatSync(target).isFile() && sha(fs.readFileSync(target)) === want) fs.unlinkSync(target);
    } catch {
      // already gone
    }
  }
}

const MAX_SNAPSHOTS = 200;
const STALE_TMP_MS = 60_000;
/** A crash between staging and rename leaves `.<name>.<hex>.align-tmp`. Old ones are removed. */
function sweepStaleTemps(fs: SafeFs, file: string): void {
  try {
    const dir = path.dirname(file);
    const re = new RegExp(`^\\.${path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]+\\.align-tmp$`);
    for (const name of fs.readdirSync(dir)) {
      if (!re.test(name)) continue;
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isFile() && Date.now() - st.mtimeMs > STALE_TMP_MS) fs.unlinkSync(full);
    }
  } catch {
    // best effort: a directory we cannot list has nothing we can sweep
  }
}

/** Stage `text` beside `file` and rename it over. Never leaves the temp file behind on failure. */
function stageAndRename(fs: SafeFs, file: string, text: string, mode: number | null, beforeRename?: () => boolean): boolean {
  let tmp = '';
  for (let i = 0; i < 5; i++) {
    tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.align-tmp`);
    try {
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: mode ?? 0o600, flag: 'wx' });
      break;
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST' && i < 4) continue;
      throw err;
    }
  }
  try {
    if (mode !== null) fs.chmodSync(tmp, mode);
    if (beforeRename && !beforeRename()) {
      fs.unlinkSync(tmp);
      return false;
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/**
 * The managed block: the start marker and the NEXT end marker after it. null when it is missing,
 * and also when it is ambiguous (a second start, or an end before the start): a region guessed
 * across someone else's lines would take them out with it.
 */
function regionOf(text: string, markers: { start: string; end: string }): string | null {
  const s = text.indexOf(markers.start);
  if (s === -1) return null;
  const e = text.indexOf(markers.end, s + markers.start.length);
  if (e === -1) return null;
  if (text.indexOf(markers.start, s + 1) !== -1) return null;
  const firstEnd = text.indexOf(markers.end);
  if (firstEnd !== -1 && firstEnd < s) return null;
  return text.slice(s, e + markers.end.length);
}

function getAt(root: unknown, p: string[]): unknown {
  let node = root;
  for (const k of p) {
    if (!isObject(node) || !Object.hasOwn(node, k)) return undefined;
    node = node[k];
  }
  return node;
}

/** A TOML table header for exactly `path` (bare, "quoted" or 'quoted' keys, spaces around dots). */
function tomlHeader(p: string[]): RegExp {
  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const key = (k: string) => `(?:${esc(k)}|"${esc(k)}"|'${esc(k)}')`;
  return new RegExp(`^[ \\t]*\\[[ \\t]*${p.map(key).join('[ \\t]*\\.[ \\t]*')}[ \\t]*\\][ \\t]*(?:#.*)?$`, 'gm');
}

/**
 * Take one table align added out of a TOML file whose markers another program removed (Grok
 * Build re-serialises config.toml on `grok mcp add`). Only when the table is exactly what align
 * wrote, appears once as a header, and taking its lines out changes nothing else in the parsed
 * file. Returns the new text, or a line saying what to remove by hand.
 */
function removeTomlTable(cur: string, table: { path: string[]; sha256: string }): { text: string } | { why: string } {
  const name = `[${table.path.join('.')}]`;
  let before: unknown;
  try {
    before = parseToml(cur);
  } catch {
    return { why: `align's marked block is gone and the file is not valid TOML now; remove the ${name} table by hand` };
  }
  const value = getAt(before, table.path);
  if (value === undefined) return { text: cur };
  if (shaOf(value) !== table.sha256) return { why: `align's marked block is gone and ${name} was changed since align added it; remove the ${name} table by hand` };
  const headers = [...cur.matchAll(tomlHeader(table.path))];
  if (headers.length !== 1) return { why: `align's marked block is gone and align cannot find exactly one ${name} header; remove the ${name} table by hand` };
  const from = headers[0]!.index!;
  const rest = cur.slice(from + headers[0]![0].length);
  const nextHeader = /^[ \t]*\[/m.exec(rest);
  const to = nextHeader ? from + headers[0]![0].length + nextHeader.index : cur.length;
  // The cut must hold align's table lines and nothing else: no comment (a note the user put there
  // would go with it), no blank line inside the table, at most one blank line after it.
  const body = cur.slice(from + headers[0]![0].length, to).replace(/^\n/, '').split('\n');
  if (body[body.length - 1] === '') body.pop();
  let trailing = 0;
  while (trailing < body.length && body[body.length - 1 - trailing]!.trim() === '') trailing += 1;
  const inner = body.slice(0, body.length - trailing);
  if (headers[0]![0].includes('#') || inner.some((l) => l.trim() === '' || l.includes('#')) || trailing > 1) {
    return { why: `align's marked block is gone and other lines sit inside or around ${name}; remove the ${name} table by hand` };
  }
  const next = `${cur.slice(0, from)}${cur.slice(to)}`.replace(/\n{3,}/g, '\n\n');
  const expected = JSON.parse(JSON.stringify(before)) as Json;
  const parent = getAt(expected, table.path.slice(0, -1));
  if (isObject(parent)) delete parent[table.path[table.path.length - 1]!];
  let after: unknown;
  try {
    after = parseToml(next);
  } catch {
    after = undefined;
  }
  // An emptied parent table may or may not survive in the text: compare with it gone on both sides.
  const prune = (o: unknown): unknown => {
    const pp = table.path.slice(0, -1);
    const node = getAt(o, pp);
    const holder = getAt(o, pp.slice(0, -1));
    if (pp.length > 0 && isObject(node) && Object.keys(node).length === 0 && isObject(holder)) delete holder[pp[pp.length - 1]!];
    return o;
  };
  if (after === undefined || shaOf(prune(after)) !== shaOf(prune(expected))) {
    return { why: `align's marked block is gone and align cannot take ${name} out without touching your other settings; remove it by hand` };
  }
  return { text: next };
}

function blockOf(before: string | null, next: string, markers: { start: string; end: string }, tomlTable?: string[]): WrittenConfig['block'] {
  const region = regionOf(next, markers);
  if (region === null) return undefined;
  const old = before === null ? null : regionOf(before, markers);
  let table: { path: string[]; sha256: string } | undefined;
  if (tomlTable) {
    try {
      const value = getAt(parseToml(region.slice(markers.start.length)), tomlTable);
      if (value !== undefined) table = { path: tomlTable, sha256: shaOf(value) };
    } catch {
      // No table record: a lost block is then skipped by undo, never guessed at.
    }
  }
  return { start: markers.start, end: markers.end, sha256: sha(region), ...(old !== null && old !== region ? { replaced: true } : {}), ...(table ? { table } : {}) };
}

function safeWrite(
  file: string,
  compute: (current: string | null) => string | undefined,
  opts: SafeWriteOptions,
  describe?: (snapshot: number) => Pick<WrittenConfig, 'owned'>,
): SafeWriteStatus {
  const fs = opts.fs ?? realFs();
  const note = opts.note ?? ((l: string) => console.error(l));

  const link = symlinkOnPath(fs, file, opts.root);
  if (link) {
    note(link.path === file
      ? `Not writing ${file}: it is a symlink to ${link.target}, which may belong to another program. Left it alone.`
      : `Not writing ${file}: ${link.path} is a symlink to ${link.target}, so the file is really in another program's directory. Left it alone.`);
    return 'symlink';
  }

  let backup: { state: 'made' | 'foreign' | 'none'; sha256?: string } = { state: 'none' };
  const snapshots: Array<{ n: number; sha256: string }> = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = readCurrent(fs, file);
    const next = compute(before);
    if (next === undefined) return 'declined';
    if (next === before) return 'unchanged';

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    sweepStaleTemps(fs, file);
    const mode = modeOf(fs, file);
    // The first time align writes a file that exists, the original is kept. After that, if the file
    // is no longer what align last wrote (the user edited it, or added entries), a snapshot of it is
    // taken first, so a value this write replaces is never held only by the file.
    const prev = lookup?.(file);
    if (before !== null) {
      if (!prev) {
        if (backup.state === 'none') backup = backupOnce(fs, file);
      } else if (sha(before) !== prev.sha256 && !snapshots.some((x) => x.sha256 === sha(before))) {
        snapshots.push(takeSnapshot(fs, file, before, [...(prev.snapshots ?? []).map((x) => x.n), ...snapshots.map((x) => x.n)]));
      }
    }

    let staged = false;
    try {
      staged = stageAndRename(fs, file, next, mode, () => readCurrent(fs, file) === before);
    } catch (err) {
      dropSnapshots(fs, file, snapshots);
      throw err;
    }
    if (!staged) continue;
    // A snapshot stays only if a unit this write replaced or removed points at it; otherwise it
    // holds nothing the file or the first backup does not, and would just pile up.
    const lastSnap = snapshots.length > 0 ? snapshots[snapshots.length - 1]!.n : 0;
    let owned: Pick<WrittenConfig, 'owned'> = {};
    let block: WrittenConfig['block'];
    try {
      owned = describe?.(lastSnap) ?? {};
      const b = opts.markers ? blockOf(before, next, opts.markers, opts.tomlTable) : undefined;
      block = b ? { ...b, ...(b.replaced ? { snapshot: lastSnap } : {}) } : undefined;
    } catch {
      // Not knowing what we changed costs the undo, never the write.
    }
    const referenced = new Set<number>([
      ...(owned.owned ?? []).filter((i) => i.replaced).map((i) => i.snapshot ?? 0),
      ...(block?.replaced ? [block.snapshot ?? 0] : []),
    ]);
    const kept = snapshots.filter((x) => referenced.has(x.n));
    dropSnapshots(fs, file, snapshots.filter((x) => !referenced.has(x.n)));
    try {
      recorder?.(file, {
        created: before === null,
        sha256: sha(next),
        firstSha256: sha(next),
        backup: backup.state,
        ...(backup.sha256 ? { backupSha256: backup.sha256 } : {}),
        ...(kept.length > 0 ? { snapshots: kept } : {}),
        ...owned,
        ...(block ? { block } : {}),
      });
    } catch {
      // The file is written. A manifest that cannot be updated costs the undo, not the write. A
      // snapshot that holds a replaced user value is kept anyway: it may be the only copy.
    }
    return 'written';
  }
  dropSnapshots(fs, file, snapshots);
  throw new SafeWriteConflictError(file);
}

/** The text form. `compute` gets the current text (null when missing) and returns the new text, or undefined to leave it. */
export function safeWriteText(file: string, compute: (current: string | null) => string | undefined, opts: SafeWriteOptions = {}): SafeWriteStatus {
  return safeWrite(file, compute, opts);
}

/**
 * What align changed in a JSON config. Containers (the root and its direct children, such as
 * `mcpServers` or `hooks`) are walked; a server entry one level further down is a unit:
 *  - new key: one `value` item (or, under a new container, one item per new entry);
 *  - existing key whose value changed: ONE `replaced` item holding the hash of the user's value,
 *    never a diff into it (a diff into `args` would "undo" half an entry);
 *  - existing array: if align only added elements, those elements; if it REMOVED or changed any
 *    element it did not put there itself, the whole array is one `replaced` unit;
 *  - an existing key align took away: a `removed` unit.
 * `prev` is what an earlier write already recorded, so align's own earlier output is never
 * mistaken for the user's.
 */
export function ownedOf(before: Json, after: Json, prev: OwnedItem[] = [], snapshot = 0): OwnedItem[] {
  const out: OwnedItem[] = [];
  const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((x, n) => x === b[n]);
  const ownsValue = (p: string[], h: string) => prev.some((i) => i.kind === 'value' && samePath(i.path, p) && i.sha256 === h);
  const ownsElement = (p: string[], h: string) => prev.some((i) => i.kind === 'array-item' && samePath(i.path, p) && i.sha256 === h);
  const addItems = (here: string[], bv: unknown[], av: unknown[], createdAt: number): void => {
    const remaining = new Map<string, number>();
    for (const x of bv) remaining.set(shaOf(x), (remaining.get(shaOf(x)) ?? 0) + 1);
    for (const x of av) {
      const h = shaOf(x);
      if ((remaining.get(h) ?? 0) > 0) remaining.set(h, remaining.get(h)! - 1);
      else out.push({ path: here, kind: 'array-item', sha256: h, createdDepth: createdAt });
    }
  };
  /** Elements of `bv` that `av` no longer has and that align did not put there. */
  const userElementsLost = (here: string[], bv: unknown[], av: unknown[]): boolean => {
    const remaining = new Map<string, number>();
    for (const x of av) remaining.set(shaOf(x), (remaining.get(shaOf(x)) ?? 0) + 1);
    return bv.some((x) => {
      const h = shaOf(x);
      if ((remaining.get(h) ?? 0) > 0) { remaining.set(h, remaining.get(h)! - 1); return false; }
      return !ownsElement(here, h);
    });
  };
  const walk = (b: Json | undefined, a: Json, p: string[], created: number | null): void => {
    for (const [k, av] of Object.entries(a)) {
      const here = [...p, k];
      const has = b !== undefined && Object.prototype.hasOwnProperty.call(b, k);
      const bv = has ? b![k] : undefined;
      const createdAt = created ?? (has ? null : here.length);
      if (has && shaOf(av) === shaOf(bv)) continue;
      if (isObject(av) && Object.keys(av).length > 0 && here.length < 2 && (!has || isObject(bv))) {
        walk(has ? (bv as Json) : undefined, av, here, createdAt);
      } else if (has && ownsValue(here, shaOf(bv))) {
        // exactly what align wrote last time: the hash moves, and nothing here is the user's
        out.push({ path: here, kind: 'value', sha256: shaOf(av), createdDepth: here.length });
      } else if (Array.isArray(av) && (!has || Array.isArray(bv)) && !(has && userElementsLost(here, bv as unknown[], av))) {
        // An array that already existed is not pruned when emptied (it was there before align).
        addItems(here, has ? (bv as unknown[]) : [], av, createdAt ?? here.length + 1);
      } else if (!has) {
        out.push({ path: here, kind: 'value', sha256: shaOf(av), createdDepth: createdAt ?? here.length });
      } else {
        // The user's value: without the elements align itself put in an array on an earlier write.
        const was = Array.isArray(bv) ? bv.filter((x) => !ownsElement(here, shaOf(x))) : bv;
        out.push({ path: here, kind: 'value', sha256: shaOf(av), createdDepth: here.length, replaced: true, beforeSha256: shaOf(was), snapshot });
      }
    }
    for (const k of Object.keys(b ?? {})) {
      const here = [...p, k];
      if (Object.prototype.hasOwnProperty.call(a, k) || prev.some((i) => samePath(i.path.slice(0, here.length), here))) continue;
      out.push({ path: here, kind: 'value', sha256: '', createdDepth: here.length, replaced: true, removed: true, beforeSha256: shaOf(b![k]), snapshot });
    }
  };
  walk(before, after, [], null);
  return out;
}

/**
 * The JSON form. `update` gets the parsed object ({} for a missing or empty file) and returns
 * the object to write, or undefined to leave the file alone. A file that does not parse is an
 * error, never overwritten.
 */
export function safeWriteJson(file: string, update: (current: Json) => Json | undefined, opts: SafeWriteOptions = {}): SafeWriteStatus {
  let beforeObj: Json = {};
  let afterObj: Json = {};
  return safeWrite(
    file,
    (raw) => {
      let cur: Json = {};
      if (raw !== null && raw.trim()) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!isObject(parsed)) throw new Error('not an object');
          cur = parsed;
        } catch {
          throw invalidJson(file, opts.invalidJsonAdvice);
        }
      }
      beforeObj = JSON.parse(JSON.stringify(cur)) as Json;
      const next = update(cur);
      if (next === undefined) return undefined;
      afterObj = next;
      return JSON.stringify(next, null, 2) + (opts.trailingNewline ? '\n' : '');
    },
    opts,
    (snapshot) => ({ owned: ownedOf(beforeObj, afterObj, lookup?.(file)?.owned, snapshot) }),
  );
}

export interface UndoReport {
  /** Whole file put back from align's own backup. */
  restored: string[];
  /** A file align created, removed (it still held exactly what align wrote). */
  removed: string[];
  /** Only align's own entries taken out; the rest of the file kept. */
  cleaned: string[];
  /** Files left as they are, one line each, with what to do by hand. */
  skipped: string[];
  /** The manifest entries that are finished. Skipped files are NOT in here. */
  done: string[];
}

const pathText = (i: OwnedItem) => i.path.join('.');

/**
 * Remove align's own items from parsed JSON, and put back the user's value for each key align
 * overwrote (`original` is the parsed trusted backup, or null). Works on `cur` in place and
 * returns the lines for items it could not handle; the caller writes nothing if there are any.
 */
function removeOwned(cur: Json, owned: OwnedItem[], originalOf: (snapshot: number) => Json | null, backupPath: string): string[] {
  const left: string[] = [];
  const walkTo = (root: Json, p: string[]): Json | undefined => {
    let node: unknown = root;
    for (const seg of p.slice(0, -1)) {
      if (!isObject(node)) return undefined;
      node = node[seg];
    }
    return isObject(node) ? node : undefined;
  };
  // Units the user's value was taken from go first: their hash check needs the array as align left it.
  for (const i of [...owned].sort((x, y) => Number(!!y.replaced) - Number(!!x.replaced))) {
    const parent = walkTo(cur, i.path);
    const key = i.path[i.path.length - 1]!;
    if (i.removed) {
      const was = walkTo(originalOf(i.snapshot ?? 0) ?? {}, i.path)?.[key];
      if (parent && key in parent) {
        if (shaOf(parent[key]) !== i.beforeSha256) left.push(`${pathText(i)} was yours, align removed it, and it is back with different content; check it by hand`);
      } else if (!parent || was === undefined || shaOf(was) !== i.beforeSha256) {
        left.push(`${pathText(i)} was yours and align removed it; align cannot restore it from ${backupPath} (missing or changed). Put the original back by hand`);
      } else {
        parent[key] = JSON.parse(JSON.stringify(was)) as unknown;
      }
      continue;
    }
    if (!parent || !(key in parent)) continue; // already gone
    if (i.kind === 'array-item') {
      const arr = parent[key];
      const at = Array.isArray(arr) ? arr.findIndex((x) => shaOf(x) === i.sha256) : -1;
      if (at >= 0) (arr as unknown[]).splice(at, 1);
      continue;
    }
    if (i.path.length === 1 && i.path[0] === 'version' && !i.replaced && !isObject(parent[key]) && !Array.isArray(parent[key])) continue; // structural: decided below
    if (shaOf(parent[key]) !== i.sha256) {
      left.push(`${pathText(i)} was edited since align wrote it; change it by hand if you want it gone`);
      continue;
    }
    if (!i.replaced) {
      delete parent[key];
      continue;
    }
    const was = walkTo(originalOf(i.snapshot ?? 0) ?? {}, i.path)?.[key];
    if (was === undefined || shaOf(was) !== i.beforeSha256) {
      left.push(`${pathText(i)} was your own entry and align replaced it; align cannot restore it from ${backupPath} (missing or changed). Put the original back by hand`);
      continue;
    }
    parent[key] = JSON.parse(JSON.stringify(was)) as unknown;
  }
  // Parents align created go too, once empty.
  for (const i of owned) {
    if (i.replaced) continue;
    // An array-item's own array is a candidate too: it was created with the entry that held it.
    for (let depth = i.path.length - (i.kind === 'array-item' ? 0 : 1); depth >= i.createdDepth; depth--) {
      const nodePath = i.path.slice(0, depth);
      const parent = walkTo(cur, nodePath);
      const node = parent?.[nodePath[depth - 1]!];
      const empty = Array.isArray(node) ? node.length === 0 : isObject(node) && Object.keys(node).length === 0;
      if (parent && empty) delete parent[nodePath[depth - 1]!];
      else break;
    }
  }
  // A structural key align added (`version` in a hooks file) goes only when nothing of the user's
  // is left beside it: on its own it is what a hooks reader needs to accept their entries.
  const structural = owned.filter((i) => i.path.length === 1 && i.path[0] === 'version' && i.kind === 'value' && !i.replaced && !i.removed && !isObject(cur[i.path[0]!]) && !Array.isArray(cur[i.path[0]!]));
  const keys = new Set(structural.map((i) => i.path[0]!));
  if (structural.length > 0 && Object.keys(cur).every((k) => keys.has(k))) {
    for (const i of structural) {
      if (shaOf(cur[i.path[0]!]) === i.sha256) delete cur[i.path[0]!];
      else left.push(`${pathText(i)} was edited since align wrote it; change it by hand if you want it gone`);
    }
  }
  return left;
}

/**
 * Take align back out of every recorded file.
 *  - If the file still holds exactly what align last wrote, the whole file goes back: a file
 *    align created is removed, any other comes back from align's own backup (a regular file
 *    align made, whose hash matches; anything else at that path is not trusted).
 *  - Otherwise the user has touched it since, and only align's own entries come out. An entry
 *    the user edited, or one align overwrote, is left and named.
 * Skipped files keep their manifest entry and their backup.
 */
export function undoWrittenConfigs(manifest: Record<string, WrittenConfig>, fs: SafeFs = realFs()): UndoReport {
  const report: UndoReport = { restored: [], removed: [], cleaned: [], skipped: [], done: [] };
  for (const [file, entry] of Object.entries(manifest)) {
    const backupPath = `${file}${BACKUP_SUFFIX}`;
    const link = linkAt(fs, file);
    if (link && link !== 'missing') {
      report.skipped.push(`${file}: it is a symlink to ${link.target}, left alone`);
      continue;
    }
    const cur = readCurrent(fs, file);
    if (cur === null) {
      report.done.push(file); // already gone: nothing of align's is left
      continue;
    }

    // The first backup (0) and the snapshots (1..n): each is trusted only when it is a regular file
    // whose hash is the one align recorded when it made it.
    const snapPath = (n: number): string => (n === 0 ? backupPath : `${backupPath}.${n}`);
    const snapText = (n: number): string | null => {
      const want = n === 0 ? (entry.backup === 'made' ? entry.backupSha256 : undefined) : entry.snapshots?.find((x) => x.n === n)?.sha256;
      if (!want) return null;
      try {
        if (!fs.lstatSync(snapPath(n)).isFile()) return null;
        const bytes = fs.readFileSync(snapPath(n));
        return sha(bytes) === want ? bytes.toString('utf8') : null;
      } catch {
        return null;
      }
    };
    const backupTrusted = (): boolean => snapText(0) !== null;
    /** Only after a fully clean undo, and only copies that are still align's own. */
    const dropBackup = () => {
      for (const n of [0, ...(entry.snapshots ?? []).map((x) => x.n)]) {
        try { if (snapText(n) !== null) fs.unlinkSync(snapPath(n)); } catch { /* gone */ }
      }
    };

    // Whole-file only when align wrote this file exactly once and nobody has touched it since.
    if (sha(cur) === entry.sha256 && entry.firstSha256 === entry.sha256) {
      if (entry.created) {
        fs.unlinkSync(file);
        report.removed.push(file);
        report.done.push(file);
        continue;
      }
      if (backupTrusted()) {
        const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.align-tmp`);
        fs.copyFileSync(backupPath, tmp, 1);
        fs.renameSync(tmp, file);
        dropBackup();
        report.restored.push(file);
        report.done.push(file);
        continue;
      }
    }

    // Surgical: only align's own entries, and the user's own values back where align overwrote them.
    const mention = entry.backup === 'foreign' ? `; ${backupPath} was not made by align, so it was not used` : '';
    let next: string | undefined;
    const left: string[] = [];
    if (entry.block) {
      const region = regionOf(cur, entry.block);
      if (region === null) {
        // The block is gone or ambiguous: another program rewrote the file, or the user edited it.
        // Never "cleaned" on a guess: take out a recorded TOML table only when it is provably
        // align's, otherwise keep the record and the backup and say what to remove.
        const r = entry.block.table ? removeTomlTable(cur, entry.block.table) : { why: `align's marked block (${entry.block.start} ... ${entry.block.end}) is no longer intact in the file, so align cannot tell what to take out. Remove what align added there by hand` };
        if ('text' in r) next = r.text;
        else {
          next = cur;
          left.push(r.why);
        }
      } else if (sha(region) !== entry.block.sha256) {
        next = cur;
        left.push('the block align manages was edited since align wrote it; remove it by hand');
      } else {
        const s0 = cur.indexOf(entry.block.start);
        let replacement = '';
        if (entry.block.replaced) {
          const was = snapText(entry.block.snapshot ?? 0);
          const old = was === null ? null : regionOf(was, entry.block);
          if (old === null) left.push(`the block align replaced was yours and align cannot restore it from ${backupPath} (missing or changed). Put the original back by hand`);
          else replacement = old;
        }
        next = replacement
          ? `${cur.slice(0, s0)}${replacement}${cur.slice(s0 + region.length)}`
          : `${cur.slice(0, s0)}${cur.slice(s0 + region.length)}`.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '');
      }
    } else if (entry.owned && entry.owned.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(cur);
      } catch {
        parsed = undefined;
      }
      if (!isObject(parsed)) {
        report.skipped.push(`${file}: it is not valid JSON now, so align cannot edit it. Remove by hand: ${entry.owned.map(pathText).join(', ')}${mention}`);
        continue;
      }
      const cache = new Map<number, Json | null>();
      const originalOf = (n: number): Json | null => {
        if (!cache.has(n)) {
          let parsedCopy: Json | null = null;
          try {
            const o: unknown = JSON.parse(snapText(n) ?? 'null');
            parsedCopy = isObject(o) ? o : null;
          } catch {
            parsedCopy = null;
          }
          cache.set(n, parsedCopy);
        }
        return cache.get(n) ?? null;
      };
      left.push(...removeOwned(parsed, entry.owned, originalOf, backupPath));
      next = JSON.stringify(parsed, null, 2) + (cur.endsWith('\n') ? '\n' : '');
      // Once align's entries are out, a file that means exactly what the original meant gets the
      // original's bytes back (align's own refreshes made the whole-file path unavailable, and a
      // re-serialisation would change the user's formatting).
      const original = snapText(0);
      if (original !== null && left.length === 0) {
        try {
          if (JSON.stringify(JSON.parse(original)) === JSON.stringify(parsed)) next = original;
        } catch {
          // the original is not JSON: keep the re-serialised text
        }
      }
    } else {
      report.skipped.push(`${file}: align has no record of what it added here. Remove its entries by hand${mention}`);
      continue;
    }
    // All or nothing: a file with anything left in it is not touched at all.
    if (left.length > 0) {
      for (const l of left) report.skipped.push(`${file}: ${l}${mention}`);
      continue;
    }
    // A file align created that holds nothing but align's own content once that is out: remove it, as
    // an untouched one is.
    if (entry.created && entry.owned && !entry.block && next.trim() === '{}') {
      fs.unlinkSync(file);
      dropBackup();
      report.removed.push(file);
      report.done.push(file);
      continue;
    }
    if (next !== cur) stageAndRename(fs, file, next, modeOf(fs, file));
    dropBackup();
    report.cleaned.push(file);
    report.done.push(file);
  }
  return report;
}
