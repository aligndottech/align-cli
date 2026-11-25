/**
 * Judge a diff against the decisions of a committed file, with the user's own provider key and no graph.
 *
 * WHY THIS DOES NOT SEED A THROWAWAY LOCAL GRAPH AND RUN THE NORMAL LOCAL CHECK. That path first embeds
 * the diff and every decision with an on-device model that is downloaded from huggingface.co on first use,
 * so a fresh CI runner would make a second network call besides the provider's, and it retrieves by
 * similarity, so a decision the retrieval misses is never judged. The file is already the short list
 * (`align up` caps it), so every decision goes to the judge. What is reused is the part that judges:
 * `classifyCandidates`, the same detector, prompt, parser and resolver the local check runs, so the
 * verdicts mean what they mean in `align check` against a local graph.
 *
 * The mapping from verdicts to a result below mirrors the end of `checkAlignment` in
 * local-gateway-client.ts: a conflicts_with, contradicts or supersedes verdict is a conflict, a conflict
 * found still wins over a candidate that could not be judged, and anything that could not be judged and
 * found no conflict is `unknown`, never `aligned`.
 */
import { conflictSeverity } from './conflict-severity.js';
import type { AlignmentResult } from './gateway-client.js';
import type { FileDecision } from './decisions-file.js';
import { callChatDetailed, noProviderHintInline } from './local-llm.js';
import { classifyCandidates } from './local-candidate-classify.js';
import { classifyCandidateSet, ordinal, similarEntries } from './local-set-classifier.js';

export interface FileJudgeDeps {
  classify?: typeof classifyCandidates;
}

/**
 * The shared set classifier reads a non-empty `similar` array in which no entry names one of the
 * candidates (`[null]`, a ref outside the list) as "judged, nothing related", and the caller then reads
 * that as aligned. Here that is an unreadable answer: nothing was judged. An EMPTY array stays a valid
 * "no conflict" answer.
 */
type SetClassifier = NonNullable<Parameters<typeof classifyCandidates>[3]>['set'];

/**
 * The prompt builder shares what is left of the model's window between the diff and every decision summary, and cuts
 * each to its share - to nothing when the window is small. A "no conflict" answer about text the model never saw is
 * not a pass, so the prompt that was actually built is checked for the whole diff and every whole summary.
 */
const makeSetClassifier = (onCut: () => void): SetClassifier => async (subject, candidates) => {
  let text: string | undefined;
  const whole = [subject.summary, ...candidates.map((c) => c.summary)];
  const result = await classifyCandidateSet(subject, candidates, async (system, user, opts) => {
    const seen = typeof user === 'function'
      ? (windowTokens: number) => {
          const built = user(windowTokens);
          if (whole.some((t) => !built.includes(t))) onCut();
          return built;
        }
      : user;
    if (typeof user === 'string' && whole.some((t) => !user.includes(t))) onCut();
    const r = await callChatDetailed(system, seen, opts);
    if (r.ok) text = r.text;
    return r;
  });
  const entries = result.ok && text !== undefined ? similarEntries(text) : null;
  const judged = (e: unknown): boolean => typeof e === 'object' && e !== null && ordinal((e as Record<string, unknown>)['decision_ref'], candidates.length) !== null;
  if (entries && entries.length > 0 && !entries.some(judged)) return { ok: false, reason: 'classifier_unparseable' };
  return result;
};

export async function judgeAgainstDecisionsFile(
  diff: string,
  decisions: readonly FileDecision[],
  opts: { title?: string; file: string },
  deps: FileJudgeDeps = {},
): Promise<AlignmentResult> {
  const candidates = decisions.map((d, i) => ({
    id: `${opts.file}#${i + 1}`,
    title: d.title,
    summary: d.why ? `${d.title}\n${d.why}` : d.title,
    // Not a retrieval score: every decision in the file is judged. 1 says "judge this one" and
    // is never read back, since a verdict carries its own confidence.
    similarity: 1,
    platform: 'docs',
    decidedAt: null,
    status: null,
  }));
  const subject = { title: opts.title ?? 'Proposed change', summary: diff, decidedAt: null, platform: 'cli' };
  let cut = false;
  const { outcomes } = await (deps.classify ?? classifyCandidates)(subject, candidates, 'candidate-first', { set: makeSetClassifier(() => { cut = true; }) });

  const typed = candidates.map((c, i) => {
    const outcome = outcomes[i];
    const rel = outcome?.ok ? outcome.relationship : null;
    return { c, d: decisions[i]!, rel, outcome };
  });
  const relevant_decisions = typed.map(({ c, d }) => ({ id: c.id, title: c.title, summary: c.summary, similarity: c.similarity, ...(d.url ? { url: d.url } : {}) }));

  const conflicts = typed
    .filter(({ rel }) => rel && (rel.type === 'conflicts_with' || rel.type === 'contradicts' || rel.type === 'supersedes'))
    .map(({ c, d, rel }) => ({
      decision_id: c.id,
      title: d.title,
      ...(d.why ? { summary: d.why } : {}),
      ...(d.url ? { url: d.url } : {}),
      reason: rel!.type === 'supersedes'
        ? `Reverses a recorded decision: ${rel!.reason ?? 'this change replaces it'}`
        : rel!.reason ?? `Conflicts with a decision in ${opts.file}`,
      severity: conflictSeverity(rel!.confidence, { decisionText: c.summary, changeText: diff, evidence: rel!.evidence }),
    }));
  const confidence = Math.max(0, ...typed.map(({ rel }) => rel?.confidence ?? 0));

  if (conflicts.length) {
    return {
      status: 'conflicting',
      confidence,
      relevant_decisions,
      conflicts,
      message: `This change conflicts with ${conflicts.length} decision(s) in ${opts.file}.`,
    };
  }

  if (cut) {
    return {
      status: 'unknown',
      reason: 'classifier_error',
      confidence: 0,
      relevant_decisions,
      conflicts: [],
      message: `Could not check this change against the ${decisions.length} decision(s) in ${opts.file}: the diff, or a decision, did not fit the model's window and would have been cut. This is NOT a pass. Split the change, or use a model with a larger window.`,
    };
  }

  const failed = typed.find(({ outcome }) => !outcome?.ok);
  if (failed) {
    const o = failed.outcome;
    const reason = o && !o.ok ? o.reason : 'classifier_error';
    const failure = o && !o.ok ? o.failure : undefined;
    const hint = reason === 'no_llm_key'
      ? noProviderHintInline('the decisions in the file can be checked')
      : failure?.kind === 'provider_stopped'
        ? ` ${failure.model} (${failure.provider}) returned an unusable response (${failure.detail}).`
        : '';
    return {
      status: 'unknown',
      reason,
      confidence: 0,
      relevant_decisions,
      conflicts: [],
      message: `Could not check this change against the ${decisions.length} decision(s) in ${opts.file}: the judge did not run. This is NOT a pass.${hint}`,
    };
  }

  return {
    status: 'aligned',
    confidence,
    relevant_decisions,
    conflicts: [],
    message: `Checked against ${decisions.length} decision(s) in ${opts.file}: no conflict found.`,
  };
}
