/**
 * Read a small file the launch path does not control (the state directory is writable by anything running as the user,
 * so a FIFO or a link can sit where a file is expected). Opens without following a link and without blocking, requires a
 * REGULAR file, and caps the size. Anything else reads as "not there": the launcher then does nothing, and never hangs.
 */
import fs from 'node:fs';

export function readRegularFile(file: string, maxBytes = 1_048_576): string | undefined {
  let fd: number | undefined;
  try {
    // Read inside the function, not at import: this module is on the launch path.
    const C = fs.constants;
    fd = fs.openSync(file, C.O_RDONLY | (C.O_NONBLOCK ?? 0) | (C.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to close */ } }
  }
}

/** What is at this path: 'none', a regular file, or something else (a directory, a FIFO, a link) that a claim must not be built on. */
export function kindAt(file: string): 'none' | 'file' | 'other' {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? 'file' : 'other';
  } catch (e) {
    return (e as { code?: string }).code === 'ENOENT' ? 'none' : 'other';
  }
}
