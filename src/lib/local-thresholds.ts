/**
 * The similarity thresholds the local graph ranks and links with. Moved verbatim out of
 * local-gateway-client.ts (which re-exports every name, so no importer changes) so the link
 * pass can use them without importing the client that calls it.
 */

/**
 * Cosine floor for linking two decisions as related on ingest.
 *
 * Named CONFLICT_THRESHOLD until ALI-503, which was the same category error as the code
 * it governed: the value decides similarity, and similarity is not opposition. The
 * classifier prompt in local-relationship-classifier.ts says so directly - "high textual
 * similarity alone is NOT a conflict" - and the link written here is `relates` because an
 * embedding cannot tell agreement from opposition. Only a classifier reading both can, and
 * its verdict is never persisted as a link.
 */
export const SIMILARITY_THRESHOLD = 0.65;
/**
 * Relevance floor for align_ask / align_search.
 *
 * Was an inline 0.1, the only unnamed threshold in this file and less than a quarter of
 * its neighbours. It let align_ask answer "what happens when the brain service is down"
 * with two unrelated decisions at 0.18 and 0.14 - noise the agent had to recognise by
 * reading the decimals itself, and an audience cannot.
 *
 * 0.25 matches the gateway's own /decisions/smart-search floor, so the same question gets
 * the same relevance bar in local and cloud mode. Lower than the 0.45 used for relatedness
 * on purpose: search is a human asking a natural-language question, where a looser match is
 * still worth showing, while relatedness is machinery acting on its own.
 *
 * An honest empty result is the point. "The graph has nothing on this" is a better answer
 * than two wrong decisions, because the caller can act on it.
 */
export const SEARCH_THRESHOLD = 0.25;
/**
 * Candidate floor for ADJUDICATION - the path that then pays an LLM per candidate.
 *
 * Deliberately higher than the retrieval floor below, because this surface is expensive in
 * three ways the hook is not: up to 5 sequential calls to the user's own provider, ~11s of
 * latency, and an exit code. A keyless CI runner that gets `no-context` today exits 0; the
 * moment retrieval finds anything it gets `unknown` and exits 2. And the classifier cannot
 * reject a candidate - its vocabulary is ten positive relations with no "unrelated" - so a
 * loose candidate that reaches it is reported rather than filtered.
 *
 * Deliberately NOT recalibrated with the retrieval floor. Measured on the corpus, 0.30 would
 * recover four more related pairs here too, and that trade is a separate decision with a
 * separate blast radius (see relatedness-calibration.test.ts).
 */
export const RELATES_THRESHOLD = 0.45;

/**
 * Candidate floor for RETRIEVAL ONLY (`depth: 'related'`, the agent editor hook).
 *
 * Measured, not chosen. Against fixtures/relatedness-corpus.json: 0.45 recovered 3 of 8 related
 * pairs, 0.30 recovers 7 of 8, and neither admits a single unrelated pair. 0.25 scores the same
 * 7 of 8, so the tie-break is margin over the worst false positive (0.2051): 0.30 clears it by
 * 0.095 against 0.25's 0.045.
 *
 * 0.30 is also where this constant sat until commit 0cbef08 raised it to 0.45 inside a rename,
 * unmentioned and unmeasured. So this is a revert with evidence attached rather than a new
 * guess, and the evidence is a test that fails if the corpus stops supporting it.
 *
 * Safe to be looser here precisely because this path is cheap and honest: it returns above
 * Stage 2, so it makes no provider call, and what the hook prints declines to assert anything
 * ("related by content search and have NOT been adjudicated"). That is the same posture as
 * `align search`, which has run at 0.25 all along - as has MCP `align_get_related_decisions`.
 */
export const RETRIEVAL_RELATES_THRESHOLD = 0.3;
// ALI-785: the ABSOLUTE floor above is unreachable for cross-register pairs on
// MiniLM-L6 - measured on a 403-decision six-source corpus, near-duplicates score
// ~0.95, genuine cross-tool paraphrases 0.45-0.62, background noise 0.28-0.40, and
// 0 of 1,729 links crossed a platform. So linking also takes each item's top few
// neighbours RELATIVE to its own ranking, floored where the noise band ends. 0.45 is
// the adjudication floor the product already uses elsewhere; text-cleaning schemes
// were lab-tested first and moved nothing (title+cleaned scored 0.274 vs 0.286 raw).
export const RELATED_TOP_K = 3;
export const RELATED_FLOOR = RELATES_THRESHOLD;

// Below this similarity between a decision and new content, the content is
// considered to have drifted from the decision.
export const DRIFT_THRESHOLD = 0.5;
