import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/*
 * The one way align writes to a config file that belongs to someone else (an agent's MCP
 * config, its hook file). Four promises, each of which a plain writeFileSync breaks:
 *  1. The FIRST content is kept in `<file>.align-backup` and never overwritten, so
 *     `align use --undo` can put the file back byte for byte.
 *  2. The file is re-read after our new content is staged. If another program changed it in
 *     the meantime we recompute once from what is there now, and give up if it moves again:
 *     a lost update is worse than a skipped one.
 *  3. The new content lands by temp file + rename, keeping the old file's mode, so a reader
 *     never sees half a file.
 *  4. It never writes through a symlink. A link in an agent dir usually points at another
 *     product's config (~/.pi/agent/mcp.json -> ~/.clank/agent/mcp.json); writing "pi's" file
 *     would edit that other product.
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
}

// Built on use, not at import: a test that mocks node:fs with a few names must still be able
// to import anything that reaches this module.
const realFs = (): SafeFs => ({ readFileSync, writeFileSync, renameSync, copyFileSync, lstatSync, readlinkSync, chmodSync, unlinkSync, mkdirSync });

/** One file align wrote, as the manifest remembers it. */
export interface WrittenConfig {
  /** True when the file did not exist before align's first write: undo removes it instead of restoring. */
  created: boolean;
  /** sha256 of the content align last wrote, so undo never deletes a created file the user has since edited. */
  sha256: string;
}

let recorder: ((file: string, entry: WrittenConfig) => void) | undefined;

/**
 * Where the writer reports each file it wrote. Installed once by the CLI (cli.ts), never by
 * a test, so a test that writes a config does not touch the real config store.
 */
export function setWriteRecorder(fn: ((file: string, entry: WrittenConfig) => void) | undefined): void {
  recorder = fn;
}

export interface SafeWriteOptions {
  /** One line to the user, stderr. Defaults to console.error. */
  note?: (line: string) => void;
  fs?: SafeFs;
  /** JSON only: end the file with a newline (default false, matching the older writers). */
  trailingNewline?: boolean;
}

type Json = Record<string, unknown>;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export class SafeWriteConflictError extends Error {
  constructor(file: string) {
    super(`${file} was changed by another program while align was writing it. Align left it as that program wrote it. Run the command again.`);
    this.name = 'SafeWriteConflictError';
  }
}

function readCurrent(fs: SafeFs, file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw new Error(`${file} could not be read (${(err as { code?: string }).code ?? 'unknown error'}): ${(err as Error).message}`);
  }
}

function symlinkTarget(fs: SafeFs, file: string): string | null {
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return null;
    return fs.readlinkSync(file);
  } catch {
    return null; // missing (or unreadable): not a link we can name
  }
}

function modeOf(fs: SafeFs, file: string): number | null {
  try {
    return fs.lstatSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

function backupOnce(fs: SafeFs, file: string): void {
  const backup = `${file}${BACKUP_SUFFIX}`;
  try {
    // COPYFILE_EXCL: if a backup exists it is the FIRST one, and it stays.
    fs.copyFileSync(file, backup, 1);
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') return;
    throw err;
  }
}

/**
 * The text form. `compute` gets the current text (null when the file is missing) and returns
 * the new text, or undefined to leave the file alone (status `declined`).
 */
export function safeWriteText(
  file: string,
  compute: (current: string | null) => string | undefined,
  opts: SafeWriteOptions = {},
): SafeWriteStatus {
  const fs = opts.fs ?? realFs();
  const note = opts.note ?? ((l: string) => console.error(l));

  const target = symlinkTarget(fs, file);
  if (target !== null) {
    note(`Not writing ${file}: it is a symlink to ${target}, which may belong to another program. Left it alone.`);
    return 'symlink';
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const before = readCurrent(fs, file);
    const next = compute(before);
    if (next === undefined) return 'declined';
    if (next === before) return 'unchanged';

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mode = modeOf(fs, file);
    if (before !== null) backupOnce(fs, file);

    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.align-tmp`);
    fs.writeFileSync(tmp, next, 'utf8');
    if (mode !== null) fs.chmodSync(tmp, mode);

    if (readCurrent(fs, file) !== before) {
      fs.unlinkSync(tmp);
      continue;
    }
    fs.renameSync(tmp, file);
    try {
      recorder?.(file, { created: before === null, sha256: sha256(next) });
    } catch {
      // The file is written. A manifest that cannot be updated costs the undo, not the write.
    }
    return 'written';
  }
  throw new SafeWriteConflictError(file);
}

/**
 * The JSON form. `update` gets the parsed object ({} for a missing or empty file) and returns
 * the object to write, or undefined to leave the file alone. A file that does not parse is an
 * error, never overwritten.
 */
export function safeWriteJson(
  file: string,
  update: (current: Json) => Json | undefined,
  opts: SafeWriteOptions = {},
): SafeWriteStatus {
  return safeWriteText(
    file,
    (raw) => {
      let cur: Json = {};
      if (raw !== null && raw.trim()) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
          cur = parsed as Json;
        } catch {
          throw new Error(`${file} contains invalid JSON - fix it manually before running align mcp --setup`);
        }
      }
      const next = update(cur);
      if (next === undefined) return undefined;
      return JSON.stringify(next, null, 2) + (opts.trailingNewline ? '\n' : '');
    },
    opts,
  );
}

export interface UndoReport {
  restored: string[];
  removed: string[];
  /** Files left as they are, with the reason, one line each. */
  skipped: string[];
}

/**
 * Put every recorded file back. Existing files come back from `<file>.align-backup`, byte
 * for byte (via temp + rename, and never through a symlink). A file align created is removed
 * only if it still holds exactly what align wrote.
 */
export function undoWrittenConfigs(manifest: Record<string, WrittenConfig>, fs: SafeFs = realFs()): UndoReport {
  const report: UndoReport = { restored: [], removed: [], skipped: [] };
  for (const [file, entry] of Object.entries(manifest)) {
    const link = symlinkTarget(fs, file);
    if (link !== null) {
      report.skipped.push(`${file}: it is a symlink to ${link}, left alone`);
      continue;
    }
    if (entry.created) {
      const cur = readCurrent(fs, file);
      if (cur === null) continue;
      if (sha256(cur) !== entry.sha256) {
        report.skipped.push(`${file}: edited since align created it, left alone`);
        continue;
      }
      fs.unlinkSync(file);
      report.removed.push(file);
      continue;
    }
    const backup = `${file}${BACKUP_SUFFIX}`;
    try {
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.align-tmp`);
      fs.copyFileSync(backup, tmp);
      fs.renameSync(tmp, file);
      fs.unlinkSync(backup);
      report.restored.push(file);
    } catch (err) {
      const why = (err as { code?: string }).code === 'ENOENT' ? 'no backup found' : (err as Error).message;
      report.skipped.push(`${file}: ${why}`);
    }
  }
  return report;
}
