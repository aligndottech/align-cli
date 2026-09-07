# Embedding model evaluation: bge-small-en-v1.5 vs MiniLM-L6-v2 (ALI-787)

## Decision: do not swap

The local graph keeps embedding with `Xenova/all-MiniLM-L6-v2` (q8). bge-small-en-v1.5 fixes
the specific ceiling case that motivated this ticket, but it also compresses this product's
whole relatedness corpus into a much narrower, less safe range - unrelated pairs score almost
as high as related ones. That is a regression on the exact mechanism (a fixed cosine
threshold) the local graph's linking and retrieval floors depend on, so the ticket's own
criterion for adopting a swap ("no regression on pairs that already scored well") is not met.

The schema is now ready for a future swap regardless: `decision_embeddings` carries a `model`
column, every new embedding is tagged with the model that produced it, and both ranking
(`findSimilar`) and single-decision comparison (`checkDrift`) skip a row tagged with a
different model rather than comparing incompatible vectors. See the "Schema change made
anyway" section below.

## Method

Both models were loaded through the exact code path `local-embeddings.ts` uses in
production: `@huggingface/transformers` (v4.2.0, already vendored in this repo),
`pipeline('feature-extraction', <model>, { dtype: 'q8' })` - the same quantization this CLI
already pins for MiniLM, for the same reason (`local-embeddings-dtype.test.ts`: fp32 shifts
pairwise cosine by up to 2.3e-02 against vectors already on disk).

Two pooling modes were used for bge-small-en-v1.5, because its own `1_Pooling/config.json`
declares `pooling_mode_cls_token: true, pooling_mode_mean_tokens: false` - CLS pooling, not
the mean pooling MiniLM's own config declares and this codebase already uses. Both are
reported below; the qualitative conclusion is the same either way, but CLS is bge-small's
correct pooling mode and should be used if this decision is ever revisited.

Cosine similarity: the same normalized-dot-product function `local-embeddings.ts` exports,
reimplemented identically in the eval script (no code was shared between the two, so this is
an independent check that the two computations agree - see "reproduction" below).

Corpus: `src/__tests__/fixtures/relatedness-corpus.json` (14 hand-labelled change/decision
pairs, 8 related + 6 unrelated, the same fixture `relatedness-calibration.test.ts` derives
`RETRIEVAL_RELATES_THRESHOLD` from), plus the one designed pair named in this ticket, plus 3
more decision-title-shaped pairs constructed for this evaluation (a commit-message-like
"change" text vs a `[TICKET-N] ...`-style "decision" text about the same underlying decision,
matching the designed pair's shape).

The prior scratchpad harness (embed-lab/rank-lab/rule-sim/e2e-785, and the 403-decision
corpus ALI-785 measured against) lived under `/tmp/` in an earlier session and did not
survive to this one - confirmed gone (`ls` on the path in ALI-787's brief returned "No such
file or directory"). Everything below is a fresh, smaller harness built for this ticket, not
a rerun of ALI-785's.

## Reproduction: the corpus's recorded MiniLM scores are real

Before trusting any comparison, the eval script re-measured every one of the 14 corpus pairs
under MiniLM-L6-v2 (mean pooling, q8) and compared against the scores already recorded in the
fixture (which `relatedness-calibration.test.ts` uses without a model download). Every score
matched to within 0.0024, consistent with float rounding rather than a methodology mismatch -
this is the positive control that the eval script's model loading, pooling, and cosine
computation genuinely reproduce what produced the fixture, not just a plausible-looking number.

## The designed pair (ALI-785's ceiling case)

Exact strings from the ticket:
- change: `fix(db): switch the connection pool to 12 after the timeout incident`
- decision: `[ALI-179] Data Pipeline Connection Pool Sizing`

| Model | Pooling | Cosine |
|---|---|---|
| MiniLM-L6-v2 | mean | **0.3791** |
| bge-small-en-v1.5 | mean (wrong for this model) | 0.6734 |
| bge-small-en-v1.5 | cls (its own declared pooling) | **0.7264** |

bge-small resolves this pair decisively - both pooling modes place it well clear of MiniLM's
noise band (the ticket cites 0.40-0.45 as the top of that band).

**One discrepancy worth stating plainly: this run measured 0.3791 for MiniLM on these exact
two strings, not the 0.286 the ticket quotes.** The ticket's number is real (ALI-785 measured
it against a 403-decision corpus with a working harness), but I could not reproduce it with
the harness available to me, and I could not recover ALI-785's original harness to find out
why - it may have embedded fuller decision text (a summary, not just a bare ticket title) or a
title+summary concatenation the way `local-gateway-client.ts`'s `ingestOne` actually builds
embed text (`title === summary ? summary : ${title}. ${summary}`), rather than the bare
strings quoted in the ticket. Both numbers support the same qualitative point (MiniLM
under-separates this pair from noise; bge-small does not), so this does not change the
conclusion, but the exact figure should be read as "measured fresh, 0.379" rather than a
confirmation of "0.286".

## Extra decision-title-shaped pairs (constructed for this evaluation)

| Change (commit-message-like) | Decision (ticket-title-like) | MiniLM | bge-small (mean) |
|---|---|---|---|
| bump session cookie maxAge to 30 days per the retention decision | [ALI-212] Extend session cookie lifetime to 30 days | 0.7277 | 0.7937 |
| revert the queue visibility timeout back to 5 minutes, it was too aggressive | [ALI-88] SQS visibility timeout must exceed the brain analyze timeout | 0.3413 | 0.6145 |

Both models correctly rank these as related-shaped pairs; bge-small scores both higher, in
line with its better published benchmark numbers (below). This is the pattern that would look
like a clean win in isolation - it is the corpus below that changes the picture.

## The full relatedness corpus: bge-small compresses the whole distribution upward

| | MiniLM-L6-v2 (mean) | bge-small (mean, wrong pooling) | bge-small (cls, correct pooling) |
|---|---|---|---|
| worst unrelated score | 0.2051 | 0.5472 | 0.6023 |
| worst related score (incl. the one MiniLM cannot recover) | 0.2001 | 0.5887 | 0.6433 |
| worst related score (excl. that one pair) | 0.3200 | 0.6039* | 0.6652* |
| separation, worst-related excl. vs worst-unrelated | **+0.1149** | +0.0567 | +0.0629 |
| recall/FP at threshold 0.30 | 7/8, 0/6 | 8/8, **6/6** | 8/8, **6/6** |
| recall/FP at threshold 0.45 | 3/8, 0/6 | 8/8, **5/6** | 8/8, **5/6** |
| best workable threshold found | 0.25-0.30 (as shipped) | none in 0.25-0.45; needs re-derivation | ~0.55-0.65, recall 7-8/8, FP 0-1/6 |

\* Under bge-small, the pair MiniLM cannot recover ("switch the database to mongodb...") is no
longer the worst related pair - a different pair (the console.log/pino one) is. The ordering
of which pairs are hardest changes between models, not just the scale.

**The finding that changes the decision:** under MiniLM, an unrelated pair (a CSS variable
rename, a copyright-year bump, a Redis-cache suggestion with no bearing on the decision) sits
comfortably below 0.21 - nowhere near either threshold this codebase uses (0.30 / 0.45). Under
bge-small, the same unrelated pairs score 0.45-0.60, uncomfortably close to where the related
pairs land (0.59-0.79). At the code's current thresholds, bge-small would recover every
related pair (8/8) at the cost of also admitting every single unrelated pair as a false
positive (6/6, at threshold 0.30). A workable threshold exists (roughly 0.55-0.65 with CLS
pooling), but the safety margin there (0.04-0.06) is roughly a fifth of the margin MiniLM
already provides on the pairs it can separate at all (0.11-0.15).

This is a small corpus (14 pairs) built for a different purpose (calibrating MiniLM's
threshold), so it should not be read as a definitive verdict on bge-small in general - the
published MTEB numbers below say it is the stronger model on standard retrieval benchmarks.
It is evidence that, on THIS product's specific text shape (short technical
commit-message/ticket-title pairs) and THIS mechanism (a single fixed cosine threshold
deciding whether to link two decisions), the swap is not a clean win: it trades one hard
failure (the ceiling case) for a systematically thinner safety margin everywhere else.

## Published benchmark numbers (checking the ticket's claim independently)

The ticket asserts bge-small-en-v1.5 has "materially better retrieval quality on standard
embedding benchmarks." Checked rather than taken on faith:

| | MTEB average | MTEB retrieval average |
|---|---|---|
| bge-small-en-v1.5 (BAAI's own model card) | 62.17 | 51.68 |
| all-MiniLM-L6-v2 (commonly cited MTEB figures; sources vary slightly by MTEB version, ~55.9-56.3 average / ~41.9-42.9 retrieval across the sources checked) | ~56 | ~42 |

Roughly +6 points average (+11% relative), roughly +9-10 points retrieval (+23% relative).
The claim holds on standard benchmarks - it just does not transfer cleanly to this corpus's
specific text shape, which is the point of running an evaluation rather than trusting a
leaderboard number for a different task.

## Model size

Checked against the Hugging Face API (`onnx/model_quantized.onnx` plus tokenizer/vocab/config,
the exact set the q8 pipeline fetches):

| | quantized (q8) download |
|---|---|
| Xenova/all-MiniLM-L6-v2 (current) | ~22.8 MiB (~23.9 MB decimal) - matches the "~23MB" already quoted in `local-embeddings.ts`, `setup.ts`, and `docs/local-mode.md` |
| Xenova/bge-small-en-v1.5 | ~33.3 MiB (~34.96 MB decimal) |

The ticket's "~34MB re-download" is the size of the new model's total download, not a delta -
confirmed against the actual file sizes. The incremental cost per existing user upgrading
would be about +10.5 MiB (the new model's cache entries are keyed by a hash of their request
URL, so the old MiniLM cache entries are not reused and become orphaned space rather than
being replaced in place).

## Schema change made anyway

Independent of the model decision, `decision_embeddings` did not know which model produced
each stored vector - a real gap regardless of which model is current, because a future swap
(this one or a different candidate, evaluated with a larger corpus) would otherwise silently
compare incompatible vectors: same-length float arrays from two different models pass
`cosineSimilarity`'s existing length check and produce a plausible, meaningless score.

This ticket adds:
- `decision_embeddings.model` (schema v6), backfilled for every pre-existing row with
  `Xenova/all-MiniLM-L6-v2` - the only model this graph has ever embedded with, verified
  against git history rather than assumed.
- `EMBEDDING_MODEL_ID` / `EMBEDDING_DTYPE` constants in `local-embeddings.ts`, read by both
  pipeline-construction sites (the default Node loader and the WASM binary backend) so the
  model id and dtype are each written once rather than duplicated per backend.
- `setEmbedding` tags every new vector; `findSimilar` (ranking) and `checkDrift`
  (single-decision comparison) exclude/refuse a stored vector tagged with a model other than
  the current one, rather than comparing it.

This is inert today - there has only ever been one model, so nothing is currently tagged
"stale." It means a future model swap only needs to change `EMBEDDING_MODEL_ID` and add a
migration; the "don't silently compare incompatible vectors" guarantee already exists.

## What a follow-up evaluation would need

If bge-small-en-v1.5 (or another candidate) is revisited: re-derive `RETRIEVAL_RELATES_THRESHOLD`
and `RELATES_THRESHOLD` from scratch against it - do not reuse MiniLM's thresholds - and do it
against a corpus closer to ALI-785's original scale (hundreds of pairs across multiple
sources), since a 14-pair corpus is enough to see a compressed distribution but not enough to
be confident about exactly where a safe threshold sits.
