# Implementation Plan: CLI value-moment readout (ALI-215)

## Overview
Give the solo dev an autonomous "what your graph did for you" readout - value units
(conflicts caught / duplicates / supersessions / reuse rate), not vanity ("N decisions").
Surface chosen (Tom, 2026-07-13): the **status readout**. Cloud = full (calls the gateway
aggregate endpoints); local = honest subset (derived from local SQLite `decision_links`),
clearly labelled, no fabricated offline reuse-rate/health.

## Research reference
`align-stack/thoughts/shared/research/2026-07-13-cli-value-moment-surface.md`. Gateway
endpoints (all authMiddleware-only, free-CLI reachable; gate-8 telemetry verified on preview
2026-07-13):
- `GET /stats` -> `{ snapshots, ... }`
- `GET /alignment/impact?days=` -> `{ total (conflicts caught), precision, adjudicated }`
- `GET /decision-links?paginated=true` -> `pagination.{conflicts_count, supersessions_count, duplicates_count, relates_count}`
- `GET /decision-health` -> `{ compositeScore: { overall, grade } }`
- `GET /decisions/reuse-rate?days=` -> `{ referenced, rediscovered, rate }` (shipped #1205)

Local (align-cli): `createLocalDb().getStats()` (`src/lib/local-db.ts`) + `listLinks({relation})`
- can count decisions + conflicts + duplicates + supersessions from `decision_links.relation`.
Cannot compute reuse-rate or composite health (no gateway).

## Key existing files
- `src/commands/local.ts:31-47` - `align local status` (local-only today: Decisions/Embeddings/Conflicts).
- `src/lib/gateway-client.ts:132-387` - `buildHttpGatewayClient` (add value-rollup calls here, mirror `request<T>()`).
- `src/lib/local-db.ts` - `getStats()` + `listLinks()` (extend the local subset).
- `src/index.ts:47-80` - command registration (no top-level `align status` exists yet).
- `src/commands/why.ts:90` / `drift.ts:50` - existing "Share with your team: pricing" nudge pattern to reuse.

## Behavior To-Do List (Test List) - two examples per rule
**Value-rollup fetcher (cloud) - `fetchValueRollup(client)`:**
- [ ] VR1a: aggregates the 5 endpoints into `{ decisions, conflictsCaught, duplicates, supersessions, reuseRate }` (given stubbed responses -> mapped object).
- [ ] VR1b: a *second* set of stub values maps through (forces real field wiring, not constants).
- [ ] VR2 (resilient): if one endpoint call rejects (e.g. `/decisions/reuse-rate` 404 on an old gateway), the rollup still returns the others with that field `null` - never throws the whole readout.
- [ ] VR3 (reuse-rate null): `rate: null` from the gateway renders as "n/a", not "null%" or a crash.

**Local subset - `localValueRollup(db)`:**
- [ ] LV1a: counts decisions + conflicts + duplicates + supersessions from `decision_links` by relation (given seeded links).
- [ ] LV1b: a different seed (2 duplicates, 1 supersedes) yields those exact counts.
- [ ] LV2: reuseRate and healthGrade are `undefined`/omitted for local (no fabrication).

**Rendering - `renderValueReadout(rollup, { mode })`:**
- [ ] RR1: names value units - "conflicts caught", "duplicates", "superseded" - not "connections".
- [ ] RR2 (vanity guard): a rollup with only decisions and zero value signals still renders the value labels (0 conflicts caught), never collapses to "N decisions" only.
- [ ] RR3 (local label): local mode output states reuse-rate/health need cloud (honest subset).
- [ ] RR4 (earned nudge): when there's real value (>=1 conflict/duplicate/supersede), append the sharing-ceiling upgrade nudge; not shown on an empty graph.

**Command wiring:**
- [ ] CW1: `align status` (cloud) prints the full readout via the gateway rollup.
- [ ] CW2: `align local status` prints the local subset readout (extends the current 3-line output; keep it working when local mode inactive -> existing "run align local start" message).

## Success criteria
- [ ] Autonomous value readout on cloud + local using the verified-stable counts.
- [ ] Names conflicts-caught / duplicates / supersessions / reuse (value), not just "decisions".
- [ ] Earned upgrade nudge tied to the sharing ceiling.
- [ ] TDD; `npm run typecheck && npm run lint && npm test && npm run build` all green.
- [ ] Local readout is an honest subset (no offline reuse-rate/health).

---

## Phase 1: cloud value-rollup fetcher
RED: `src/lib/__tests__/value-rollup.test.ts` - stub a gateway client with the 5 methods,
assert `fetchValueRollup` maps to the normalized object (VR1a/b), tolerates one rejection
(VR2), passes `rate:null` through (VR3).
GREEN: add `getReuseRate`, `getConflictImpact`, `getLinkCounts` (`?paginated=true`),
`getHealth` methods to `buildHttpGatewayClient` (mirror `request<T>()`), and a
`fetchValueRollup(client)` that `Promise.allSettled`s them into the normalized shape
(rejected -> that field null). Nothing extra.

## Phase 2: local subset rollup
RED: `localValueRollup` counts by relation from a seeded local db (LV1a/b), omits
reuse/health (LV2).
GREEN: extend `local-db` with per-relation counts (or use `listLinks({relation}).length`);
map to the same normalized shape minus reuseRate/healthGrade.

## Phase 3: renderer
RED: `renderValueReadout` names value units (RR1), keeps them on an empty graph (RR2),
labels local subset (RR3), appends the earned nudge only with real value (RR4).
GREEN: a pure string-builder (chalk), no I/O - easy to unit test.

## Phase 4: wire commands
RED: `align status` cloud path calls the rollup + renders (CW1); `align local status`
renders the local subset (CW2), preserving the inactive-mode message.
GREEN: add a top-level `status` command in `src/index.ts` (cloud) + extend
`local status` in `src/commands/local.ts`. Reuse the renderer for both.

## Phase 5: gate + mutation
`npm run typecheck && npm run lint && npm test && npm run build`. Scoped in-head mutation
litmus on the rollup mapping + the render branch logic (nudge threshold, null-rate).

## Rollback
Additive: new lib files + client methods + one new command + `local status` extension.
Revert the branch; no schema/gateway change (the reuse-rate route already shipped in #1205).

## Open questions
1. Top-level `align status` vs only extending `align local status`? Plan adds BOTH (cloud
   `align status` + local `align local status`), sharing the renderer. Confirm at sign-off.
2. `days` window for the impact/reuse calls - default 30 (matches the gateway defaults).
