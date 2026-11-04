/**
 * Co-change rules inside `align check`: the changed-file list, and the fold of a violation into the
 * result. The judge never sees any of this. It runs beside the LLM, needs no model call, and is
 * evaluated whether the judge answered, abstained or threw.
 */
import { execa } from 'execa';
import type { AlignmentResult } from './gateway-client.js';
import type { CoChangeViolation } from './co-change.js';

/** Which change `align check` is looking at: the same three sources it takes its diff from. */
export type ChangeSource = { kind: 'base'; ref: string } | { kind: 'staged' } | { kind: 'head' };

function argsFor(source: ChangeSource): string[] {
  // --no-renames: a rename is a delete plus an add, so the OLD path counts as touched too. With rename
  // detection on, `--name-only` prints only the new name and a moved changelog would hide the move.
  // -z: no path quoting, so a name with a space or a non-ASCII character comes back verbatim.
  const base = ['diff', '--name-only', '--no-renames', '-z'];
  if (source.kind === 'base') return [...base, `${source.ref}...HEAD`];
  if (source.kind === 'staged') return [...base, '--staged'];
  return [...base, 'HEAD'];
}

/** Throws when git cannot answer: "I could not look" must never read as "nothing changed". */
export async function changedFiles(source: ChangeSource, cwd: string = process.cwd()): Promise<string[]> {
  const { stdout } = await execa('git', argsFor(source), { cwd });
  return stdout.split('\0').filter((f) => f !== '');
}

const SHOWN_FILES = 3;

function listFiles(files: string[]): string {
  const shown = files.slice(0, SHOWN_FILES).join(', ');
  return files.length > SHOWN_FILES ? `${shown} and ${files.length - SHOWN_FILES} more` : shown;
}

function reasonFor(v: CoChangeViolation): string {
  return `This change touches ${listFiles(v.triggeredBy)} but none of ${v.missing.join(', ')}. The rule asks for a change to ${v.missing.join(' or ')} in the same PR.`;
}

/**
 * Fold violations into the judge's answer. `llm` is null when the judge threw; `llmError` says why.
 * A rule conflict is critical: it has one right answer, so it carries no confidence to discount.
 * It also outranks `unknown`: "the judge could not decide" is no reason to hide a violation.
 */
export function mergeCoChange(llm: AlignmentResult | null, llmError: unknown, violations: CoChangeViolation[]): AlignmentResult {
  const ruleConflicts = violations.map((v) => ({
    decision_id: v.decisionId,
    title: v.title,
    summary: v.summary,
    ...(v.url ? { url: v.url } : {}),
    reason: reasonFor(v),
    severity: 'critical' as const,
  }));
  const ruleIds = new Set(ruleConflicts.map((c) => c.decision_id));
  const judged = (llm?.conflicts ?? []).filter((c) => !ruleIds.has(c.decision_id));
  const judgeNote = llm === null
    ? [`The decision-graph judge did not run (${llmError instanceof Error ? llmError.message : String(llmError)}). The file rule above needed no judge.`]
    : [];
  const message = `This change breaks ${ruleConflicts.length} file rule(s) from your decision graph: a file that should have changed with it did not.`;
  // `reason` and `reason_class` describe an `unknown` verdict, which this result no longer is.
  const { reason: _reason, reason_class: _reasonClass, ...kept } = llm ?? { relevant_decisions: [] as AlignmentResult['relevant_decisions'] };
  const related = kept.relevant_decisions.filter((d) => !ruleIds.has(d.id));
  return {
    ...kept,
    relevant_decisions: [...violations.map((v) => ({ id: v.decisionId, title: v.title, summary: v.summary, similarity: 1, ...(v.url ? { url: v.url } : {}) })), ...related],
    status: 'conflicting',
    confidence: 1,
    conflicts: [...ruleConflicts, ...judged],
    notes: [...(llm?.notes ?? []), ...judgeNote],
    message,
  };
}

/**
 * The violations for this check, or [] when there is nothing to evaluate. Rules live in the local
 * graph, so any other environment reads nothing (the hosted gateway holds its own). A graph with no
 * rules returns before git is asked anything, so the feature costs a user who has no rules nothing.
 * Throws when rules exist and the file list cannot be read: a rule that could not be evaluated must
 * not read as one that was satisfied.
 */
export async function coChangeViolations(env: { mode: string; localDbPath?: string }, source: ChangeSource): Promise<CoChangeViolation[]> {
  if (env.mode !== 'local-embedded') return [];
  const [{ listCoChangeRules }, { evaluateCoChange }, { getLocalDbPath }, { currentRepoIdentity }] = await Promise.all([
    import('./co-change-store.js'), import('./co-change.js'), import('./local-mode.js'), import('./repo-identity.js'),
  ]);
  // Rules belong to the repo they were added in (the identity decisions.repo carries): one machine-wide
  // graph must not make a rule from repo A fire in repo B.
  const rules = listCoChangeRules(env.localDbPath ?? getLocalDbPath(), { repo: await currentRepoIdentity() });
  if (rules.length === 0) return [];
  return evaluateCoChange(rules, await changedFiles(source));
}

/** Run the judge, then fold in the violations. With none, the judge's answer or failure passes through untouched. */
export async function judgeWithCoChange(judge: () => Promise<AlignmentResult>, violations: CoChangeViolation[]): Promise<AlignmentResult> {
  if (violations.length === 0) return judge();
  try {
    return mergeCoChange(await judge(), null, violations);
  } catch (err) {
    return mergeCoChange(null, err, violations);
  }
}
