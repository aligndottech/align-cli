/**
 * Type a set of candidate edges with whichever local detector ALIGN_DETECTOR selects.
 *
 * v0 (ALIGN_DETECTOR=v0): the pairwise classifier, one call per candidate, stopping after a
 * provider stop (ALI-692) - moved here verbatim from `checkAlignment` and `linkPass` so both
 * callers share it.
 * v1 (the default): one call over the whole set (local-set-classifier.ts). A candidate v1 judged as having no
 * relationship comes back typed `relates` at its similarity, exactly what a judged, unrelated
 * pair reads as to every caller today; a whole-call failure is reported on every candidate.
 *
 * `order` keeps v0's two orientations: `check` asks how the candidate relates to the proposed
 * change (subject is A), capture asks how the new decision relates to the existing one (existing
 * is A). v1 always puts the new/proposed side as the NEW DECISION.
 */
import { type DetectorVersion, resolveDetectorVersion } from '../detector/detector-version.js';
import { type ClassificationOutcome, classifyRelationship, type RelationshipType } from './local-relationship-classifier.js';
import { classifyCandidateSet, type SetCandidate, type SetSubject } from './local-set-classifier.js';

export interface CandidateClassification {
  version: DetectorVersion;
  outcomes: ClassificationOutcome[];
}

export async function classifyCandidates(
  subject: SetSubject,
  candidates: readonly SetCandidate[],
  order: 'subject-first' | 'candidate-first',
  deps: { pair?: typeof classifyRelationship; set?: typeof classifyCandidateSet } = {},
): Promise<CandidateClassification> {
  const version = resolveDetectorVersion();
  if (version === 'v1') {
    if (!candidates.length) return { version, outcomes: [] };
    const result = await (deps.set ?? classifyCandidateSet)(subject, candidates);
    if (!result.ok) {
      const failed: ClassificationOutcome = { ok: false, reason: result.reason, ...(result.failure ? { failure: result.failure } : {}) };
      return { version, outcomes: candidates.map(() => failed) };
    }
    return {
      version,
      outcomes: result.verdicts.map((v) => ({
        ok: true,
        relationship: { type: (v.relation ?? 'relates') as RelationshipType, confidence: v.confidence, ...(v.reason ? { reason: v.reason } : {}) },
      })),
    };
  }
  const pair = deps.pair ?? classifyRelationship;
  const outcomes: ClassificationOutcome[] = [];
  let chainStopped = false;
  for (const c of candidates) {
    // ALI-692: a recorded chain stop is a property of the PROVIDER, not of this candidate, so
    // asking again per candidate repeats one doomed call N times.
    const lite = { title: c.title, summary: c.summary };
    const outcome: ClassificationOutcome = chainStopped
      ? { ok: false, reason: 'classifier_error' }
      : await (order === 'subject-first' ? pair({ title: subject.title, summary: subject.summary }, lite) : pair(lite, { title: subject.title, summary: subject.summary }));
    if (!outcome.ok && outcome.failure?.kind === 'provider_stopped') chainStopped = true;
    outcomes.push(outcome);
  }
  return { version, outcomes };
}
