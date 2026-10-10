import path from 'node:path';
import { fileHasBlock } from './layer-files.js';

/**
 * Whether a file the user already hands Aider with `--read` (either spelling, relative to the
 * cwd) carries Align's managed instructions block, in which case Align adds no second copy.
 */
export function aiderReadHasBlock(cwd: string, passthrough: string[]): boolean {
  const files: string[] = [];
  for (let i = 0; i < passthrough.length; i++) {
    const a = passthrough[i]!;
    if (a === '--') break;
    if (a === '--read' && passthrough[i + 1] !== undefined) files.push(passthrough[++i]!);
    else if (a.startsWith('--read=')) files.push(a.slice('--read='.length));
  }
  return files.some((f) => fileHasBlock(path.resolve(cwd, f)));
}
