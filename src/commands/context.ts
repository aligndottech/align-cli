/**
 * `align context sync` - write the decision graph into the files
 * agents actually read.
 *
 * The renderer and writer live in lib/decisions-context.ts (shipped in
 * #116) and are pinned by their own suites: Align owns
 * `.align/decisions.md` outright, the user's CLAUDE.md gains one import line,
 * appended never spliced (align-cli#116 decided the ownership model - a
 * separate owned file makes augment-never-overwrite structural, so no marker
 * parser exists to get wrong).
 *
 * For a LOCAL graph that path is usually a symlink to `~/.align/contexts/...`,
 * never a real file - see decisions-context.ts's file header for why gitignore alone was not
 * enough. Every reader here (CLAUDE.md's import, `inject` below, the gitignore/tracked-by-git
 * checks) resolves the relative path transparently either way, so nothing in this file needs
 * to know which case it is.
 *
 * This module is only the wiring: fetch, map, write, say what happened. It
 * must stay non-interactive - it is exactly the kind of command that ends up
 * in a hook or a CI step, which is where an unguarded prompt hangs (the
 * setup --local lesson, #118).
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'node:fs';
import path from 'node:path';

import { createConfigStore } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { readSessionStartCwd } from '../lib/hook-payload.js';
import { committableFromRepo, ensureGitignored, ignoringRule, isTrackedByGit, removeGitignoreLine } from '../lib/context-local-only.js';
import { contextDecisionOf, decisionsFromLocalGraph, LOCAL_FILE_CAP, LOCAL_SCAN, selectForFile } from '../lib/context-from-graph.js';
import {
  ALIGN_CONTEXT_PATH,
  type ContextDecision,
  externalContextPath,
  GENERATED_HEADER,
  isGeneratedDecisionsFile,
  writeDecisionsContext,
} from '../lib/decisions-context.js';
import type { EnvName } from '../lib/config.js';

const inside = (base: string, target: string): boolean => {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The one file in Align's own folder a workspace may link to: the private decisions file `sync`
// keeps for that workspace. `sync` keys it on the path it ran in, so both spellings are tried.
function isOwnPrivateDecisions(dir: string, realDir: string, real: string): boolean {
  for (const root of new Set([dir, realDir])) {
    try {
      if (fs.realpathSync(externalContextPath(root)) === real) return true;
    } catch {
      // No private file for this spelling.
    }
  }
  return false;
}

// A decisions file is only injected when it really lives in the workspace it was found in, or is
// that workspace's own private file in Align's folder. A workspace you did not write can symlink
// `.align/decisions.md` at any readable file, and a user-level hook would send that file to the
// model. The rest of Align's folder stays out: config.json can hold tokens, and contexts/ holds
// other repos' decisions.
function readableDecisions(dir: string): string | null {
  const file = path.join(dir, ALIGN_CONTEXT_PATH);
  try {
    const real = fs.realpathSync(file);
    const realDir = fs.realpathSync(dir);
    if (!inside(realDir, real) && !isOwnPrivateDecisions(dir, realDir, real)) return null;
    return fs.readFileSync(real, 'utf8');
  } catch {
    return null;
  }
}

// A host may start the session in a subdirectory of the project `align context sync` ran in. The
// nearest `.align/decisions.md` wins, walking up to the git root (or the filesystem root).
function findDecisions(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const found = readableDecisions(dir);
    if (found !== null) return found;
    if (fs.existsSync(path.join(dir, '.git'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** `file` as a repo-relative .md path inside `repoRoot`, or null when it is outside it or not markdown. */
export function repoRelativeMarkdown(repoRoot: string, file: string): string | null {
  const rel = path.relative(repoRoot, path.resolve(repoRoot, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !/\.md$/i.test(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Why `--out <rel>` may not be written, or null when it may: the agent's own context file (it would replace it and then
 * import itself), a folder that resolves outside the repo through a symlink, or an existing file Align did not write.
 */
export function outFileProblem(repoRoot: string, rel: string): string | null {
  if (/^(claude|agents)\.md$/i.test(path.basename(rel))) return 'it is your agent\'s own context file, which imports the decisions file.';
  let dir = path.dirname(path.join(repoRoot, rel));
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const realRoot = fs.realpathSync(repoRoot);
  const realDir = fs.realpathSync(dir);
  if (realDir !== realRoot && !realDir.startsWith(`${realRoot}${path.sep}`)) return 'its folder resolves outside this repo through a symlink.';
  const target = path.join(repoRoot, rel);
  if (fs.existsSync(target) && !isGeneratedDecisionsFile(fs.readFileSync(target, 'utf8'))) {
    return `it already exists and was not written by Align (it does not start with "${GENERATED_HEADER}"). Move it, or pick another name.`;
  }
  return null;
}

export function registerContextCommand(program: Command): void {
  const context = program
    .command('context')
    .description('Manage the decisions file agents read (.align/decisions.md)');

  context
    .command('sync')
    .description(`Write current decisions to ${ALIGN_CONTEXT_PATH} and import it from CLAUDE.md`)
    .option('--env <env>', 'Environment')
    .option('--limit <n>', 'Max decisions in the file (default: 30 for a local graph, 200 for a team graph)')
    .option('--out <file>', `Write to this markdown file in the repo (e.g. DECISIONS.md) instead of ${ALIGN_CONTEXT_PATH}; only when every decision comes from this repo`)
    .action(async (opts: { env: EnvName; limit?: string; out?: string }) => {
      // A named file in the repo is one \`git add\` from public, so it is checked before anything is fetched or written.
      const outRel = opts.out === undefined ? undefined : repoRelativeMarkdown(process.cwd(), opts.out);
      if (outRel === null) {
        console.error(`align context sync: --out must be a .md file inside this repo, got ${opts.out}. Nothing was written.`);
        process.exitCode = 1;
        return;
      }
      const outProblem = outRel === undefined ? null : outFileProblem(process.cwd(), outRel);
      if (outProblem) {
        console.error(`align context sync: not writing ${outRel}: ${outProblem} Nothing was written.`);
        process.exitCode = 1;
        return;
      }
      const config = createConfigStore();
      // preferLocalEmbedded: the launch's flagship command must work for the
      // no-account user it is pitched at - bare resolution sent them to an
      // unauthenticated cloud 401 (the family).
      const syncEnv = config.getEnvironment(resolveEnv(opts.env, { preferLocalEmbedded: true }));
      const client = createGatewayClient(syncEnv);
      const spinner = ora('Fetching decisions...').start();

      // Fetch BEFORE writing anything: a failed fetch must not leave a
      // plausible-looking "no decisions" file behind. An empty file and an
      // unreachable graph are different claims (the rule, new surface).
      let decisions: ContextDecision[];
      let sources: Array<{ platform: string; title?: string | null; source_url?: string | null }> = [];
      let leftOut = 0;
      try {
        // A malformed --limit must not become NaN: locally slice(0, NaN) is []
        // and the command would write a plausible-looking EMPTY decisions file -
        // the exact silent failure the fetch-before-write guard below exists for.
        const parsedLimit = parseInt(opts.limit ?? '', 10);
        const given = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
        const localGraph = syncEnv.mode === 'local-embedded';
        // Active only: the file states what currently governs. Superseded and
        // archived decisions are history, and history is the graph's job.
        // A local graph is every commit that states a reason, so it is read whole and the file is SELECTED from it
        // (selectForFile); a team graph is already curated, so it is listed as it is.
        const rows = await client.listDecisions({ limit: localGraph ? LOCAL_SCAN : given ?? 200, status: 'active' });
        // Committability is judged on the rows the file is written from: a row left out puts nothing into it.
        if (localGraph) {
          const picked = selectForFile(rows, given ?? LOCAL_FILE_CAP);
          decisions = picked.decisions;
          leftOut = picked.leftOut;
          // An unnamed platform is not a repo's own, so it counts as private.
          sources = picked.selected.map((r) => ({ platform: r.platform ?? '', title: r.title, source_url: r.source_url }));
        } else {
          decisions = rows.map(contextDecisionOf);
          sources = rows.map((r) => ({ platform: r.platform, title: r.title, source_url: r.source_url }));
        }
      } catch (err) {
        spinner.fail(chalk.red(`Could not fetch decisions: ${(err as Error).message}`));
        process.exit(1);
        return; // unreachable; keeps control flow explicit for the test's exit stub
      }
      spinner.stop();

      const repoRoot = process.cwd();
      // external: true moves the LOCAL case's real bytes to ~/.align - a symlink is
      // left at ALIGN_CONTEXT_PATH, so every read below (and align context inject) is unchanged.
      const local = syncEnv.mode === 'local-embedded';
      // A local graph built only from this repo holds nothing a clone does not: its file can be committed.
      const committable = local && committableFromRepo(sources, repoRoot);
      if (outRel !== undefined && !committable) {
        console.error(
          `align context sync: not writing ${outRel}: some decisions in this graph are not from this repo (a chat, a ticket, another repo, ` +
          `or a doc that is not committed), and a file you name in the repo is one git add from public. Nothing was written. ` +
          `Run without --out to write the private ${ALIGN_CONTEXT_PATH} instead.`,
        );
        process.exitCode = 1;
        return;
      }
      // .gitignore cannot protect a file git already tracks: one ordinary commit would publish what is written into it.
      if (local && !committable && isTrackedByGit(repoRoot, ALIGN_CONTEXT_PATH)) {
        console.error(
          `align context sync: not writing ${ALIGN_CONTEXT_PATH}: it is tracked by git, and this graph now holds decisions that are not from this repo ` +
          `(a chat, a ticket, another repo, or an uncommitted doc). Writing them there would put them in your next commit. Nothing was written. ` +
          `Stop tracking it, then run this again: git rm --cached ${ALIGN_CONTEXT_PATH}`,
        );
        process.exitCode = 1;
        return;
      }
      const result = await writeDecisionsContext(repoRoot, decisions, { external: local && !committable, leftOut, ...(outRel ? { relPath: outRel } : {}) });
      const importLine = `@${result.contextPath}`;

      console.log(`${chalk.green('Wrote')} ${result.contextPath} (${decisions.length} decision${decisions.length === 1 ? '' : 's'})`);

      if (result.importAdded) {
        console.log(`${chalk.green('Added')} ${importLine} import to CLAUDE.md`);
      } else if (fs.existsSync(path.join(repoRoot, 'CLAUDE.md'))) {
        console.log(chalk.dim('CLAUDE.md already imports it.'));
      } else {
        // No CLAUDE.md: we do not invent one (their file, their call). Print
        // the line, or the generated file sits unread by every agent.
        console.log(
          `No CLAUDE.md here - add this line to your agent's context file to load it:\n` +
          `  ${chalk.bold(importLine)}`,
        );
      }
      // A local graph is private to this machine, so its decisions file stays out of git. Sharing with a team
      // goes through `align share`; a team graph's file is already team content and is left alone.
      if (committable) {
        removeGitignoreLine(repoRoot, result.contextPath);
        const rule = ignoringRule(repoRoot, result.contextPath);
        if (rule) {
          console.log(chalk.yellow(
            `Every decision in ${result.contextPath} comes from this repo, but it is still ignored by git (the .gitignore rule "${rule}"), ` +
            `so git will not commit it. Remove or narrow that rule to share it.`,
          ));
        } else {
          console.log(chalk.dim(
            `Every decision in ${result.contextPath} comes from this repo (its commits, docs and pull requests), so it is a normal file: commit it, and everyone who clones the repo reads the same decisions.`,
          ));
        }
      } else if (local) {
        const status = ensureGitignored(repoRoot, ALIGN_CONTEXT_PATH);
        console.log(chalk.dim(
          `${status === 'added' ? 'Kept out of git (added to .gitignore)' : 'Kept out of git'}: this comes from your local graph, which stays on this machine. ` +
          `To bring decisions to your team, run ${chalk.bold('align share')}.`,
        ));
      }
      console.log(chalk.dim(`Bring it up to date after new decisions land: align up${outRel ? ` --out ${outRel}` : ''}`));
    });

  context
    .command('inject')
    .description(
      'Print the decisions file as SessionStart hook output (written by `align`, not meant to be run by hand)',
    )
    .option('--format <host>', 'Hook output shape: claude (default), codex, gemini, copilot or cursor')
    .action(async (opts: { format?: string }) => {
      // The read-path counterpart to `align check --advisory`. A SessionStart
      // hook shells out to this on every new/resumed/compacted session; whatever it
      // prints lands in the model's context WITHOUT the model choosing to open a file or
      // call a tool. Deliberately reads the file `align context sync` already wrote
      // rather than fetching the graph itself - a hook must stay fast and offline-safe,
      // and the fetch+render pipeline already has an owner (registerContextCommand's
      // `sync` action, above). See docs/agent-hooks.md for the read-path enumeration
      // this command backs.
      //
      // Fail-open on every branch, matching every other host shim in agent-rules.ts: no
      // decisions synced yet, an unreadable file, or a file with nothing but whitespace
      // in it all print nothing rather than error or inject an empty additionalContext.
      //
      // Claude Code's project hook runs in the project and sends nothing we need. The other hosts
      // write a USER-level file, which does not run in the project, so for those the workspace
      // comes from the payload's `cwd` (a path that is not a directory prints nothing).
      const format = opts.format ?? 'claude';
      if (!['claude', 'codex', 'gemini', 'copilot', 'cursor'].includes(format)) return;
      let root = process.cwd();
      if (format !== 'claude') {
        const named = await readSessionStartCwd();
        const isDir = (p: string): boolean => {
          try { return fs.statSync(p).isDirectory(); } catch { return false; }
        };
        // A payload that NAMES a path which is not a directory (a stale or deleted workspace)
        // prints nothing: a user-level hook can start in any repo, so the process cwd would send
        // another project's decisions. A payload that names nothing keeps the process cwd for
        // codex, gemini and copilot. Cursor's workspace_roots is its only hint, so with none named
        // it prints nothing.
        if (named) {
          if (!isDir(named)) return;
          root = named;
        } else if (format === 'cursor') return;
      }
      // No decisions file: a local graph is read straight from this machine (context-from-graph.ts). A file that is there, even an
      // empty one, wins: the person wrote it with `align context sync`.
      const raw = (format === 'claude' ? readableDecisions(root) : findDecisions(root)) ?? await decisionsFromLocalGraph(root);
      if (raw === null || !raw.trim()) return;
      // trimEnd only: a full trim() would also strip leading whitespace, which is
      // part of the file's real content (e.g. an indented code block) and would
      // contradict the "raw file content" claim in the test and docs above.
      const content = raw.trimEnd();

      // Same shape Claude Code's own hooks already emit elsewhere in this codebase
      // (check.ts's buildAdvisoryOutput default case) - hookSpecificOutput.additionalContext,
      // confirmed for SessionStart specifically against code.claude.com/docs/en/hooks.
      // Copilot CLI reads additionalContext as a TOP-LEVEL key for sessionStart (docs.github.com
      // Copilot hooks reference, read 2026-11-18). The other three read it under hookSpecificOutput.
      // Cursor documents a top-level snake_case `additional_context` for sessionStart
      // (cursor.com/docs/hooks, read 2026-11-18). Whether it reaches the model is unverified.
      const output = format === 'copilot'
        ? { additionalContext: content }
        : format === 'cursor'
        ? { additional_context: content }
        : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: content } };
      process.stdout.write(`${JSON.stringify(output)}\n`);
    });
}
