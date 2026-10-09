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
  /** Text files: the managed block align wrote. */
  block?: { start: string; end: string; sha256: string; /** a block was already there, and align's replaced it: the original is in the backup */ replaced?: boolean };
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
    const { replaced: _r, beforeSha256: _b, ...rest } = i;
    owned.set(key(i), { ...rest, createdDepth: old.createdDepth, ...(old.replaced ? { replaced: true, beforeSha256: old.beforeSha256 } : {}) });
  }
  return {
    created: prev.created,
    sha256: next.sha256,
    firstSha256: prev.firstSha256,
    backup: prev.backup,
    ...(prev.backupSha256 ? { backupSha256: prev.backupSha256 } : {}),
    ...(owned.size > 0 ? { owned: [...owned.values()] } : {}),
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

function regionOf(text: string, markers: { start: string; end: string }): string | null {
  const s = text.indexOf(markers.start);
  const e = text.indexOf(markers.end);
  return s === -1 || e === -1 || e < s ? null : text.slice(s, e + markers.end.length);
}

function blockOf(before: string | null, next: string, markers: { start: string; end: string }): WrittenConfig['block'] {
  const region = regionOf(next, markers);
  if (region === null) return undefined;
  const old = before === null ? null : regionOf(before, markers);
  return { start: markers.start, end: markers.end, sha256: sha(region), ...(old !== null && old !== region ? { replaced: true } : {}) };
}

function safeWrite(
  file: string,
  compute: (current: string | null) => string | undefined,
  opts: SafeWriteOptions,
  describe?: () => Pick<WrittenConfig, 'owned'>,
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = readCurrent(fs, file);
    const next = compute(before);
    if (next === undefined) return 'declined';
    if (next === before) return 'unchanged';

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    sweepStaleTemps(fs, file);
    const mode = modeOf(fs, file);
    // A file align created has no pre-Align state to keep.
    if (before !== null && backup.state === 'none' && !lookup?.(file)?.created) backup = backupOnce(fs, file);

    if (!stageAndRename(fs, file, next, mode, () => readCurrent(fs, file) === before)) continue;
    try {
      recorder?.(file, {
        created: before === null,
        sha256: sha(next),
        firstSha256: sha(next),
        backup: backup.state,
        ...(backup.sha256 ? { backupSha256: backup.sha256 } : {}),
        ...describe?.(),
        ...(opts.markers && blockOf(before, next, opts.markers) ? { block: blockOf(before, next, opts.markers)! } : {}),
      });
    } catch {
      // The file is written. A manifest that cannot be updated costs the undo, not the write.
    }
    return 'written';
  }
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
export function ownedOf(before: Json, after: Json, prev: OwnedItem[] = []): OwnedItem[] {
  const out: OwnedItem[] = [];
  const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((x, n) => x === b[n]);
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
      } else if (Array.isArray(av) && (!has || Array.isArray(bv)) && !(has && userElementsLost(here, bv as unknown[], av))) {
        // An array that already existed is not pruned when emptied (it was there before align).
        addItems(here, has ? (bv as unknown[]) : [], av, createdAt ?? here.length + 1);
      } else if (!has) {
        out.push({ path: here, kind: 'value', sha256: shaOf(av), createdDepth: createdAt ?? here.length });
      } else {
        // The user's value: without the elements align itself put in an array on an earlier write.
        const was = Array.isArray(bv) ? bv.filter((x) => !ownsElement(here, shaOf(x))) : bv;
        out.push({ path: here, kind: 'value', sha256: shaOf(av), createdDepth: here.length, replaced: true, beforeSha256: shaOf(was) });
      }
    }
    for (const k of Object.keys(b ?? {})) {
      const here = [...p, k];
      if (Object.prototype.hasOwnProperty.call(a, k) || prev.some((i) => samePath(i.path.slice(0, here.length), here))) continue;
      out.push({ path: here, kind: 'value', sha256: '', createdDepth: here.length, replaced: true, removed: true, beforeSha256: shaOf(b![k]) });
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
    () => ({ owned: ownedOf(beforeObj, afterObj, lookup?.(file)?.owned) }),
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
function removeOwned(cur: Json, owned: OwnedItem[], original: Json | null, backupPath: string): string[] {
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
      const was = original ? walkTo(original, i.path)?.[key] : undefined;
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
    if (shaOf(parent[key]) !== i.sha256) {
      left.push(`${pathText(i)} was edited since align wrote it; change it by hand if you want it gone`);
      continue;
    }
    if (!i.replaced) {
      delete parent[key];
      continue;
    }
    const was = original ? walkTo(original, i.path)?.[key] : undefined;
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

    const backupTrusted = (): boolean => {
      if (entry.backup !== 'made' || !entry.backupSha256) return false;
      try {
        return fs.lstatSync(backupPath).isFile() && sha(fs.readFileSync(backupPath)) === entry.backupSha256;
      } catch {
        return false;
      }
    };
    const dropBackup = () => { try { if (entry.backup === 'made' && linkAt(fs, backupPath) === null) fs.unlinkSync(backupPath); } catch { /* gone */ } };

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
        fs.unlinkSync(backupPath);
        report.restored.push(file);
        report.done.push(file);
        continue;
      }
    }

    // Surgical: only align's own entries, and the user's own values back where align overwrote them.
    const mention = entry.backup === 'foreign' ? `; ${backupPath} was not made by align, so it was not used` : '';
    const backupText = (): string | null => {
      if (!backupTrusted()) return null;
      try { return fs.readFileSync(backupPath, 'utf8'); } catch { return null; }
    };
    let next: string | undefined;
    const left: string[] = [];
    if (entry.block) {
      const region = regionOf(cur, entry.block);
      if (region === null) next = cur;
      else if (sha(region) !== entry.block.sha256) {
        next = cur;
        left.push('the block align manages was edited since align wrote it; remove it by hand');
      } else {
        const s0 = cur.indexOf(entry.block.start);
        let replacement = '';
        if (entry.block.replaced) {
          const was = backupText();
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
      let original: Json | null = null;
      if (entry.owned.some((i) => i.replaced)) {
        try {
          const o: unknown = JSON.parse(backupText() ?? 'null');
          original = isObject(o) ? o : null;
        } catch {
          original = null;
        }
      }
      left.push(...removeOwned(parsed, entry.owned, original, backupPath));
      next = JSON.stringify(parsed, null, 2) + (cur.endsWith('\n') ? '\n' : '');
    } else {
      report.skipped.push(`${file}: align has no record of what it added here. Remove its entries by hand${mention}`);
      continue;
    }
    // All or nothing: a file with anything left in it is not touched at all.
    if (left.length > 0) {
      for (const l of left) report.skipped.push(`${file}: ${l}${mention}`);
      continue;
    }
    if (next !== cur) stageAndRename(fs, file, next, modeOf(fs, file));
    dropBackup();
    report.cleaned.push(file);
    report.done.push(file);
  }
  return report;
}
