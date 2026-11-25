/**
 * The similarity thresholds the local graph ranks and links with. Moved verbatim out of
 * local-gateway-client.ts (which re-exports every name, so no importer changes) so the link
 * pass can use them without importing the client that calls it.
 */

/**
 * Cosine floor for linking two decisions as related on ingest.
 *
 * Named CONFLICT_THRESHOLD until it was renamed, which was the same category error as the code
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
 * How many dense candidates `searchDecisions` retrieves before the title rerank cuts to the
 * caller's limit: max(limit * RERANK_POOL_FACTOR, RERANK_POOL_MIN). The motivating miss
 * sat at dense rank 12 of 20, so a pool of the bare limit (8) could never have
 * promoted it; 30 clears that with room, and the scan reads every stored vector either way.
 */
export const RERANK_POOL_FACTOR = 4;
/**
 * The dense floor for a row only the LEXICAL ranking found. A rare identifier is worth
 * a row below SEARCH_THRESHOLD (a commit that names "find-my-way" can embed at 0.2 beside a
 * question about routing), but a row with no semantic resemblance at all that merely shares a
 * common word ("support") is noise. 0.15 sits under the 0.25 search floor. Measured on eval v2:
 * 0.25 scored 93.9% recall@8, 0.15 scored 95.7% and 0 scored 95.1%.
 */
export const LEXICAL_MIN_DENSE = 0.15;
export const RERANK_POOL_MIN = 30;
/**
 * The floor for the LINK PASS on ingest (RELATED_FLOOR) and for `align ask`'s weak-match wording (WEAK_MATCH_BELOW). It is
 * no longer the candidate floor of `align check`: that is RETRIEVAL_RELATES_THRESHOLD below, the same one the edit hook uses.
 * Kept at 0.45 here because recalibrating how decisions link to each other is a separate decision with a separate blast radius.
 */
export const RELATES_THRESHOLD = 0.45;

/**
 * Candidate floor for `align check` and the agent editor hook alike: what each retrieves before any model call.
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
 * `align check` ran at 0.45 while the hook ran at 0.30, so a decision the hook named never reached the check and
 * `check --ci` exited 0 on a change the hook had flagged (reported 23 Nov). They now share this floor. The check still
 * adjudicates what it retrieves (up to five candidates, a provider call each), so a keyless CI runner exits 2 for a
 * candidate in the 0.30-0.45 band where it used to exit 0: it could not judge a decision that is related.
 * The hook returns above adjudication, so it makes no provider call and asserts nothing
 * ("related by content search and have NOT been adjudicated").
 */
export const RETRIEVAL_RELATES_THRESHOLD = 0.3;
// The ABSOLUTE floor above is unreachable for cross-register pairs on
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
