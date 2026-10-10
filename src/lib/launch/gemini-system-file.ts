import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Gemini CLI's rule for a SYSTEM settings or system-defaults file (0.63.0,
 * isFileAndDirectorySecureSync in its bundle): the file is read only when the file AND every
 * directory above it is owned by root (uid 0) and not writable by group or others, and no
 * symlink on the way is owned by anyone else. Otherwise Gemini skips it with
 * "Security Warning: Skipping system settings file ... not owned by root".
 *
 * Nothing under a user's home or cache dir can pass, so align can never hand Gemini a system
 * tier file of its own. align reads the same rule only to know which of the machine's real
 * system files Gemini will load, so a rejected one is not mistaken for config that applies.
 *
 * Returns why Gemini rejects the file, or null when it will read it (or the file does not
 * exist, which Gemini does not check). Not judged on win32: Gemini checks ACLs through
 * PowerShell there, and a wrong "rejected" would hide a file that is loaded.
 */
export function geminiSystemFileRejection(file: string, platform: string): string | null {
  if (platform === 'win32' || !existsSync(file)) return null;
  const abs = path.resolve(file);
  let canonical = abs;
  try {
    canonical = realpathSync(abs);
  } catch {
    // keep the lexical path
  }
  const paths = new Set<string>();
  for (const p of [abs, canonical]) {
    paths.add(p);
    for (let dir = path.dirname(p); ; dir = path.dirname(dir)) {
      paths.add(dir);
      if (path.dirname(dir) === dir) break;
    }
  }
  for (const p of paths) {
    try {
      const link = lstatSync(p);
      if (link.isSymbolicLink() && link.uid !== 0) return `symlink ${p} is not owned by root`;
      const st = statSync(p);
      if (st.uid !== 0) return `${p} is not owned by root`;
      if ((st.mode & 0o022) !== 0) return `${p} is writable by group or others`;
    } catch {
      return `${p} could not be checked`;
    }
  }
  return null;
}
