import { existsSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

/**
 * The file the outro's "what was decided about <file>?" names: the one changed most often in
 * recent history, so it is the file the user is most likely to touch next. The graph records
 * no file per decision, so git is the source.
 *
 * Best effort by design, like first-decision.ts: no git, a shallow clone or a slow repo is no
 * file, and the outro leaves that prompt out.
 */

/** How far back to count. Enough to find the busy file, cheap on a large repo. */
const HOT_FILE_COMMITS = 200;

/** Release bookkeeping, docs and tests change often and are not where design lives. */
const NOT_DESIGN = [
  /(^|\/)(package-lock\.json|package\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock|uv\.lock)$/,
  /(^|\/)\.?release-please[^/]*$/,
  /\.(md|mdx|txt|rst)$/i,
  /(^|\/)(__tests__|tests?|spec)\//,
  /\.(test|spec)\.[^/]+$/,
];

export function pickHotFile(names: readonly string[], exists: (file: string) => boolean): string | undefined {
  const counts = new Map<string, number>();
  for (const name of names) {
    if (NOT_DESIGN.some((re) => re.test(name))) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  // Map keeps insertion order and `git log` lists newest first, so a tie goes to the most recent.
  let best: string | undefined;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount && exists(name)) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

export async function getHotFile(opts: { cwd?: string } = {}): Promise<string | undefined> {
  const cwd = opts.cwd ?? process.cwd();
  try {
    const { stdout: root } = await execa('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 3000 });
    const { stdout } = await execa(
      'git',
      ['log', `-n${HOT_FILE_COMMITS}`, '--no-merges', '--name-only', '--pretty=format:'],
      { cwd, timeout: 3000 },
    );
    const names = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    return pickHotFile(names, (file) => existsSync(path.join(root.trim(), file)));
  } catch {
    return undefined;
  }
}
