/**
 * ALI-1411: the as-of cutoff (`align mcp --created-before`) applied to every read tool.
 *
 * ALI-1082 bounded only the three tools built on `searchDecisions`, because smart-search is the
 * one gateway route that accepts `created_before`. Every other read tool answered from the whole
 * graph, so a frozen AlignBench run could cite a decision captured after its cutoff - v7 Jira
 * rep 3 failed by citing ALI-391 exactly that way.
 *
 * Where the backend can bound the query it does (conflicts ride the decision-links timestamp
 * cursor). Everything else is filtered HERE, by each row's own `created_at`, because the gateway
 * routes behind them take no as-of parameter. Three rules hold throughout:
 *
 * - **Fail closed.** A row with no timestamp, or one that does not parse, is dropped: an unknown
 *   age is not provably before the cutoff, and a benchmark leak is the failure this exists for.
 *   A response shape this module does not recognise is refused, never passed through.
 * - **Never leak through a summary.** Counts, totals, platform lists and messages computed over
 *   the whole graph are recomputed from the surviving rows or removed. A count that includes a
 *   post-cutoff decision tells the agent it exists.
 * - **No cutoff, no change.** Callers only reach this module when a cutoff is set.
 *
 * ALI-1420: `/alignment/check`, `/decisions/topic-timeline` and `/decisions/:id/impact` now take
 * `created_before` and bound the query server-side (retrieval before the judge, the LIMIT, the
 * traversal's edges), and mcp.ts sends it. The filters below still run as a backstop for a
 * gateway that predates the parameter. They bound on capture time (`created_at`) where the
 * gateway bounds on source time, so a decision decided before the cutoff but captured after it
 * is dropped here - over-pruning, the safe direction.
 *
 * What client-side filtering cannot see on its own (the gateway bound above covers the first
 * three when it supports the parameter):
 * a row's `status` is its status today (a decision superseded after the cutoff still reads
 * `superseded`); an impact-graph EDGE recorded after the cutoff between two older decisions is
 * invisible in that response; `/alignment/check`'s verdict was reached by a judge that saw
 * post-cutoff candidates, so a kept conflict's `reason` prose can still mention one; a kept
 * history event can carry an `acknowledged_at` after the cutoff; and server-side limits (topic timeline 50, conflicts 50) are spent
 * before the filter, so an as-of answer can be shorter than the true as-of graph.
 */
import { type AlignmentResult, type ConflictsResult, GatewayError } from './gateway-client.js';
import type { TimelineRow, TopicTimelineResult } from './mcp-timeline-tools.js';

/** An offset or `Z` at the end of the string - a timestamp that already names its zone. */
const HAS_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * Is `stored` strictly before `cutoff`? False for anything absent or unparseable (fail closed).
 *
 * The local graph stores SQLite's `YYYY-MM-DD HH:MM:SS`, which is UTC with no zone marker, so a
 * zone-less value is read as UTC - the same normalisation local-gateway-client.ts applies.
 * `Date.parse` returns NaN for garbage, and NaN compares false both ways, so it is checked
 * explicitly rather than trusted to fall out of the `<`.
 */
export function isCreatedBefore(stored: unknown, cutoff: string): boolean {
  if (typeof stored !== 'string' || stored.trim() === '') return false;
  let normalised = stored.trim();
  if (!normalised.includes('T')) normalised = normalised.replace(' ', 'T');
  if (!HAS_ZONE.test(normalised)) normalised = `${normalised}Z`;
  const at = Date.parse(normalised);
  const bound = Date.parse(cutoff);
  if (Number.isNaN(at) || Number.isNaN(bound)) return false;
  return at < bound;
}

/** The refusal for a decision the as-of graph does not contain. Names no detail of it. */
export function notInGraphAsOf(id: string, cutoff: string): Error {
  return new Error(`No decision ${id} in the graph as of ${cutoff}.`);
}

export interface AsOfGuard {
  cutoff: string;
  /** Whether a timestamp is strictly before the cutoff. */
  isBefore(stored: unknown): boolean;
  /** Whether a decision, looked up by id, was created before the cutoff. Memoised per guard. */
  decisionBefore(id: string): Promise<boolean>;
  /** Throws `notInGraphAsOf` unless the decision was created before the cutoff. */
  assertDecision(id: string): Promise<void>;
}

/**
 * A lookup that says the decision does not exist (cloud 404, or the local client's "No decision
 * <id> in your local graph"). Such a decision is not in the as-of graph either, so it reads as
 * "not before" - one dangling link endpoint must not fail a whole tool call.
 */
function isNotFound(err: unknown): boolean {
  if (err instanceof GatewayError) return err.statusCode === 404;
  return err instanceof Error && /^No decision \S+ in your local graph/.test(err.message);
}

/**
 * One guard per tool call. Other `getDecision` errors propagate: a failed lookup is not evidence
 * the decision is old OR new, and dropping it silently would change the answer on a network blip.
 */
export function createAsOfGuard(
  cutoff: string,
  getDecision: (id: string) => Promise<unknown>,
): AsOfGuard {
  const seen = new Map<string, Promise<boolean>>();
  const isBefore = (stored: unknown) => isCreatedBefore(stored, cutoff);
  const decisionBefore = (id: string): Promise<boolean> => {
    let known = seen.get(id);
    if (!known) {
      known = getDecision(id).then(
        (row) => isBefore((row as { created_at?: unknown } | null)?.created_at),
        (err: unknown) => {
          if (isNotFound(err)) return false;
          throw err;
        },
      );
      seen.set(id, known);
    }
    return known;
  };
  return {
    cutoff,
    isBefore,
    decisionBefore,
    async assertDecision(id) {
      if (!(await decisionBefore(id))) throw notInGraphAsOf(id, cutoff);
    },
  };
}

function cannotFilter(what: string): Error {
  return new Error(
    `Cannot apply the as-of cutoff to an unrecognised ${what} response, so it is not returned. ` +
      'A result that might include decisions captured after the cutoff is worse than none.',
  );
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * `/alignment/check` takes no as-of parameter. The cited decisions carry no timestamp, so each is
 * looked up. A conflict resting only on a dropped decision is dropped with it, and a verdict that
 * no longer has a surviving conflict is downgraded to retrieval, which claims nothing.
 */
export async function filterAlignmentAsOf(result: AlignmentResult, guard: AsOfGuard): Promise<AlignmentResult> {
  const relevant = Array.isArray(result?.relevant_decisions) ? result.relevant_decisions : [];
  const conflicts = Array.isArray(result?.conflicts) ? result.conflicts : [];
  const ids = [...new Set([...relevant.map((d) => d.id), ...conflicts.map((c) => c.decision_id)])];
  const verdicts = new Map(
    await Promise.all(ids.map(async (id) => [id, typeof id === 'string' && (await guard.decisionBefore(id))] as const)),
  );
  const keptRelevant = relevant.filter((d) => verdicts.get(d.id) === true);
  const keptConflicts = conflicts.filter((c) => verdicts.get(c.decision_id) === true);
  if (keptRelevant.length === relevant.length && keptConflicts.length === conflicts.length) return result;

  let status = result.status;
  if (status !== 'unknown') {
    if (keptConflicts.length > 0) {
      // A conflict against a decision that predates the cutoff is still a finding.
    } else if (status === 'conflicting') {
      status = keptRelevant.length > 0 ? 'retrieved' : 'no-context';
    } else if (keptRelevant.length === 0) {
      status = 'no-context';
    }
  }

  // The gateway's message can name a dropped decision, or count it (local 'unknown' says "Could
  // not check N related decision(s)"), so it is rebuilt from what survived - 'unknown' included.
  const message =
    status === 'unknown'
      ? `Could not check ${keptRelevant.length} related decision(s) recorded before ${guard.cutoff}. ` +
        'This is NOT a pass: treat it as unchecked and review these decisions before proceeding.'
      : status === 'conflicting'
        ? `Potential conflict with ${keptConflicts.length} decision(s).`
        : status === 'no-context'
          ? 'No related decisions found.'
          : status === 'aligned'
            ? `No conflicts with ${keptRelevant.length} related decision(s).`
            : `Found ${keptRelevant.length} related decision(s) to review.`;

  const out: AlignmentResult = {
    ...result,
    status,
    relevant_decisions: keptRelevant,
    ...(result.conflicts !== undefined ? { conflicts: keptConflicts } : {}),
    // The gateway's confidence is a max over candidates that included a dropped decision, so it
    // is recomputed from the survivors' similarity ('unknown' already reports no confidence).
    ...(status !== 'unknown'
      ? { confidence: Math.max(0, ...keptRelevant.map((d) => (typeof d.similarity === 'number' ? d.similarity : 0))) }
      : {}),
    message,
  };
  // The event id and any prior sign-off belong to the verdict the gateway reached. Once that
  // verdict is withdrawn, carrying them would let a person adjudicate a result nobody returned.
  // An 'unknown' result left the dropped decision in its unchecked set, so the same applies.
  if (status !== result.status || status === 'unknown') {
    delete out.check_event_id;
    delete out.prior_adjudication;
  }
  return out;
}

/**
 * Both link shapes: cloud (`created_at` plus embedded `from_decision`/`to_decision`) and local
 * (`createdAt` plus `sourceId`/`targetId`). The EDGE and BOTH endpoints are bounded separately -
 * an edge recorded after the cutoff between two older decisions asserts a relation the as-of
 * graph did not hold, and a backdated edge can still point at a newer decision.
 */
async function linkBefore(link: unknown, guard: AsOfGuard): Promise<boolean> {
  const l = asRecord(link);
  if (!l) return false;
  if (!guard.isBefore(l['created_at'] ?? l['createdAt'])) return false;
  const from = asRecord(l['from_decision']);
  const to = asRecord(l['to_decision']);
  if (from && to) return guard.isBefore(from['created_at']) && guard.isBefore(to['created_at']);
  const a = l['sourceId'] ?? l['from_snapshot'];
  const b = l['targetId'] ?? l['to_snapshot'];
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [okA, okB] = await Promise.all([guard.decisionBefore(a), guard.decisionBefore(b)]);
  return okA && okB;
}

async function keepLinks(links: unknown[], guard: AsOfGuard): Promise<unknown[]> {
  const keep = await Promise.all(links.map((l) => linkBefore(l, guard)));
  return links.filter((_, i) => keep[i]);
}

/**
 * `conflict_count` is recounted from the surviving links. The gateway returns its count fields as
 * null whenever a cursor is sent, and none of them could be trusted as-of anyway, so no gateway
 * count is reported under a cutoff. `next_cursor` is dropped too: it encodes the last RAW row's
 * timestamp and id, which may be a link this filter removed, and no tool takes a cursor.
 */
export async function filterConflictsAsOf(result: ConflictsResult, guard: AsOfGuard): Promise<ConflictsResult> {
  if (!Array.isArray(result?.links)) throw cannotFilter('conflicts');
  const links = await keepLinks(result.links, guard);
  const hasMore = result.pagination?.['has_more'] === true;
  return {
    links,
    ...(result.pagination
      ? { pagination: { has_more: hasMore } }
      : {}),
    conflict_count: links.length,
    ...(hasMore
      ? {
          showing: links.length,
          message: `Showing ${links.length} conflict links recorded before ${guard.cutoff}; more exist, and their total is not available under an as-of cutoff.`,
        }
      : {}),
  };
}

/**
 * Cloud rows carry `created_at` and the traversal `path` from the root. A row reached only
 * through a dropped decision goes too: that route did not exist as of the cutoff. (If the
 * traversal reached it by a second, older route the gateway only reports one path, so this can
 * over-prune - the safe direction.)
 */
function pruneTraversal(rows: unknown[], guard: AsOfGuard): unknown[] {
  const records = rows.map(asRecord);
  const dropped = new Set(
    records.filter((r) => !r || !guard.isBefore(r['created_at'])).map((r) => r?.['id']),
  );
  return rows.filter((_, i) => {
    const r = records[i];
    if (!r || dropped.has(r['id'])) return false;
    const path = Array.isArray(r['path']) ? r['path'] : [];
    return !path.some((id) => dropped.has(id));
  });
}

/** `decision`-rooted cloud shape, or local `{ upstream, downstream }` link rows. */
export async function filterImpactAsOf(result: unknown, guard: AsOfGuard): Promise<unknown> {
  const r = asRecord(result);
  if (r && ('impact' in r || 'dependencies' in r)) {
    const side = (key: 'impact' | 'dependencies', some: (n: number) => string, none: string) => {
      const block = asRecord(r[key]);
      if (!block) return {};
      if (!Array.isArray(block['decisions'])) throw cannotFilter('impact');
      const decisions = pruneTraversal(block['decisions'], guard);
      return {
        [key]: { ...block, count: decisions.length, decisions, summary: decisions.length > 0 ? some(decisions.length) : none },
      };
    };
    return {
      ...r,
      ...side('impact', (n) => `${n} decision(s) depend on this`, 'No downstream dependencies'),
      ...side('dependencies', (n) => `Built on ${n} other decision(s)`, 'No upstream dependencies'),
    };
  }
  if (r && Array.isArray(r['upstream']) && Array.isArray(r['downstream'])) {
    const [upstream, downstream] = await Promise.all([
      keepLinks(r['upstream'], guard),
      keepLinks(r['downstream'], guard),
    ]);
    return { ...r, upstream, downstream };
  }
  throw cannotFilter('impact');
}

/**
 * Filtered BEFORE shapeTopicTimeline, so the shaping contract runs over the as-of rows. Every
 * field that refers to a row is filtered by membership, and every whole-retrieval figure is
 * recomputed. `background_platforms` is deleted so the shaper re-derives it from the survivors;
 * `activity` month buckets are deleted because they cannot be re-derived honestly from rows.
 */
export function filterTopicTimelineAsOf(result: TopicTimelineResult, guard: AsOfGuard): TopicTimelineResult {
  if (!Array.isArray(result?.decisions)) throw cannotFilter('topic timeline');
  const decisions: TimelineRow[] = result.decisions.filter((d) => guard.isBefore(d?.created_at));
  const kept = new Set(decisions.map((d) => d.id));
  const has = (id: unknown) => typeof id === 'string' && kept.has(id);
  const platforms = [...new Set(decisions.map((d) => d.platform).filter((p): p is string => Boolean(p)))].sort();

  const out: TopicTimelineResult = {
    ...result,
    decisions,
    count: decisions.length,
    superseded_count: decisions.filter((d) => d.status === 'superseded' || d.status === 'archived').length,
    platforms,
    spans_platforms: platforms.length > 1,
    // An emptied chain would put every survivor in background and narrate nothing; omitting it
    // takes the shaper's older-gateway path, which narrates all rows.
    ...(Array.isArray(result.chain_ids) && result.chain_ids.some(has)
      ? { chain_ids: result.chain_ids.filter(has) }
      : {}),
    ...(Array.isArray(result.disagreements)
      ? { disagreements: result.disagreements.filter((d) => has(d?.from?.id) && has(d?.to?.id)) }
      : {}),
    ...(Array.isArray(result.why) ? { why: result.why.filter((w) => has(w?.id)) } : {}),
    ...(Array.isArray(result.still_open) ? { still_open: result.still_open.filter((s) => has(s?.id)) } : {}),
  };
  if (!result.chain_ids?.some(has)) delete out.chain_ids;
  delete out.background_platforms;
  delete out.activity;
  return out;
}

/** `GET /decisions/:id/history`: events after the cutoff had not happened yet. */
export function filterDecisionTimelineAsOf(result: unknown, guard: AsOfGuard): unknown {
  const r = asRecord(result);
  if (!r || !Array.isArray(r['events'])) throw cannotFilter('decision timeline');
  const events = r['events'].filter((e) => guard.isBefore(asRecord(e)?.['occurred_at']));
  return { ...r, events, event_count: events.length };
}
