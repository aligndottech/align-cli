/**
 * `align rule` - a co-change rule written by hand, into the local graph.
 *
 *   align rule add "<title>" --when <glob...> --require <path...>
 *   align rule list
 *
 * "A PR touching --when must also touch one of --require, in the same PR." `align check` evaluates it
 * from the changed-file list, with no model call. The title is the decision this records, and what a
 * flag cites. Not `capture` (which reads a decision out of a URL) and not `mark` (a judgement on a
 * decision that exists): this makes the decision and its rule together.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { addCoChangeRule, listCoChangeRules, removeCoChangeRule } from '../lib/co-change-store.js';
import { parseCoChangeRule } from '../lib/co-change.js';
import { currentRepoIdentity } from '../lib/repo-identity.js';
import { localGraphPath } from '../lib/sync/real-env.js';

export interface RuleCommandDeps { out(line: string): void; err(line: string): void; graphPath(): string | undefined; repo(): Promise<string | null> }
export interface RuleAddOptions { when?: string[]; require?: string[]; summary?: string }

const NO_GRAPH = 'There is no local graph yet. Run `align local start` (or `align setup --local`) first.';

export async function runRuleAdd(title: string | undefined, opts: RuleAddOptions, deps: RuleCommandDeps): Promise<number> {
  if (title === undefined || title.trim() === '') {
    deps.err('Give the rule a title: it is the decision a flag will cite. Put the title first, before the flags, because --when and --require take every word after them: align rule add "<title>" --when <glob...> --require <path...>');
    return 2;
  }
  if (!opts.when || opts.when.length === 0) { deps.err('--when needs at least one path or glob: the files that trigger the rule.'); return 2; }
  if (!opts.require || opts.require.length === 0) { deps.err('--require needs at least one path or glob: the file a change must also touch.'); return 2; }
  let rule;
  try {
    rule = parseCoChangeRule({ when_paths: opts.when, require_paths: opts.require, scope: 'same_pr' });
  } catch (e) {
    deps.err((e as Error).message);
    return 2;
  }
  const dbPath = deps.graphPath();
  if (dbPath === undefined) { deps.err(NO_GRAPH); return 1; }
  const { decisionId, created } = addCoChangeRule(dbPath, { title, summary: opts.summary, rule, repo: await deps.repo() });
  deps.out(created ? `Rule recorded (decision ${decisionId}).` : `That rule already exists (decision ${decisionId}).`);
  deps.out(`A change touching ${rule.when_paths.join(', ')} must also touch ${rule.require_paths.join(' or ')} in the same PR. \`align check\` flags it when it does not.`);
  return 0;
}

export async function runRuleList(deps: RuleCommandDeps): Promise<number> {
  const dbPath = deps.graphPath();
  const rules = dbPath === undefined ? [] : listCoChangeRules(dbPath);
  if (rules.length === 0) {
    deps.out('No co-change rules yet. `align rule add --help` shows how to write one.');
    return 0;
  }
  for (const r of rules) {
    deps.out(`${r.title}\n  touching ${r.rule.when_paths.join(', ')} requires ${r.rule.require_paths.join(' or ')} (same PR)\n  repo ${r.repo ?? 'any'}  rule ${r.ruleId}`);
  }
  return 0;
}

export async function runRuleRemove(id: string | undefined, deps: RuleCommandDeps): Promise<number> {
  if (id === undefined || id.trim() === '') { deps.err('Give the rule id `align rule list` printed: align rule remove <id>'); return 2; }
  const dbPath = deps.graphPath();
  if (dbPath === undefined) { deps.err(NO_GRAPH); return 1; }
  if (!removeCoChangeRule(dbPath, id.trim())) { deps.err(`No rule has the id ${id}. \`align rule list\` shows them.`); return 1; }
  deps.out('Rule removed. Its decision stays in your graph.');
  return 0;
}

export function registerRuleCommand(program: Command): void {
  const rule = program
    .command('rule')
    .description('Co-change rules: a PR touching some files must also touch another, checked by file list with no model (local)');
  const deps: RuleCommandDeps = { out: (l) => console.log(l), err: (l) => console.error(chalk.red(l)), graphPath: () => localGraphPath(), repo: () => currentRepoIdentity() };
  rule
    .command('add [title]')
    .description('Record a rule: a change touching --when must also touch one of --require in the same PR')
    .option('--when <globs...>', 'Paths or globs that trigger the rule (e.g. "openapi/**")')
    .option('--require <paths...>', 'Paths or globs, any one of which a triggering change must also touch (e.g. docs/changelog.md)')
    .option('--summary <text>', 'Why the rule exists, in a sentence')
    .action(async (title: string | undefined, opts: RuleAddOptions) => {
      const code = await runRuleAdd(title, opts, deps);
      if (code !== 0) process.exitCode = code;
    });
  rule
    .command('remove [id]')
    .description('Remove a co-change rule by the id `align rule list` prints. Its decision stays')
    .action(async (id: string | undefined) => {
      const code = await runRuleRemove(id, deps);
      if (code !== 0) process.exitCode = code;
    });
  rule
    .command('list')
    .description('Show the co-change rules in your local graph')
    .action(async () => {
      const code = await runRuleList(deps);
      if (code !== 0) process.exitCode = code;
    });
}
