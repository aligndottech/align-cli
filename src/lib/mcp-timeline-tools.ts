/**
 * ALI-1070 slice 1: the "timeline trio", ported from the hosted connector so a customer's
 * agent can reach it through `align mcp`.
 *
 * `align mcp` is the server `align mcp --setup` wires into every customer's agent. It
 * published 8 tools against the hosted endpoint's 24, and the three missing ones ported here
 * are the measured lever on AlignBench's weakest split (`reversed`).
 *
 * THE ENDPOINT IS NOT THE PRODUCT. THE MESSAGE IS.
 *
 * `POST /decisions/topic-timeline` already returns the whole story structure - the chain, the
 * conflicts, the reasons, the open questions. What the hosted connector's topicTimeline.ts
 * adds on top is (a) a projection and (b) a RENDERING CONTRACT in the response message, and
 * the contract is where the measured behaviour lives. A customer handed the rows without the
 * contract gets the data and not the ability to tell a supersession from a correction, which
 * is exactly the split this ticket exists to move. So this module is mostly the message.
 *
 * The contract rides on the response rather than on the server instructions because the
 * message is the one surface guaranteed to be in the calling agent's context at the moment it
 * writes the answer: instructions are truncated around 2KB and some clients never surface
 * them at all.
 *
 * Ported faithfully from connectors/mcp-align/src/tools/topicTimeline.ts with three
 * deliberate differences, each because this server is not that server:
 *
 *  1. TOOL NAMES ARE RENDERED, NOT HARDCODED. The hosted message says "get_decision_rationale";
 *     this server's name for that tool is `align_get_decision_rationale`. Porting the text
 *     verbatim would instruct a customer's agent to call a tool that is not on this server -
 *     the same defect align-stack derives ALIGN_MCP_INSTRUCTIONS_READ_ONLY to prevent, and
 *     pinned here by mcp-timeline-trio.test.ts ("names no align_ tool it does not register").
 *  2. NO decision_url / cite / repository. Those need the hosted connector's FRONTEND_URL and
 *     ~150 lines of its format.ts. The contract's link clause is already conditional ("with
 *     decision_url when present, else source_url"), so it stays TRUE here rather than
 *     promising a field that is absent - the gateway rows do carry source_url.
 *  3. The result is a plain object. This server's createCallToolHandler serialises it and
 *     OMIT_RESULT_KEYS strips the heavy fields, so there is no toolText/framed wrapper.
 */

/** Names this server publishes for the trio. Imported by mcp.ts, so there is one writer. */
export const TOPIC_TIMELINE_TOOL = 'align_get_topic_timeline';
export const DECISION_RATIONALE_TOOL = 'align_get_decision_rationale';
export const DECISION_TIMELINE_TOOL = 'align_get_decision_timeline';

/**
 * The one phrase the tool description and the per-result message both use to gate the
 * full-timeline render. Shared so the two surfaces cannot drift: they are two writers of one
 * fact with no reader that sees both, and each surface's test pins only its own copy.
 */
export const STORY_GATE = 'asked for the story';

const MAX_SUMMARY_CHARS = 500;

function truncate(text: string, max = MAX_SUMMARY_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

/**
 * One row of the gateway's topic timeline. Every field optional but `id`/`title`/`created_at`,
 * because the gateway and this client ship separately and an older one sends fewer.
 */
export interface TimelineRow {
  id: string;
  title: string;
  summary?: string;
  platform?: string;
  status?: string;
  created_at: string;
  /** ALI-622: the source's decision moment. created_at is Align's import day. */
  decided_at?: string | null;
  /** ALI-876: when the artifact was raised in its source. */
  source_created_at?: string | null;
  /**
   * ALI-876: which of the three clocks the gateway resolved for this row. Computed THERE, by
   * the same resolver that ordered the list, so this client never re-derives it - a second
   * implementation of the precedence could disagree with the ordering it is rendering, which
   * is the failure a label is supposed to prevent.
   */
  date_basis?: 'decided' | 'created' | 'recorded';
  source_url?: string;
  matched_by?: string[];
}

export interface TopicTimelineResult {
  topic?: string;
  count?: number;
  superseded_count?: number;
  platforms?: string[];
  spans_platforms?: boolean;
  retrieval?: { lexical?: boolean; semantic?: boolean };
  activity?: Array<{ month: string; count: number }>;
  disagreements?: Array<{ relation?: string; from?: { id?: string }; to?: { id?: string } }>;
  why?: Array<{ id?: string; rationale?: string; risks?: string[] }>;
  still_open?: Array<{ id?: string; questions?: string[] }>;
  chain_ids?: string[];
  background_platforms?: string[];
  decisions?: TimelineRow[];
}

/**
 * The projection is an ALLOWLIST, not a delete.
 *
 * ALI-498: one 12-row prod component carried 43,327 characters of `decision_json`. A delete
 * list only removes the heavy fields somebody thought of; an allowlist cannot leak a field
 * the gateway adds later. OMIT_RESULT_KEYS in mcp.ts is the belt to this braces.
 */
function present(d: TimelineRow) {
  return {
    id: d.id,
    title: d.title,
    ...(d.summary ? { summary: truncate(d.summary) } : {}),
    ...(d.platform ? { platform: d.platform } : {}),
    ...(d.status ? { status: d.status } : {}),
    created_at: d.created_at,
    // Key omitted when absent: a missing source date must not render as one.
    ...(d.decided_at ? { decided_at: d.decided_at } : {}),
    ...(d.source_created_at ? { source_created_at: d.source_created_at } : {}),
    ...(d.date_basis ? { date_basis: d.date_basis } : {}),
    ...(d.source_url ? { source_url: d.source_url } : {}),
    ...(d.matched_by ? { matched_by: d.matched_by } : {}),
  };
}

interface MessageOpts {
  count: number;
  supersededCount: number;
  semanticRan: boolean;
  topic: string;
  backgroundCount: number;
  hasWhy: boolean;
  /** undefined = the gateway never sent the field; 0 = it looked and found none. */
  disagreementCount: number | undefined;
  hasStillOpen: boolean;
  /**
   * Chain-scoped, computed over the NARRATED rows. The gateway's `count`, `platforms` and
   * `superseded_count` cover everything it RETRIEVED, and the compact summary line narrates
   * the CHAIN - interpolating the retrieval-wide numbers there would overstate the chain by
   * exactly the background count, citing decisions the agent has no rows for. One right
   * answer per value, so it is computed rather than left for the model to re-derive.
   */
  chainCount: number;
  chainPlatforms: string[];
  chainSupersededCount: number;
  /**
   * ALI-1010, and deliberately NOT folded into chainSupersededCount. A corrected decision was
   * never true; a superseded one was true and was overtaken. Counting them together is the
   * manufactured history the corrections clause exists to prevent.
   */
  chainCorrectedCount: number;
}

export function topicTimelineMessage(opts: MessageOpts): string {
  const {
    count,
    supersededCount,
    semanticRan,
    topic,
    backgroundCount,
    hasWhy,
    disagreementCount,
    hasStillOpen,
    chainCount,
    chainPlatforms,
    chainSupersededCount,
    chainCorrectedCount,
  } = opts;

  if (count === 0) {
    return `No decisions found about "${topic}". Try a broader phrase, or search to see what the graph does cover.`;
  }

  const history =
    supersededCount > 0
      ? ` ${supersededCount} of them are superseded or archived - that is the history explaining why the current answer is current.`
      : '';

  const partial = semanticRan
    ? ''
    : ' PARTIAL: semantic retrieval was unavailable, so this is lexical matches only and may be missing related decisions that use different wording.';

  /**
   * ALI-1010. The one clause that stops a correction being told as a reversal, and the single
   * clause most responsible for the `reversed` split this port is measured on.
   *
   * Conditional, like `why` and the Contested slot: on a chain with no corrected decision this
   * would send the agent looking for rows that are not there. And it has to NAME the wrong
   * rendering, because everything else in this message pushes the other way - the compact
   * template asks for "the biggest reversal" and the full-timeline rules say "name which
   * decision replaced them". A model handed those and a status it has never seen will reach
   * for the supersession vocabulary it already has.
   *
   * The status is the only signal the agent gets: `superseded` and `corrected` are both
   * not-active and look alike from the row alone, which is exactly why the difference is
   * spelled out here rather than left to be inferred.
   */
  const corrections =
    chainCorrectedCount > 0
      ? ` ${chainCorrectedCount} decision(s) in this chain have status \`corrected\`: the record was NEVER TRUE and has been corrected, which is NOT a reversal and NOT a supersession - nothing changed in the world, the graph simply held something wrong. Say "corrected" or "was never true"; never "replaced", "reversed", "superseded" or "changed their mind" about one of these, and never count it as part of the history explaining why the current answer is current. A corrected decision is excluded from the superseded count above for this reason.`
      : '';

  /**
   * ALI-590, the other load-bearing addition. Without it an agent reads every row it is
   * handed, and on a mature graph most rows are adjacent-but-unrelated - a webhook-security
   * topic pulls legal, DPA and pricing tickets over the 0.25 similarity floor. Naming the
   * count and forbidding the enumeration is what turns 50 rows into a story.
   */
  const background =
    backgroundCount > 0
      ? ` ${backgroundCount} further decision(s) matched this topic loosely and are NOT listed - they are summarised in \`background\`. Say the number in one clause if it is useful ("about a dozen adjacent decisions"); do not ask for them and do not imply the chain is everything.`
      : '';

  /**
   * The `why` clause replaces an explicit instruction to go and call the rationale tool, which
   * produced one follow-up call per interesting decision (five on an observed prod session).
   * The reasons for the arguing decisions are now IN this payload, so the instruction is to
   * use them, and to fall back to the tool only for a decision this payload does not cover.
   *
   * CONDITIONAL on `why` actually being present, because the key is omitted when the gateway
   * sent nothing (an older gateway, or a degraded rationale lookup). Promising a field that is
   * absent is worse than not mentioning it: the agent either hunts for it or decides the
   * reasons are unavailable and does not fall back.
   */
  const why = hasWhy
    ? ` \`why\` carries each arguing decision's reason and logged risks - use it directly and do NOT call ${DECISION_RATIONALE_TOOL} for a decision that appears there; call it only for one that does not appear there${
        // With real questions in the payload the risks synthesis is retired for this response:
        // two stated sources for one section is how the model picks the wrong one (ALI-627).
        hasStillOpen ? '' : ', and draw the closing open-questions line from its risks'
      }.`
    : ` This payload carries no \`why\`, so call ${DECISION_RATIONALE_TOOL} for the decisions whose reasoning the answer needs${
        // Only point at `disagreements` when the field is here AND non-empty. Pointing at one
        // absent field from inside the fallback for another is the same defect nested one
        // level down, and pointing at an empty list is a hunt with no quarry.
        (disagreementCount ?? 0) > 0 ? ' - prefer the ones named in `disagreements`' : ''
      }.`;

  /**
   * Conditional for the same reason as the `why` clause: an instruction naming a field that is
   * not in the payload sends the agent hunting, and on an older gateway neither key exists.
   * Every clause here must be true of THIS response, not of the newest gateway.
   */
  const disagreements =
    disagreementCount === undefined
      ? ' This payload does not report which decisions conflict, so say the conflict relationships were unavailable rather than implying there are none.'
      : disagreementCount === 0
        ? ' The gateway looked for conflicts touching this chain and found none - say so in one clause rather than staying silent.'
        : ' Fill the **Contested** slot naming the ids in `disagreements` and say a later decision argues with them - in both the compact answer and the full timeline, because a hidden conflict is the one thing compaction must never buy.';

  /**
   * A worked TEMPLATE, not adjectives about clarity - in TWO tiers.
   *
   * A live prod run produced a correct answer as seven dense paragraphs: unreadable on a
   * shared screen. "Render this as a story, not a flat list" is an adjective - it names what
   * to avoid and says nothing about shape. A line template fixes ordering, length and where
   * the status goes; "be concise" fixes nothing. The word cap is a number for the same reason:
   * it is checkable, and a model asked to "keep it brief" writes a sentence per entry and
   * rebuilds the wall.
   */
  // The Contested slot exists only when there is a conflict to put in it: a slot over an empty
  // or absent list sends the model hunting (the same conditionality rule as `why` above).
  const contestedSlot =
    (disagreementCount ?? 0) > 0
      ? '\n\n**Contested:** {which decision argues with which, one line}'
      : '';
  // The offer names only what THIS payload carries: risks ride in `why`, questions in
  // `still_open`, and promising an absent one makes the follow-up a hunt or an invention.
  const offerItems = `the full chain${hasWhy ? ', the open risks' : ''}${
    hasStillOpen ? ', the open questions' : ''
  }`;

  const render =
    ' Answer COMPACTLY by default, never as paragraphs - the user asked a question, not for a history. Link every decision you name (dated row, Now, Contested, supersedes) with decision_url when present, else source_url; do not invent links. Use exactly this shape, with a blank line between sections:' +
    `\n\n**Now:** {current position in one sentence} - {title} ({status})${contestedSlot}` +
    `\n\n{up to three pivotal dated chain steps - the first position, the biggest reversal, the newest - one line each, in the full timeline's line shape}` +
    `\n\n${chainCount} decision(s) across ${
      chainPlatforms.join(', ') || 'unknown tool(s)'
    } got it here ({oldest date} - {newest date}, ${chainSupersededCount} superseded or archived).` +
    '\n\n{the single sharpest open question, one line}' +
    `\n\n{one-line offer of the rest - ${offerItems} - inviting the user to ask for the story}` +
    `\n\nRender the FULL VERTICAL TIMELINE instead ONLY when the user ${STORY_GATE}, the history, or how it got here - or as the follow-up after the compact answer. That shape, also with a blank line between sections:` +
    '\n\nOpen with the same **Now:** line, then:' +
    '\n\n**How it got here**' +
    '\n`DD Mon`  `{platform}`  **{short title}** - {why, max 15 words} - {cite or id} - {status}' +
    '\n`DD Mon`  `{platform}`  **{short title}** - ... (one line per decision, oldest first)' +
    '\n\n`{platform}` is the tool the decision was made in - teams, slack, jira, github, linear, confluence. NEVER omit the platform: a Teams meeting contradicting a GitHub pull request is the thing no single tool can show, and it is invisible if every line looks alike. The cite implies it for some rows and not others, so print it explicitly on all of them.' +
    '\n\nThe gutter is the date and NEVER an id: print the row\'s date, not a ticket key, and never the same identifier twice on one line. `date_basis` says which clock it is - `decided` (`decided_at`, the source decided it), `created` (`source_created_at`: RAISED only, never agreed), `recorded` (`created_at`, Align\'s ingest minute, not a source date). Suffix anything not `decided` right after the date - `(raised)` or `(seen)` - or a column of dates all reads as decisions. Where several share a date, normal for an imported backlog, repeat the date. If MOST are `recorded`, add ONE closing note that the graph lacks their source dates.' +
    '\n\n**Open risks** - one short line each, naming the decision it came from.';

  /**
   * Two sources, one section, stated conditionally (ALI-627). With `still_open` present the
   * section closes on the decisions' own stated questions; without it, the synthesis from
   * risks remains - a promise scoped to THIS response, like the `why` clause above.
   */
  // Both trailing sections are tier-labelled: without a label they read as unconditional
  // rules of the compact default too, which quietly rebuilds the wall.
  const stillOpenSection = hasStillOpen
    ? '\n\n**Still open** (the full timeline closes on this) - one line per question in `still_open`, naming the decision it came from; end with the single sharpest.'
    : '\n\n**Still open** (the full timeline closes on this) - the single sharpest unanswered question, one line.';

  const renderRules =
    '\n\nRules for the FULL timeline: ONE LINE PER DECISION, never a paragraph. Max 15 words of explanation per line. Mark superseded entries and name which decision replaced them. Cite decision_url and source_url as different links (the decision page vs where it was decided).';

  return `${count} decision(s) about "${topic}".${history}${corrections}${partial}${background}${render}${stillOpenSection}${renderRules}${disagreements}${why}`;
}

/**
 * Shape one gateway topic-timeline response for an agent: project the rows, split the chain
 * from the background, and attach the rendering contract.
 *
 * Pure, and exported, so every clause of the contract is assertable without standing up an
 * MCP server or a gateway.
 */
export function shapeTopicTimeline(
  result: TopicTimelineResult,
  requestedTopic: string,
): Record<string, unknown> {
  const rows: TimelineRow[] = Array.isArray(result?.decisions) ? result.decisions : [];
  const semanticRan = result?.retrieval?.semantic !== false;

  /**
   * The chain is what gets narrated; everything else is counted (ALI-590).
   *
   * `chain_ids` is a NEWER gateway field, and this client and the gateway deploy separately -
   * so an older gateway (or one whose edge lookup degraded) sends no ids and every decision
   * stays in the chain, which is the pre-ALI-590 behaviour. Falling back to "narrate
   * everything" is the right direction to fail: a shorter answer that silently dropped
   * history is the one nobody could detect.
   */
  const chainIds = Array.isArray(result.chain_ids) ? new Set(result.chain_ids) : undefined;
  const chain = chainIds ? rows.filter((d) => chainIds.has(d.id)) : rows;
  const background = chainIds ? rows.filter((d) => !chainIds.has(d.id)) : [];

  const backgroundPlatforms = Array.isArray(result.background_platforms)
    ? result.background_platforms
    : [...new Set(background.map((d) => d.platform).filter((p): p is string => Boolean(p)))].sort();

  /**
   * Both shape fields are scoped to the CHAIN, not to the retrieved set.
   *
   * The gateway computes them over everything it retrieved, which is right for a payload that
   * returns everything it retrieved. This tool returns only the chain, so forwarding them
   * unfiltered would name a decision that is not in `decisions` - enumerating background
   * material through the back door and citing titles the agent cannot link.
   */
  const inChain = chainIds
    ? (id: unknown) => typeof id === 'string' && chainIds.has(id)
    : () => true;

  /**
   * `undefined` when the gateway did not send the field, `[]` only when it sent an empty one.
   *
   * Those are different answers and collapsing them loses the honest one: an empty array from
   * a gateway that never reports disagreements asserts "we looked and there are none", which
   * is the stronger claim. A gateway that DID look and found nothing keeps its empty array -
   * that is a real result, and it is how the absence gets reported.
   */
  const disagreements = Array.isArray(result.disagreements)
    ? result.disagreements.filter((d) => inChain(d?.from?.id) && inChain(d?.to?.id))
    : undefined;
  const why = (Array.isArray(result.why) ? result.why : []).filter((w) => inChain(w?.id));
  // Chain-scoped like `why`: a question naming a background decision would cite a title the
  // agent has no row for.
  const stillOpen = (Array.isArray(result.still_open) ? result.still_open : []).filter((s) =>
    inChain(s?.id),
  );

  return {
    topic: result.topic ?? requestedTopic,
    count: result.count ?? rows.length,
    superseded_count: result.superseded_count ?? 0,
    platforms: result.platforms ?? [],
    spans_platforms: Boolean(result.spans_platforms),
    retrieval: result.retrieval ?? { lexical: true, semantic: semanticRan },
    ...(Array.isArray(result.activity) ? { activity: result.activity } : {}),
    ...(disagreements ? { disagreements } : {}),
    // Forwarded verbatim: the gateway already clipped every string and never sends
    // decision_json, so there is nothing left for this projection to bound.
    ...(why.length > 0 ? { why } : {}),
    ...(stillOpen.length > 0 ? { still_open: stillOpen } : {}),
    decisions: chain.map(present),
    /**
     * Counted, never enumerated. The whole defect this fixes is an agent reading 50 rows
     * aloud, so handing the tail back in any listable form would reintroduce it - the count
     * and the platforms are enough to say "there is more here" honestly.
     */
    ...(background.length > 0
      ? {
          background: {
            count: background.length,
            platforms: backgroundPlatforms,
            note: 'Matched the topic loosely - not part of the decision chain. Not listed on purpose.',
          },
        }
      : {}),
    message: topicTimelineMessage({
      count: result.count ?? rows.length,
      supersededCount: result.superseded_count ?? 0,
      semanticRan,
      topic: result.topic ?? requestedTopic,
      backgroundCount: background.length,
      hasWhy: why.length > 0,
      disagreementCount: disagreements === undefined ? undefined : disagreements.length,
      hasStillOpen: stillOpen.length > 0,
      chainCount: chain.length,
      chainPlatforms: [
        ...new Set(chain.map((d) => d.platform).filter((p): p is string => Boolean(p))),
      ],
      chainSupersededCount: chain.filter((d) => d.status === 'superseded' || d.status === 'archived')
        .length,
      // Counted separately, never added to the line above: the gateway's RETIRED set draws the
      // same boundary, and the two must agree or the message contradicts the payload.
      chainCorrectedCount: chain.filter((d) => d.status === 'corrected').length,
    }),
  };
}
