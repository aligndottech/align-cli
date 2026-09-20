import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
const { version } = pkg;
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore, type EnvironmentConfig, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { detectEditors, removeMcpConfig, writeMcpConfig } from '../lib/mcp-setup.js';
import { commandIntro } from '../lib/brand.js';
import { recordFunnelStage } from '../lib/usage-telemetry.js';
import { inviteNudgeLine } from '../lib/invite-prompt.js';
import { renderMcpInstructions } from '../lib/mcp-instructions.shared.js';
import { withDecisionRelationContract } from '../lib/decision-relations.js';
import {
  DECISION_RATIONALE_TOOL,
  DECISION_TIMELINE_TOOL,
  shapeDecisionRationale,
  shapeTopicTimeline,
  STORY_GATE,
  TOPIC_TIMELINE_TOOL,
} from '../lib/mcp-timeline-tools.js';

// Server-level instructions (ALI-120): surfaced to the agent so it reaches for Align
// proactively - without the user prompting - the moment this MCP server is connected.
//
// ONE text with the hosted server (ALI-952): the shared body lives in
// mcp-instructions.shared.ts, byte-identical to align-stack's copy and pinned by
// mcp-instructions-parity.test.ts. This server only supplies its names for the shared
// tokens, plus the per-server lines for tools whose NAME differs between the two servers.
// Every tool it exposes is one the hosted server also has; the remaining hosted-only tools
// (check_proposed_action, rate_conflict, coach) are appended on that side.
//
// ALI-1070 added the first per-server line here: this server now exposes the topic timeline,
// so it carries the hosted guidance sentence rendered with ITS name for the tool. That line
// is CLOUD ONLY (see instructionsFor) because local mode has no implementation for it. The
// graph-identity suffix is also added per environment by instructionsFor, and the whole
// rendered text stays under the ~2KB Claude Code truncates server instructions to
// (mcp-graph-identity.test.ts).
export const ALIGN_MCP_INSTRUCTIONS = renderMcpInstructions(
  { check_alignment: 'align_check_alignment', search: 'align_ask' },
  [],
);

/**
 * F2 (Copilot, #296 inline at mcp.ts:52): the topic-timeline guidance is CLOUD ONLY.
 *
 * The first port put this line in the shared base, which `instructionsFor` serves to BOTH
 * modes. Local mode has no `getTopicTimeline` - the local-mode Proxy throws on every call, and
 * mcp-timeline-trio-local.test.ts measures exactly that - so the line shipped a
 * guaranteed-fail instruction to every local user. An instruction naming a tool that cannot
 * work is the defect this trio was ported as a trio to avoid, one level up.
 *
 * It stays a per-server line rather than moving into mcp-instructions.shared.ts because the
 * two servers spell this tool differently (`get_topic_timeline` hosted,
 * `align_get_topic_timeline` here), so it cannot live in a text with one spelling. align-stack
 * keeps its own copy in HOSTED_ONLY_LINES for the same reason, which is why the byte-identical
 * parity test is unaffected on both sides.
 */
const CLOUD_ONLY_LINES = [
  `- For "the story on X" or "how did we end up here", call ${TOPIC_TIMELINE_TOOL} - it returns the whole supersession chain in one call.`,
];

/**
 * Which decision graph THIS server reads, appended to the base instructions.
 *
 * Three Align MCP servers are commonly connected at once - align-prod, align-preview, and this
 * CLI - with near-identical tool names, and none of them said which graph it answers from. An
 * agent choosing between them had no basis to choose, so it took align_ask because the
 * instructions named it first, and answered a question about the hosted product from a laptop
 * SQLite file holding four seeded demo decisions.
 *
 * Naming the source is what lets the model pick correctly, instead of the human remembering to
 * disconnect a server before every session.
 */
function graphIdentity(env: EnvironmentConfig): string {
  if (env.mode === 'local-embedded') {
    return (
      '\n\nTHIS SERVER READS THE LOCAL DECISION GRAPH stored on this machine, not a hosted Align ' +
      'tenant. It holds only what has been captured or imported locally. If another Align server ' +
      'is connected, prefer it for questions about a team or a product, and use this one for what ' +
      'is on this machine.'
    );
  }
  // Naming the host matters when prod and preview are both connected: they hold different
  // graphs and answer the same question differently.
  return `\n\nThis server reads the hosted Align graph at ${env.gatewayUrl}.`;
}

/**
 * Server instructions for the environment actually being served.
 *
 * Budget: re-derive rather than trusting a number written here. mcp-graph-identity.test.ts
 * pins both modes under 2048, and local is the binding case because its graph-identity suffix
 * is the longest.
 */
export function instructionsFor(env: EnvironmentConfig): string {
  const base =
    env.mode === 'local-embedded'
      ? ALIGN_MCP_INSTRUCTIONS
      : renderMcpInstructions(
          { check_alignment: 'align_check_alignment', search: 'align_ask' },
          CLOUD_ONLY_LINES,
        );
  return base + graphIdentity(env);
}

/**
 * Tool schemas with the retrieval tools' descriptions marked with the graph they search.
 *
 * Only the two that READ the graph are rewritten. A client picks a tool by its description, and
 * capture/check tools are unambiguous - editing them would be churn that makes a future diff
 * harder to read for no gain in disambiguation.
 */
export function toolSchemasFor(env: EnvironmentConfig): typeof TOOL_SCHEMAS {
  const local = env.mode === 'local-embedded';
  // ALI-1063 follow-up: local-embedded search cannot report whether a matched decision has
  // been superseded (see local-gateway-client.ts - decision_links only ever holds an untyped
  // 'relates' edge locally, never a typed supersedes/contradicts one). Rather than staying
  // silent about that gap, tell the agent what to do instead: when two results cover the
  // same topic, the newer decided_at/created_at is the one more likely to still hold.
  const suffix = local
    ? ' Searches the LOCAL decision graph on this machine, not a hosted Align tenant. ' +
      "This local graph does not track whether a decision has been superseded - if two " +
      'results cover the same topic, prefer the one with the most recent decided_at or ' +
      'created_at. That is a heuristic, not a verified status.'
    : ` Searches the hosted Align graph at ${env.gatewayUrl}.`;
  /**
   * ALI-1070 follow-up: the two tools local mode cannot serve say so.
   *
   * They stay REGISTERED - deregistering per mode is a larger change and the Proxy stub is
   * honest when reached. What was missing is any way for an agent reading descriptions to know
   * before it calls. The rationale tool is deliberately NOT marked: it works locally, because
   * the local client implements getDecision, so a blanket warning over all three would be
   * false about one of them.
   */
  const cloudOnly = local
    ? ' NOT AVAILABLE IN LOCAL MODE: this local graph has no implementation for it, so the call will fail. Use align_ask to search the local graph instead, or a cloud environment for this tool.'
    : '';
  return TOOL_SCHEMAS.map(tool => {
    if (tool.name === 'align_ask' || tool.name === 'align_search') {
      return { ...tool, description: tool.description + suffix };
    }
    if (cloudOnly && (tool.name === TOPIC_TIMELINE_TOOL || tool.name === DECISION_TIMELINE_TOOL)) {
      return { ...tool, description: tool.description + cloudOnly };
    }
    return tool;
  });
}

// Heavy internal fields that bloat the model's context without helping it reason.
// MCP responses go straight into the agent's context window, so we omit these and
// serialize compactly (no pretty-print whitespace) - see "MCP context cost".
const OMIT_RESULT_KEYS = new Set(['embedding', 'embeddings', 'vector', 'decision_json', 'raw_text']);

export function serializeMcpResult(result: unknown): string {
  return JSON.stringify(result, (key, value) => (OMIT_RESULT_KEYS.has(key) ? undefined : value));
}

// The MCP CallTool router: maps an agent's tool call to the gateway client. Exported
// and pure so the routing - argument extraction, the align_capture URL->platform
// classifier, the local-mode raw-text rule, and the unknown-tool guard - is testable
// without standing up an MCP server. Returns the raw result; the caller serializes it.
export async function dispatchTool(
  name: string,
  args: Record<string, unknown> | undefined,
  client: ReturnType<typeof createGatewayClient>,
  env: EnvironmentConfig,
  createdBefore?: string,
): Promise<unknown> {
  // A required argument that never arrived used to reach the implementation and fail
  // from wherever the undefined landed: a missing `diff` surfaced as the tokenizer's
  // `text may not be null or undefined`, raised to the agent as JSON-RPC -32603. That
  // names nothing it passed and nothing it could pass instead. The required set is read
  // from TOOL_SCHEMAS - the same declaration tools/list hands the agent - so there is one
  // writer of what a tool needs rather than a second copy that can drift from it.
  const schema = TOOL_SCHEMAS.find((t) => t.name === name) as
    | { inputSchema?: { required?: readonly string[] } }
    | undefined;
  const missing = (schema?.inputSchema?.required ?? []).filter((key) => {
    const value = args?.[key];
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  });
  if (missing.length) {
    const names = missing.map((k) => `"${k}"`).join(' and ');
    throw new Error(
      `${name} requires ${names}. Call it again with ${missing.length > 1 ? 'those arguments' : 'that argument'} ` +
      'set to a non-empty value.',
    );
  }

  switch (name) {
    // ONE arm for both names (ALI-952). align_search is the alias of align_ask: they were two
    // entries for the same gateway call with two dispatch arms that had already drifted
    // (align_search passed no limit, align_ask defaulted to 8). The question is passed
    // through unchanged so the gateway's smart-search strategy selector can route it to
    // semantic search (ALI-105); align_search's `query` is the same text under the old name.
    // ALI-1066/ALI-1092: the relation context the gateway attaches to a non-active hit
    // (`successor`, `conflicts_with`) reaches the agent through this arm. It already did -
    // serializeMcpResult is a denylist, so an unrecognised field passes through - and what
    // withDecisionRelationContract adds is that a NULL never does. `"conflicts_with":null`
    // tells an agent no conflict exists, which is a different claim from "not provided".
    // See lib/decision-relations.ts for the whole reasoning and what it deliberately leaves alone.
    case 'align_search':
    case 'align_ask':
      return withDecisionRelationContract(await client.searchDecisions(
        (args?.['question'] ?? args?.['query']) as string,
        (args?.['limit'] as number | undefined) ?? 8,
        createdBefore,
      ));
    case 'align_capture': {
      const input = args?.['input'] as string;
      let platform = 'cli';
      try {
        const url = new URL(input);
        platform = 'web';
        if (/slack\.com/.test(url.hostname)) platform = 'slack';
        else if (/atlassian\.net\/browse/.test(input)) platform = 'jira';
        else if (/atlassian\.net\/wiki/.test(input)) platform = 'confluence';
        else if (/github\.com/.test(url.hostname)) platform = 'github';
        else if (/linear\.app/.test(url.hostname)) platform = 'linear';
      } catch {
        if (env.mode !== 'local-embedded') {
          throw new Error('align_capture requires a URL. Raw text capture is not supported in cloud mode.');
        }
        // Local mode: accept plain text directly (platform stays 'cli').
      }
      return client.captureDecision(input, platform);
    }
    case 'align_check_alignment':
      return client.checkAlignment(args?.['diff'] as string, args?.['context'] as string | undefined);
    case 'align_check_drift':
      return client.checkDrift(args?.['decision_id'] as string, args?.['content'] as string, args?.['source_type'] as string | undefined);
    case 'align_get_impact':
      return client.getImpact(args?.['decision_id'] as string);
    case 'align_get_conflicts':
      return client.getConflicts();
    // Same shape, same agent, same contract - a row reaching an agent through this tool must not
    // say "no conflict exists" where the other two say nothing.
    case 'align_get_related_decisions':
      return withDecisionRelationContract(
        await client.searchDecisions(`${args?.['file_path'] as string} ${args?.['context'] ?? ''}`, 5, createdBefore),
      );
    /**
     * ALI-1070. The gateway already returns the whole story structure; what this arm adds is
     * the projection and the RENDERING CONTRACT (mcp-timeline-tools.ts). Rows without the
     * contract give a customer the data and not the ability to tell a supersession from a
     * correction, which is the AlignBench split this port is measured on - so the shaping is
     * not optional polish, it is the deliverable.
     *
     * `limit` is passed through undefined when the agent omitted it: the default lives in the
     * client, so there is one writer of it.
     */
    case TOPIC_TIMELINE_TOOL:
      return shapeTopicTimeline(
        await client.getTopicTimeline(
          args?.['topic'] as string,
          args?.['limit'] as number | undefined,
        ),
        args?.['topic'] as string,
      );
    /**
     * Reuses getDecision - the hosted connector's getDecisionRationale is the same
     * `GET /snapshots/:id`, so a second client method would be two writers of one call. It
     * also means this tool WORKS IN LOCAL MODE for free: the local client implements
     * getDecision, so the local-mode Proxy passes it straight through instead of throwing
     * the cloud-only stub. The local row carries no decision_json, so the reasoning fields
     * are thinner there - honest degradation, not a failure.
     */
    case DECISION_RATIONALE_TOOL: {
      // F7: PROJECTED, not returned raw. serializeMcpResult strips `decision_json`, which is
      // where every field this tool promises lives - so the raw form answered with metadata
      // and silently dropped the rationale. The raw id goes to the client (local mode does a
      // database lookup with it); encoding is the HTTP boundary's job.
      const row = await client.getDecision(args?.['decision_id'] as string);
      return shapeDecisionRationale(row as unknown as Record<string, unknown>, args?.['decision_id'] as string);
    }
    case DECISION_TIMELINE_TOOL:
      return client.getDecisionTimeline(args?.['decision_id'] as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * ALI-949: did this tool call hand the agent a real answer from the graph? The three tools
 * an agent reaches for to GET something (ask, search, check) count; a non-empty conflicts
 * list or an impact graph does not - those are follow-ups, not the first useful decision.
 * A check whose status is `no-context` or `unknown` found nothing or could not run
 * (ALI-414: not a pass), so it is not useful either.
 */
export function isFirstUsefulToolResult(name: string, result: unknown): boolean {
  if (name === 'align_ask' || name === 'align_search') {
    const results = (result as { results?: unknown[] } | undefined)?.results;
    return Array.isArray(results) && results.length > 0;
  }
  if (name === 'align_check_alignment') {
    const status = (result as { status?: string } | undefined)?.status;
    return status === 'aligned' || status === 'conflicting' || status === 'retrieved';
  }
  return false;
}

/**
 * The MCP CallTool handler `align mcp` installs, extracted so the funnel emission is
 * testable without standing up a Server (mcp-first-useful.test.ts). dispatchTool stays the
 * pure router; this is the one place a tool call has a side effect beyond its result.
 *
 * first_useful_decision fired only from a non-empty `align ask` before ALI-949, so an agent
 * asking through this server never counted - and the phases after that ticket exist to
 * make the agent the usual asker. The once-per-install guard is recordFunnelStage's, shared
 * with `align ask`; fired without await so the tool response never waits on telemetry.
 */
export function createCallToolHandler(
  client: ReturnType<typeof createGatewayClient>,
  env: EnvironmentConfig,
  createdBefore?: string,
): (request: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return async (request) => {
    const { name, arguments: args } = request.params;
    const result = await dispatchTool(name, args, client, env, createdBefore);
    if (isFirstUsefulToolResult(name, result)) {
      void recordFunnelStage(env, 'first_useful_decision', 'mcp');
    }
    return { content: [{ type: 'text', text: serializeMcpResult(result) }] };
  };
}

// Order is the ranking an agent reads off tools/list, so the pre-flight check leads (ALI-139,
// prescription over retrieval; ALI-952 moved it here from fourth). The hosted server
// (align-stack mcpServer.ts) registers check_alignment first for the same reason.
/**
 * Tool annotations, mirroring connectors/mcp-align/src/mcpServer.ts's canonical vocabulary
 * (ALI-326 there, ALI-1063 here). A client cannot tell `align_ask` from `align_capture`
 * without these, and the one consumer that most needs to - AlignBench's align arm, which
 * runs under the Claude Agent SDK with permissions bypassed and no MCP gating on
 * `allowedTools` - would otherwise have to hardcode which tools write. A hardcoded list
 * goes stale the first time a tool is added; an annotation travels with the tool.
 *
 * In mcp-align exactly four tools write: rate_conflict, check_drift, capture, connect.
 * This server exposes two of them (capture, check_drift); the rest are reads.
 */
const READS = { readOnlyHint: true, destructiveHint: false } as const;
const WRITES_ADDITIVE = { readOnlyHint: false, destructiveHint: false } as const;

export const TOOL_SCHEMAS = [
  {
    name: 'align_check_alignment',
    annotations: READS,
    description: 'BEFORE writing or changing significant code, call this with the proposed change to surface prior decisions across ALL the user\'s tools (Slack, Jira, GitHub, git) that it conflicts with or relates to. A "conflict" status means the change opposes a past decision - stop and confirm with the user before proceeding. An "unknown" status means the check could not run and is NOT a pass: the decisions it returns are unchecked, so stop and ask the human rather than treating it as clear.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'Git diff or description of proposed change' },
        context: { type: 'string', description: 'Additional context (branch name, PR title)' },
      },
      required: ['diff'],
    },
  },
  {
    name: 'align_ask',
    annotations: READS,
    description: 'Ask a natural language question and get answers from the decision graph. Use this when the user asks "how", "what was decided about", or any question about past decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural language question about decisions (e.g. "do we use postgres", "how does auth work", "what was decided about caching")' },
        limit: { type: 'number', description: 'Max answers (default: 8)', default: 8 },
      },
      required: ['question'],
    },
  },
  {
    name: 'align_search',
    annotations: READS,
    description: 'Alias of align_ask: the same search of the decision graph, taking the text as `query`. Kept for callers that already use this name; prefer align_ask.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 8)', default: 8 },
      },
      required: ['query'],
    },
  },
  {
    name: 'align_capture',
    annotations: WRITES_ADDITIVE,
    description: 'Capture a decision from ANY tool - a Slack thread, Jira ticket, GitHub PR, Confluence/doc URL, or raw text. Call this whenever a decision gets made in conversation so the cross-tool decision graph stays current and relationships across tools can be detected.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'URL or text content of the decision to capture' },
      },
      required: ['input'],
    },
  },
  {
    name: 'align_check_drift',
    annotations: WRITES_ADDITIVE,
    description: 'Check if code or configuration has drifted from a specific decision',
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: { type: 'string', description: 'ID of the decision to check against' },
        content: { type: 'string', description: 'Code or config content to compare' },
        source_type: { type: 'string', description: 'Type of content: code, config, documentation' },
      },
      required: ['decision_id', 'content'],
    },
  },
  {
    name: 'align_get_impact',
    annotations: READS,
    description: 'Get the upstream and downstream impact of a decision',
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: { type: 'string', description: 'Decision ID to analyze' },
      },
      required: ['decision_id'],
    },
  },
  {
    name: 'align_get_conflicts',
    annotations: READS,
    description:
      'List conflicts and contradictions in the decision graph. conflict_count is the exact total; the links list holds one page, and a message says when there are more than it shows - never present the listed links as the complete set unless they match conflict_count.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'align_get_related_decisions',
    annotations: READS,
    description: 'BEFORE editing a file or module, call this to learn what was already decided about it across all the user\'s connected tools (not just code) - surfacing the cross-tool context an agent would otherwise miss.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path or module name' },
        context: { type: 'string', description: 'Additional code context' },
      },
      required: ['file_path'],
    },
  },

  /**
   * ALI-1070: the timeline trio, ported from the hosted server (mcp-align).
   *
   * APPENDED rather than ranked high on purpose. Order is the ranking an agent reads off
   * tools/list, and the existing eight encode ALI-139's "prescription over retrieval"
   * decision with the pre-flight check leading. Re-ranking that is a separate product call;
   * the lever for routing an agent to the timeline tool is the instructions line above,
   * which names it for exactly the questions it answers.
   *
   * All three are READS, so the write set stays at two (mcp-tool-annotations.test.ts).
   *
   * Registered next to each other, and the descriptions do the disambiguating, because the
   * names are one word apart and an agent picks from descriptions alone.
   */
  {
    name: TOPIC_TIMELINE_TOOL,
    annotations: READS,
    // The full-render prose is GATED, not merely preceded by a compact sentence: this is the
    // one surface some clients act on alone, and a description that says compact-by-default
    // and then unconditionally prescribes the walk talks the default out of existence. The
    // gate phrase is shared with the per-result message via STORY_GATE so the two surfaces
    // cannot drift.
    description:
      `Everything the team ever decided about a TOPIC, in time order, across every connected tool. Use for "what is the story on X", "how did we end up here", or onboarding onto an unfamiliar area. Includes superseded and archived decisions, because the retired past is what explains why the current answer is current. Not to be confused with ${DECISION_TIMELINE_TOOL}, which is the change history of ONE decision. Answer compactly by default: the current standard first in one sentence, the contested line when decisions disagree, up to three pivotal dated steps, a one-line chain summary, and the sharpest open question the chain leaves open - then offer the rest. Only when the user ${STORY_GATE} or asks the follow-up, render the full timeline: walk the supersession chain oldest first - which decision replaced which, active vs superseded - with each step's why from ${DECISION_RATIONALE_TOOL}, keep each decision's source_url inline with that decision rather than in a trailing sources list, put the status beside the title, and close with the still-open risks, each naming which decision it came from. When the payload carries \`still_open\`, those are the decisions' own stated open questions - close on them.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The topic to trace, e.g. "connection pooling" or "authentication strategy"' },
        limit: { type: 'number', description: 'Max decisions to return (default 50, capped at 200)' },
      },
      required: ['topic'],
    },
  },
  {
    name: DECISION_RATIONALE_TOOL,
    annotations: READS,
    description: 'Retrieve the rationale, goals, risks, and context behind a specific decision. Use this when you need to understand WHY a decision was made - the reasoning, trade-offs, and constraints that led to it.',
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: { type: 'string', description: 'The decision ID to retrieve rationale for' },
      },
      required: ['decision_id'],
    },
  },
  {
    name: DECISION_TIMELINE_TOOL,
    annotations: READS,
    description: 'Get the chronological history of events for a decision - when it was created, when conflicts were detected, when it was acknowledged or resolved. Use to understand how a decision has evolved over time.',
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: { type: 'string', description: 'The decision ID to get history for' },
      },
      required: ['decision_id'],
    },
  },
];

/**
 * ALI-1082: --created-before is a harness/audit-only bound (AlignBench's align arm passes
 * it so it cannot see decisions the graph captured after a corpus item's frozen `asOf`).
 * Fail closed at startup rather than silently accepting a value that does nothing:
 *
 * - Local-embedded mode has no server-side query to attach the bound to (the local graph
 *   answers from SQLite directly, not through the gateway route that enforces it), so a
 *   flag that appeared to work there would be lying.
 * - Anything that is not an offset-bearing ISO-8601 instant is rejected the same way the
 *   gateway's own `created_before` filter rejects it (services/gateway/src/routes/
 *   decisions/smartSearchFilters.ts) - a bare calendar date (the shape the benchmark
 *   corpus's `asOf` field itself carries) is refused rather than coerced, because the
 *   caller must decide the instant in UTC, not have Postgres resolve a date-only literal
 *   against the session TimeZone.
 */
const OFFSET_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// Copilot (#302, mcp.ts:514): the pattern above checks SHAPE, not that the digits form a
// real calendar instant - `Date.parse` silently rolls a non-existent day into the next
// month (`2026-02-31T00:00:00Z` -> 2026-03-03) instead of rejecting it, so a corrupted
// cutoff could pass the shape check and the fail-closed contract would be lying. This
// reconstructs the instant from its own matched components and rejects any value whose
// round trip does not land back on the digits the caller typed - which is what a bare
// `Date.parse` cannot distinguish from a value it silently normalised.
function isRealCalendarInstant(value: string, match: RegExpExecArray): boolean {
  const [, year, month, day, hour, minute, second] = match.map(Number) as unknown as number[];
  const asUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(asUtc.getTime())) return false;
  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day &&
    asUtc.getUTCHours() === hour &&
    asUtc.getUTCMinutes() === minute &&
    asUtc.getUTCSeconds() === second
  );
}

export function validateCreatedBeforeFlag(value: string, env: EnvironmentConfig): void {
  if (env.mode === 'local-embedded') {
    throw new Error(
      `--created-before is not supported in local-embedded mode: the local graph has no ` +
      `server-side query to enforce the bound against, so accepting it would silently do ` +
      `nothing. Got: ${value}`,
    );
  }
  const match = OFFSET_ISO_PATTERN.exec(value);
  // The offset's own range (e.g. +99:99) and an out-of-range hour/minute/second (25:00,
  // 00:61) are already rejected by Date.parse below - only the calendar-day case needs
  // the reconstruction above, since JS normalises it instead of erroring.
  if (!match || Number.isNaN(Date.parse(value)) || !isRealCalendarInstant(value, match)) {
    throw new Error(
      `--created-before must be an offset-bearing ISO-8601 timestamp, e.g. ` +
      `2026-08-11T00:00:00.000Z - a bare date is not enough, it must resolve to one real instant. Got: ${value}`,
    );
  }
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run Align as an MCP server for any MCP-capable agent (Claude, Cursor, VS Code, Windsurf, Zed, Codex, Gemini, ...)')
    .option('--env <env>', 'Environment')
    .option('--setup', 'Interactively configure your MCP-capable agents to use Align as an MCP server')
    .option('--install', 'Configure agents - alias for --setup')
    .option('--remove', 'Remove Align from your agents\' MCP config')
    .option('--created-before <iso>', 'Hide decisions captured at or after this ISO-8601 instant (benchmark/audit use)')
    .addHelpText('after', `
Claude Code config (~/.claude.json or workspace .mcp.json):
  {
    "mcpServers": {
      "align": { "command": "align", "args": ["mcp"] }
    }
  }
`)
    .action(async (opts: { env: EnvName; setup?: boolean; install?: boolean; remove?: boolean; createdBefore?: string }) => {
      if (opts.remove) {
        await runMcpRemove();
        return;
      }
      if (opts.setup || opts.install) {
        await runMcpSetup(opts.env);
        return;
      }

      const config = createConfigStore();
      // Local mode serves every tool this server exposes, so a no-account user who ran
      // `align local start` is routed there rather than at an anonymous cloud gateway -
      // otherwise the agent's very first call 401s. A logged-in user is never redirected.
      const resolvedEnv = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const env = config.getEnvironment(resolvedEnv);
      const client = createGatewayClient(env);

      // ALI-1082: fail closed BEFORE the server ever connects - a bound that silently does
      // nothing is worse than no bound.
      if (opts.createdBefore !== undefined) {
        validateCreatedBeforeFlag(opts.createdBefore, env);
      }

      const server = new Server(
        { name: 'align', version },
        { capabilities: { tools: {} }, instructions: instructionsFor(env) },
      );

      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolSchemasFor(env) }));

      server.setRequestHandler(CallToolRequestSchema, createCallToolHandler(client, env, opts.createdBefore));

      // MCP protocol requires clean stdout; log startup to stderr
      // ALI-1082: the cutoff is named in the banner whenever one is set, so a benchmark
      // run's own transcript records that the bound was active - a bound nobody can see in
      // the log is a bound nobody can audit afterwards.
      const createdBeforeSuffix =
        opts.createdBefore !== undefined ? `, created-before: ${opts.createdBefore}` : '';
      process.stderr.write(
        `align mcp server started (env: ${resolvedEnv}, gateway: ${env.gatewayUrl}${createdBeforeSuffix})\n`,
      );
      // ALI-938: a URL asks someone to go figure it out later; the invite command is
      // something they can act on right there. See invite-prompt.ts.
      process.stderr.write(`${inviteNudgeLine('value')}\n`);

      const transport = new StdioServerTransport();
      await server.connect(transport);
    });
}

/**
 * The undo for the automatic wiring setup does (ALI-776).
 *
 * Setup connects detected agents without asking, which is only defensible because the write
 * is additive and reversible. This is that reversibility, and it needs to be one command -
 * "delete the align key from each of these JSON files" is not an undo anyone will perform.
 *
 * No prompt: the user typed --remove. Asking them to confirm the thing they just asked for
 * is the ceremony this whole change is about removing.
 */
async function runMcpRemove(): Promise<void> {
  p.intro(commandIntro('align mcp --remove'));

  const editors = detectEditors();
  if (!editors.length) {
    p.log.info('No MCP agent detected on this machine, so there is nothing to remove.');
    p.outro('Done.');
    return;
  }

  let removed = 0;
  for (const target of editors) {
    try {
      if (removeMcpConfig(target)) {
        removed++;
        p.log.success(`${target.name}: align removed from ${[target.configPath, target.hooks?.path].filter(Boolean).join(' and ')}`);
      } else {
        // Said explicitly rather than silently skipped: "nothing happened" and "it was never
        // there" look identical otherwise, and only one of them is reassuring.
        p.log.info(`${target.name}: no align entry, nothing to remove`);
      }
    } catch (err) {
      p.log.warn(`${target.name}: ${(err as Error).message}`);
    }
  }

  p.outro(
    removed > 0
      ? `Removed from ${removed} agent${removed === 1 ? '' : 's'}. Restart your editor. ${chalk.dim('align mcp --setup')} puts it back.`
      : 'Nothing to remove.',
  );
}

async function runMcpSetup(env?: EnvName): Promise<void> {
  p.intro(commandIntro('align mcp --setup'));

  const editors = detectEditors();
  if (!editors.length) {
    const envArgs = env && env !== 'prod' ? `, "--env", "${env}"` : '';
    p.log.warn(
      'No MCP agent detected automatically. Align works with any MCP-capable agent.\n' +
      'Add this config manually to your agent\'s MCP settings:\n\n' +
      `  { "mcpServers": { "align": { "command": "align", "args": ["mcp"${envArgs}] } } }`,
    );
    p.outro('Done.');
    return;
  }

  p.log.info(`Detected ${editors.length} agent${editors.length > 1 ? 's' : ''}:`);
  for (const e of editors) p.log.info(`  ${e.name} - ${e.configPath}`);
  console.log('');

  const selected = await p.multiselect({
    message: 'Which agents should use Align as an MCP server?',
    options: editors.map(e => ({ value: e.name, label: e.name })),
    required: true,
  });
  if (p.isCancel(selected)) { p.cancel('Cancelled.'); process.exit(0); }

  for (const name of selected as string[]) {
    const target = editors.find(e => e.name === name)!;
    const spinner = p.spinner();
    spinner.start(`Configuring ${name}...`);
    try {
      const files = writeMcpConfig(target, env === 'prod' || !env ? undefined : env);
      spinner.stop(`${name}: align added to MCP servers${target.hooks ? ', pre-edit check hooked' : ''} (${files.join(', ')})`);
    } catch (err) {
      spinner.stop(`${name}: failed - ${(err as Error).message}`);
    }
  }

  const outroText = `${chalk.green('Done.\n\n')}Restart your editor, then ask:\n${chalk.dim('  "What has my team decided about authentication?"\n\n')}${chalk.dim(inviteNudgeLine('value'))}`;
  p.outro(outroText);
}
