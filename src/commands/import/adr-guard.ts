import type { Command } from 'commander';
import { execa } from 'execa';
import chalk from 'chalk';
import * as p from '@clack/prompts';
import path from 'node:path';
import { subcommandOpts } from '../../lib/command-opts.js';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { AdrGuardFileError, readAdrGuardExport } from '../../lib/fetchers/adr-guard.js';
import { confirmAdrGuardLinks } from '../../lib/adr-guard-links.js';
import { buildBlobUrl, getCurrentBranch, getRemoteUrl, getRepoRoot } from '../../lib/git.js';
import { defaultJudge } from '../../lib/curation/judge.js';
import { getLocalDbPath } from '../../lib/local-mode.js';
import { commandIntro } from '../../lib/brand.js';
import { SYNC_CEILINGS } from '../../lib/import-defaults.js';

interface AdrGuardImportOpts {
  file?: string;
  limit: string;
  env?: EnvName;
}

/** Local branches and origin's, by short name: what may sit between `/blob/` and a path in an ADR's URL. */
async function branchNames(root: string): Promise<Set<string>> {
  try {
    const { stdout } = await execa('git', ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], { cwd: root });
    return new Set(stdout.split('\n').map((r) => r.replace(/^refs\/(heads|remotes\/origin)\//, '')).filter((r) => r && r !== 'HEAD'));
  } catch {
    return new Set();
  }
}

/** Where `adr-guard export relationships` writes by default, relative to the repository root. */
export const ADR_GUARD_EXPORT = '.adr-guard/relationships.json';

export function registerImportAdrGuardCommand(importCmd: Command): void {
  importCmd
    .command('adr-guard')
    .description('Record which ADRs replaced which, from an ADR Guard relationships export (run align connect docs first)')
    .option('--file <path>', `The export to read (default: ${ADR_GUARD_EXPORT} in this repository)`)
    .option('--limit <n>', 'Max replacements to record', String(SYNC_CEILINGS['adr-guard']))
    .option('--env <env>', 'Environment')
    .action(async (_opts: AdrGuardImportOpts, cmd: Command) => {
      const opts = subcommandOpts<AdrGuardImportOpts>(cmd);
      const env = createConfigStore().getEnvironment(resolveImportEnv(opts.env));
      p.intro(commandIntro('align connect adr-guard'));

      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        console.error(chalk.red(`align connect adr-guard: --limit must be a positive whole number, not "${opts.limit}".`));
        process.exit(1);
      }
      // The export's paths are relative to the repository it was written in, so that is the one read.
      const root = await getRepoRoot({ cwd: opts.file ? path.dirname(path.resolve(opts.file)) : process.cwd() });
      if (!root) {
        console.error(chalk.red('align connect adr-guard: run this inside the repository whose ADRs ADR Guard exported, or pass --file from inside it.'));
        process.exit(1);
      }
      const file = opts.file ? path.resolve(opts.file) : path.join(root, ADR_GUARD_EXPORT);
      let read;
      try {
        read = await readAdrGuardExport(file);
      } catch (e) {
        if (!(e instanceof AdrGuardFileError)) throw e;
        console.error(chalk.red(`align connect adr-guard: ${e.message}`));
        process.exit(1);
      }

      const notes = [
        read.heldBack ? `${read.heldBack} held back because ADR Guard reported an error on one of the two ADRs (run adr-guard check)` : '',
        read.unresolved ? `${read.unresolved} skipped because the target ADR did not resolve to exactly one file` : '',
        read.dependsOn ? `${read.dependsOn} depends-on link(s) not imported` : '',
      ].filter(Boolean);
      if (read.replacements.length === 0) {
        console.log(`No replacements to record from ${path.relative(process.cwd(), file) || file}${notes.length ? `; ${notes.join('; ')}` : ''}.`);
        return;
      }
      // The confirmed record is a local-graph row (a judgement by this person); a cloud env finds its own links.
      if (env.mode !== 'local-embedded') {
        console.log(chalk.dim('ADR Guard replacements are recorded in a local graph only; this environment works out its own.'));
        return;
      }

      const [remote, branch, branches] = await Promise.all([
        getRemoteUrl({ cwd: root }),
        getCurrentBranch({ cwd: root }).catch(() => 'main'),
        branchNames(root),
      ]);
      const outcome = confirmAdrGuardLinks(env.localDbPath ?? getLocalDbPath(), read.replacements.slice(0, limit), (adr) => buildBlobUrl(remote, branch, adr), {
        judge: await defaultJudge(),
        terminal: Boolean(process.stdin.isTTY),
        branches,
      });
      if (outcome.needsTerminal) {
        console.log(chalk.yellow(`${read.replacements.length} replacement(s) not recorded: declaring a decision replaced is a person's act, so it needs a terminal. Run this again in your own terminal.`));
        return;
      }
      const tail = [
        outcome.unmatched ? `${outcome.unmatched} not in your graph (run align connect docs, then this again)` : '',
        outcome.refused ? `${outcome.refused} refused (the older ADR is ratified or confirmed: align mark <newer> replaces <older> --force to override it)` : '',
        ...notes,
      ].filter(Boolean);
      console.log(`${outcome.confirmed} replacement(s) confirmed, as the ADRs record them${tail.length ? `; ${tail.join('; ')}` : ''}.`);
    });
}
