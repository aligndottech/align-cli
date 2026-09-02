import type { EnvironmentConfig } from './config.js';
import { createLocalGatewayClient } from './local-gateway-client.js';
import pkg from '../../package.json' with { type: 'json' };

/**
 * ALI-403: identify the CLI to the gateway on every call.
 *
 * Without this the CLI is anonymous - a request from `align` carries exactly the same
 * identifying headers as one from the web app, so cloud-mode CLI usage is only visible as
 * generic tenant activity and CLI retention cannot be counted at all.
 *
 * Read from package.json rather than a literal so a release cannot ship a stale version
 * string, which would make the number wrong in the one direction nobody would notice.
 */
export const CLIENT_IDENTITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-align-client': 'cli',
  'x-align-client-version': pkg.version,
  'User-Agent': `@aligndottech/cli/${pkg.version}`,
});

/**
 * What getConflicts returns (ALI-587). `conflict_count` is the gateway's exact whole-set
 * total (`pagination.total_count`, computed without any cursor), so it stays honest however
 * many links the page holds; `showing` and `message` appear only when the rendered list is
 * smaller than that total. Declared here, not re-typed in tests - the MCP tool serialises
 * this object straight into an agent's context.
 */
export interface ConflictsResult {
  links: unknown[];
  pagination?: Record<string, unknown>;
  conflict_count: number;
  showing?: number;
  message?: string;
}

export interface ConnectorInfo {
  key: string;
  name: string;
  status: 'active' | 'inactive' | 'error';
  configured: boolean;
  description?: string;
}

export interface ConnectorHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  connector: string;
}

export interface CapturedDecision {
  id: string;
  title: string;
  summary: string;
  platform: string;
  status?: string;
  /**
   * Where it was decided. The /snapshots wire has always carried this
   * (gateway listSnapshots selects it); the type just never declared it,
   * so nothing downstream could cite a decision (ALI-602 needs to).
   */
  source_url?: string | null;
  /** The minute the row was imported (local) or captured (cloud). */
  created_at?: string;
  /** ALI-829: when the decision was MADE, from the source's own timestamp. Absent, never
   *  null, when the source did not say. The local client returns it whenever the row has
   *  one; the cloud gateway stores it from ingest (this client renames the item's
   *  created_at to decided_at on the wire) and returns it where its routes select it. */
  decided_at?: string;
  ai?: {
    risks?: string[];
    actions?: Array<{ text: string }>;
    decisions?: string[];
  };
}

export interface SearchResults {
  results: Array<{
    id: string; title: string; summary: string; status: string;
    similarity?: number; author?: DecisionAuthor | null; created_at?: string;
    // ALI-829: the source's own date, beside created_at and never instead of it - two
    // fields, two meanings. Local search always carries it when the row has one; cloud
    // search has selected it since ALI-622 (align-stack snapshotSearch.ts).
    decided_at?: string;
    // Attribution an agent needs to CITE a decision rather than just repeat its
    // title: which repository it came from, how a human writes it (align-cli#76),
    // and the URL it was decided at. Optional because a decision from Slack or a
    // meeting has no repository, and omitting beats emitting an empty string.
    platform?: string; source_url?: string; repository?: string; cite?: string;
    // Present only in cloud mode, where a hosted UI can actually serve it.
    decision_url?: string;
    // ALI-796: local-only (decision_refs lives in the local SQLite graph, not the
    // hosted gateway yet) - what this decision's text points at, so `align ask` can
    // name a gap on the decision it just returned.
    external_references?: Array<{ ref: string; platform: string }>;
  }>;
  count: number;
  strategy: 'semantic' | 'keyword';
  /**
   * ALI-798: which repo local mode scoped this search to, or null if it searched
   * everything (outside a git repo, or `--all`). Absent in cloud mode, which has no
   * repo dimension - a caller distinguishes "unscoped" (null) from "not applicable"
   * (undefined) when deciding whether to print "answering from X".
   */
  scope?: string | null;
}

/**
 * Why an alignment check could not reach a verdict (ALI-414 / ALI-348).
 *
 * The `brain_*` codes come from the cloud gateway (`/alignment/check`), the rest
 * from the local embedded client. Both are listed because this one type describes
 * both clients' responses, and an agent branching on `reason` sees either.
 *
 * This spells the local half twice, here and as `ClassifierFailureReason`. That drift
 * cannot ship silently: `local-gateway-client.ts` assigns one to the other, so adding a
 * classifier reason without adding it here fails `tsc`, which is how ALI-420 found it.
 */
export type UnknownReason =
  | 'brain_timeout'
  | 'brain_error'
  | 'brain_degraded'
  | 'no_llm_key'
  | 'classifier_error'
  | 'classifier_unparseable'
  | 'unvetted_local_model';

export interface AlignmentResult {
  /**
   * `unknown` means the check did NOT run - it is not a pass. Anything that cannot
   * produce a verdict (no LLM key, a classifier that timed out, unparseable output)
   * lands here rather than in `aligned`, so a consumer that branches on `status`
   * cannot mistake "could not check" for "checked, no conflict". See ALI-414.
   */
  // 'retrieved' = related decisions only, NOT adjudicated (gateway #1415, depth:'related').
  status: 'aligned' | 'conflicting' | 'no-context' | 'unknown' | 'retrieved';
  /** Populated only when `status` is `unknown`. */
  reason?: UnknownReason;
  /**
   * WHICH KIND of unknown, and therefore what remedies it (ALI-710).
   *
   * 'unavailable' - the check could not run, and a re-run can heal it.
   * 'non_verdict' - the judge ran and abstained. A re-run returns the same answer forever,
   *   so only a person can move it.
   *
   * Optional because an older gateway does not send it, and a consumer must treat its
   * absence as "cannot tell" rather than as either class.
   */
  reason_class?: 'unavailable' | 'non_verdict';
  /**
   * The persisted event id behind this result - present on conflicting verdicts and
   * stable non-verdicts, absent on aligned/no-context and on outages, so its absence is
   * what stops a person signing off an outage. `align adjudicate` takes it (the gateway
   * refuses adjudication of anything but a non-verdict); for a conflict it is what
   * rating and the PR-outcome join key on (ALI-761).
   */
  check_event_id?: string;
  /**
   * A named person's answer for this exact content, if one already exists.
   *
   * The nested keys are camelCase while every other wire type in this file is snake_case,
   * which looks like a mistake and is not. `request()` returns `res.json()` untransformed,
   * so these have to match the gateway byte for byte, and its repository maps the row there:
   * `adjudicatedBy: row.adjudicated_by` (align-stack, PostgresCheckAdjudicationRepository's
   * toRecord). The outer key is snake_case because the ROUTE spells it, and the inner ones
   * are camelCase because a use case does - two writers, one payload. Verified against the
   * merged gateway rather than assumed; change either side and both move.
   */
  prior_adjudication?: {
    verdict: 'accepted' | 'conflicting';
    adjudicatedBy: string;
    adjudicatedAt: string;
    checkEventId: string;
  };
  confidence: number;
  relevant_decisions: Array<{ id: string; title: string; summary: string; similarity: number; url?: string }>;
  conflicts?: Array<{
    decision_id: string;
    title: string;
    summary?: string;
    url?: string;
    reason: string;
    reasons?: string[];
    severity: 'warning' | 'critical';
  }>;
  message: string;
}

export interface WhoAmI {
  user: { id: string; email: string; role: string };
  tenant: { id: string; name: string };
}

export interface ImportJob {
  id: string;
  connector_key: string;
  status: string;
  progress: { items_processed: number; suggestions_created: number };
  created_at: string;
}

export interface ScanRun {
  id: string;
  status: string;
  connectors: string[];
  progress: { jobs_total: number; jobs_completed: number; total_suggestions: number };
  created_at: string;
}

export interface Suggestion {
  id: string;
  suggested_title: string;
  confidence: number;
  status: string;
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  space_type: string;
}

export interface DecisionLink {
  id: string;
  relation: string;
  from_decision: { id: string; title: string };
  to_decision: { id: string; title: string };
  confidence: number;
}

export interface DriftItem {
  decision_id: string;
  title: string;
  drift_severity: string;
  drift_summary: string;
  checked_at: string;
}

// "Who to talk to" author (ALI-118) and the ingest item shape are the single
// source of truth in @aligndottech/connector-core - imported + re-exported here
// so the rest of the CLI keeps importing them from this module.
import type { FetcherItem as BatchIngestItem, DecisionAuthor } from '@aligndottech/connector-core';
import type { CheckDepth } from './check-depth.js';
export type { DecisionAuthor, BatchIngestItem };

export interface BatchIngestResult {
  snapshots: Array<{
    id: string;
    title: string;
    summary: string;
    analysis?: {
      relatedDecisions: Array<{
        id: string;
        title: string;
        relationship: string;
        confidence: number;
      }>;
    };
  }>;
}

export class GatewayError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'GatewayError';
  }
}

function buildHttpGatewayClient(env: EnvironmentConfig) {
  const { gatewayUrl, authToken, tenantId } = env;

  function buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) h['Authorization'] = `Bearer ${authToken}`;
    if (tenantId) h['x-tenant-id'] = tenantId;
    return h;
  }

  /**
   * ALI-462: refuse a tenant that nothing authenticates, before the request goes out.
   *
   * `ALIGN_TENANT_ID` and `ALIGN_TOKEN` are read independently (`config.ts`), so a tenant
   * with no token is representable. No CLI flow produces it - `login-flow.ts` sets the token
   * first and the tenant only after `/me` succeeds - so it is reachable only by exporting
   * the one variable without the other.
   *
   * Against a gated route that config is a bare 401 explaining nothing. Against an ungated
   * one it is worse: the gateway honours `x-tenant-id` when there is no auth context, so it
   * serves a tenant the caller was never authorised for. Twelve such routes are still
   * ungated (ALI-459, blocked by ALI-458), so this is live rather than theoretical.
   *
   * `demo` mode is deliberately exempt. Addressing a local gateway by tenant header with no
   * bearer is precisely what demo mode is for, and an existing test pins it. `local-embedded`
   * never reaches this client at all.
   *
   * Thrown BEFORE request()'s try block on purpose: inside it, the catch rewrites every
   * non-GatewayError into "Cannot reach gateway", which is the opposite of legible.
   */
  function assertAuthenticatedIdentity(): void {
    if (env.mode !== 'auth' || !tenantId || authToken) return;
    throw new Error(
      `A tenant is configured (${tenantId}) but no token is, so this request cannot be authenticated. ` +
      'Run `align login` for this environment. If ALIGN_TENANT_ID is set in your shell, ' +
      'either unset it or set ALIGN_TOKEN alongside it.',
    );
  }

  async function request<T>(path: string, options: Parameters<typeof fetch>[1] = {}): Promise<T> {
    assertAuthenticatedIdentity();
    try {
      const res = await fetch(`${gatewayUrl}${path}`, {
        ...options,
        // Identity is applied LAST so a caller passing its own `headers` cannot drop it. Every
        // other header stays caller-overridable, as before.
        headers: {
          ...buildHeaders(),
          ...(options.headers as Record<string, string> ?? {}),
          ...CLIENT_IDENTITY_HEADERS,
        },
      });
      if (!res.ok) {
        let detail = '';
        try { const body = await res.json() as any; detail = body?.detail || body?.error || ''; } catch (_) { /* non-JSON error body */ }
        throw new GatewayError(
          detail ? `Gateway returned ${res.status} for ${path}: ${detail}` : `Gateway returned ${res.status} for ${path}`,
          res.status,
        );
      }
      return res.json() as Promise<T>;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(`Cannot reach gateway at ${gatewayUrl}`, 0);
    }
  }

  return {
    async whoami(): Promise<WhoAmI> {
      return request<WhoAmI>('/auth/me');
    },

    // GET /integrations returns { all: ConnectorConfig[], enabled: string[] }
    // Merge into a flat ConnectorInfo[] with status derived from the enabled list
    async listConnectors(): Promise<ConnectorInfo[]> {
      const data = await request<{ all: Array<{ key: string; name: string; description?: string }>; enabled: string[] }>('/integrations');
      const enabledSet = new Set(data.enabled);
      return data.all.map(c => ({
        key: c.key,
        name: c.name,
        description: c.description,
        status: enabledSet.has(c.key) ? 'active' : 'inactive',
        configured: enabledSet.has(c.key),
      }));
    },

    // GET /integrations/:key/health returns { ok: boolean }
    async getConnectorHealth(key: string): Promise<ConnectorHealth> {
      try {
        const data = await request<{ ok: boolean }>(`/integrations/${key}/health`);
        return { status: data.ok ? 'healthy' : 'unhealthy', connector: key };
      } catch {
        return { status: 'unhealthy', connector: key };
      }
    },

    // POST /integrations/:key/enable returns { auth_url }
    async startOAuth(key: string): Promise<{ authUrl: string }> {
      const data = await request<{ auth_url: string }>(`/integrations/${key}/enable`, { method: 'POST', body: '{}' });
      return { authUrl: data.auth_url };
    },

    // GET /oauth/cli-start/:key?port=PORT&nonce=NONCE - authenticated, returns browser OAuth URL for CLI flow
    async startCliOAuth(key: string, port: number, nonce: string): Promise<{ authUrl: string }> {
      const data = await request<{ auth_url: string }>(`/oauth/cli-start/${key}?port=${port}&nonce=${nonce}`);
      return { authUrl: data.auth_url };
    },

    async disableConnector(key: string): Promise<void> {
      await request(`/integrations/${key}/disable`, { method: 'POST', body: '{}' });
    },

    // URL capture only — gateway's registry.resolveUrl() handles detection from the URL
    // Raw text capture is not supported by POST /ingest (no cli:// pattern in registry)
    async captureDecision(input: string, platform: string): Promise<CapturedDecision> {
      return request<CapturedDecision>('/ingest', {
        method: 'POST',
        body: JSON.stringify({ source_url: input, platform }),
      });
    },

    // `scope` is accepted so callers (ask, search) can pass the same three arguments
    // regardless of which client resolveEnv handed back - see the file-top comment on
    // "local mode returns the SAME shapes as the cloud client". The cloud gateway has no
    // repo dimension (ALI-798 is local-only), so this is silently ignored HERE - the
    // command layer is what warns when a user asks for repo scoping in cloud mode,
    // because only it knows whether the user actually typed the flag.
    async searchDecisions(q: string, limit = 10, _scope?: { repo?: string; all?: boolean }): Promise<SearchResults> {
      return request<SearchResults>('/decisions/smart-search', {
        method: 'POST',
        body: JSON.stringify({ q, limit }),
      });
    },

    async listDecisions(params: Record<string, string | number | boolean> = {}): Promise<CapturedDecision[]> {
      const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]));
      return request<CapturedDecision[]>(`/snapshots?${qs}`);
    },

    async getDecision(id: string): Promise<CapturedDecision & { external_references: unknown[]; spaces: unknown[] }> {
      return request(`/snapshots/${id}`);
    },

    // `depth: 'related'` returns the same embedding retrieval this endpoint already does and
    // skips the ~11s LLM adjudication (gateway #1415). The editor hook uses it because every
    // host budget is <=10s; `align check` and the PR bot keep the default 'full'.
    // `depth: 'exhaustive'` is the other end (ALI-708): the gateway's similarity cost gate
    // does not skip adjudication, for callers whose failure policy makes `unknown` fatal.
    // Requires a gateway that knows the member - an older one rejects the VALUE with a 400
    // (unknown keys it strips, unknown enum values it refuses), so ship the gateway first.
    /**
     * Answer a check that reached the judge and declined to rule (ALI-710).
     *
     * The gateway refuses a caller it can identify as an agent, so this is a human's act by
     * construction rather than by convention. It also refuses an event that is not a
     * non-verdict, which is why there is no verdict vocabulary for "could not check" here:
     * an outage is not something a person can sign off.
     */
    async adjudicateCheck(
      eventId: string,
      verdict: 'accepted' | 'conflicting',
      note?: string,
    ): Promise<{
      verdict: 'accepted' | 'conflicting';
      adjudicatedBy: string;
      alreadyAdjudicated: boolean;
    }> {
      return request(`/alignment/checks/${encodeURIComponent(eventId)}/adjudicate`, {
        method: 'POST',
        body: JSON.stringify({ verdict, ...(note ? { note } : {}) }),
      });
    },

    async checkAlignment(
      diff: string,
      context?: string,
      opts: {
        depth?: CheckDepth;
        title?: string;
        /**
         * ALI-761: who is running the check ('github-actions' from the align-check action)
         * and what it is checking ('github:acme/repo#12', the PR HEAD sha). Sent as a
         * header + two body fields, CHECK-SCOPED on purpose: a client-wide platform claim
         * would also relabel `align adjudicate`, which the gateway refuses from agents.
         * All optional; absent means absent, so a caller outside CI changes nothing.
         */
        platform?: string;
        subjectKey?: string;
        headSha?: string;
      } = {},
    ): Promise<AlignmentResult> {
      return request<AlignmentResult>('/alignment/check', {
        method: 'POST',
        ...(opts.platform ? { headers: { 'x-align-platform': opts.platform } } : {}),
        body: JSON.stringify({
          action_type: 'pull_request',
          content: diff.slice(0, 8000),
          context: context?.slice(0, 1000),
          ...(opts.depth ? { depth: opts.depth } : {}),
          // The decision being proposed, in words. Without it the gateway adjudicates on
          // `Proposed: <first 200 chars of the diff>`, which for a diff is a file header and a
          // few `+` lines (align-stack#1652).
          //
          // Spread rather than `title: opts.title`, because the gateway's schema rejects an
          // empty string and an older gateway strips the key it does not know - so an absent
          // title has to mean absent, not present-and-empty. Sliced to 300 to match that
          // schema's max: a longer title is a 400, and truncating here beats failing the check.
          ...(opts.title ? { title: opts.title.slice(0, 300) } : {}),
          // Labels only, never keys (the gateway matches adjudications on a digest of the
          // content it was sent) - what makes a gate verdict joinable to its PR outcome.
          ...(opts.subjectKey ? { subject_key: opts.subjectKey } : {}),
          ...(opts.headSha ? { head_sha: opts.headSha } : {}),
        }),
      });
    },

    async resolveConflict(params: {
      decision_id: string;
      resolution_type: 'honored' | 'overridden' | 'context_changed';
      resolution_note?: string;
      context?: string;
    }): Promise<{ recorded: boolean }> {
      return request<{ recorded: boolean }>('/alignment/conflicts/resolve', {
        method: 'POST',
        body: JSON.stringify(params),
      });
    },

    async checkDrift(decisionId: string, content: string, sourceType = 'manual_input'): Promise<unknown> {
      return request(`/decisions/${decisionId}/drift-check`, {
        method: 'POST',
        body: JSON.stringify({ source_type: sourceType, content }),
      });
    },

    async getImpact(decisionId: string): Promise<unknown> {
      return request(`/decisions/${decisionId}/impact`);
    },

    async getConflicts(): Promise<ConflictsResult> {
      // ALI-587. One 50-row fetch was served to agents as the complete conflict set, with
      // nothing marking a tenant past 50 links as partial. The honest total costs nothing
      // extra: the gateway computes pagination.total_count over the WHOLE matching set on
      // every paginated call (its count query deliberately excludes the cursor), so a
      // single page at the old width already carries the exact number. Fetching wider
      // would buy a WORSE count - a client-side tally capped by however many pages get
      // walked - plus a second round trip on the agent hot path, which is why this is
      // deliberately not a cursor-following port of mcp-align's getAllDecisionLinkPages
      // (that client filters fetched rows locally, so it needs them; this one does not).
      // unresolved_only (ALI-587, decided once with mcp-align): this tool reports ACTIVE
      // conflicts, so resolved links are excluded - and the gateway applies the same
      // predicate to its count query, so total_count and the links describe one population.
      const data = await request<{
        links?: unknown[];
        pagination?: Record<string, unknown> & { total_count?: number | null };
      }>('/decision-links?relation=conflicts_with,contradicts&unresolved_only=true&paginated=true&limit=50');
      if (!Array.isArray(data?.links)) {
        // A shape this client does not understand must fail loudly. Degrading to an empty
        // list reads as an affirmative "no conflicts" to the agent consuming this.
        throw new Error(
          'unexpected /decision-links response shape: expected { links: [...] } - is the gateway older than cursor pagination?',
        );
      }
      const links = data.links;
      const total =
        typeof data.pagination?.total_count === 'number' ? data.pagination.total_count : links.length;
      return {
        links,
        // The page's own envelope, verbatim: has_more/next_cursor genuinely describe the
        // returned links, so a consumer that pages on from here skips nothing.
        ...(data.pagination ? { pagination: data.pagination } : {}),
        conflict_count: total,
        ...(total > links.length
          ? {
              showing: links.length,
              message: `Showing the first ${links.length} of ${total} conflict links.`,
            }
          : {}),
      };
    },

    // ALI-215 value-moment signals (all authMiddleware-only, free-CLI reachable).
    async getStats(): Promise<{ snapshots?: number }> {
      return request('/stats');
    },
    async getConflictImpact(days = 30): Promise<{ total?: number; precision?: number | null }> {
      return request(`/alignment/impact?days=${days}`);
    },
    async getLinkCounts(): Promise<{ conflicts_count?: number; duplicates_count?: number; supersessions_count?: number; relates_count?: number }> {
      const data = await request<{ pagination?: Record<string, number> }>('/decision-links?paginated=true&limit=1');
      return data.pagination ?? {};
    },
    async getReuseRate(days = 30): Promise<{ referenced: number; rediscovered: number; rate: number | null }> {
      return request(`/decisions/reuse-rate?days=${days}`);
    },
    async getHealth(): Promise<{ compositeScore?: { overall?: number; grade?: string } }> {
      return request('/decision-health');
    },

    async bulkStartImport(
      connectors: string[],
      config?: Record<string, unknown>,
    ): Promise<{ scan_run_id: string; jobs: Array<{ id: string; connector_key: string }> }> {
      return request('/import/jobs/bulk-start', {
        method: 'POST',
        body: JSON.stringify({ connectors, config: config ?? {} }),
      });
    },

    async startImportJob(connector: string, config: Record<string, unknown>): Promise<{ id: string }> {
      const job = await request<{ id: string }>('/import/jobs', {
        method: 'POST',
        body: JSON.stringify({ connector_key: connector, config }),
      });
      await request(`/import/jobs/${job.id}/start`, { method: 'POST', body: '{}' });
      return job;
    },

    async getScanRun(scanRunId: string): Promise<{ status: string; progress: { jobs_total: number; jobs_completed: number; total_suggestions: number } }> {
      return request(`/import/scan-runs/${scanRunId}`);
    },

    // Gateway GET /import/jobs only supports limit/offset — filter client-side
    async listImportJobs(filters?: { status?: string; connector?: string }): Promise<ImportJob[]> {
      const jobs = await request<ImportJob[]>('/import/jobs');
      if (!filters) return jobs;
      return jobs.filter(j =>
        (!filters.status || j.status === filters.status) &&
        (!filters.connector || j.connector_key === filters.connector),
      );
    },

    // GET /import/scan-runs returns { scan_runs: ScanRun[] }
    async listScanRuns(): Promise<ScanRun[]> {
      const data = await request<{ scan_runs: ScanRun[] }>('/import/scan-runs');
      return data.scan_runs;
    },

    // GET /import/suggestions returns { suggestions, counts } — uses job_id not import_job_id
    async listSuggestions(jobId?: string, status = 'pending'): Promise<Suggestion[]> {
      const params = new URLSearchParams({ status });
      if (jobId) params.set('job_id', jobId);
      const data = await request<{ suggestions: Suggestion[] }>(`/import/suggestions?${params}`);
      return data.suggestions;
    },

    async bulkApproveSuggestions(
      ids: string[],
    ): Promise<{ created_decisions: number; async?: false } | { async: true; job_id: string; stream_url?: string }> {
      if (ids.length <= 100) {
        return request<{ created_decisions: number }>('/import/suggestions/bulk', {
          method: 'POST',
          body: JSON.stringify({ action: 'approve', suggestion_ids: ids }),
        });
      }
      // >100 suggestions go through async job — no immediate created_decisions count
      const jobData = await request<{ job_id: string; stream_url?: string }>('/import/suggestions/bulk-async', {
        method: 'POST',
        body: JSON.stringify({ action: 'approve', suggestion_ids: ids }),
      });
      return { async: true, job_id: jobData.job_id, stream_url: jobData.stream_url };
    },

    async listSpaces(): Promise<Space[]> {
      return request('/spaces');
    },

    async listDecisionLinks(
      filters?: { relation?: string; decision_id?: string },
    ): Promise<{ links: DecisionLink[]; total_count: number }> {
      // ALI-587: the legacy non-paginated branch hard-caps at 100 rows server-side and
      // returns a bare array - no envelope, so the caller could not even say "showing
      // first 100". The paginated branch keeps the same page size and carries total_count
      // over the whole matching set (computed cursor-free), so the listing can be honest.
      const qs = new URLSearchParams({ paginated: 'true', limit: '100' });
      if (filters?.relation) qs.set('relation', filters.relation);
      if (filters?.decision_id) qs.set('decision_id', filters.decision_id);
      const data = await request<{
        links?: DecisionLink[];
        pagination?: { total_count?: number | null };
      }>(`/decision-links?${qs.toString()}`);
      if (!Array.isArray(data?.links)) {
        // Same rule as getConflicts: a shape this client does not understand must fail
        // loudly, not render as an empty (or silently partial) listing.
        throw new Error(
          'unexpected /decision-links response shape: expected { links: [...] } - is the gateway older than cursor pagination?',
        );
      }
      const links = data.links;
      const total_count =
        typeof data.pagination?.total_count === 'number' ? data.pagination.total_count : links.length;
      return { links, total_count };
    },

    async getDriftSummary(): Promise<DriftItem[]> {
      return request('/drift-summary');
    },

    async ingestBatch(items: BatchIngestItem[], opts?: { deferEnrichment?: boolean }): Promise<BatchIngestResult> {
      // ALI-829: the fetchers carry the source's own date as `created_at`; the gateway's
      // BatchIngestSchema (align-stack ingestRoutes.ts, ALI-622) takes it as `decided_at`
      // and strips unknown keys, so sent under the wrong name it silently vanishes. One
      // rename at the wire, and a cloud row gets the same date a local row does.
      // Typed locally: connector-core 0.5.0's FetcherItem has no created_at (0.6.0's does),
      // and this must compile against both.
      const decisions = (items as Array<BatchIngestItem & { created_at?: string }>).map(({ created_at, ...rest }) => ({
        ...rest,
        ...(created_at ? { decided_at: created_at } : {}),
      }));
      // defer_enrichment (ALI-114): the gateway inserts snapshots with raw titles
      // and runs synthesis + relationship analysis in the background, returning
      // immediately. Older gateways ignore the unknown field (Zod strips it).
      return request<BatchIngestResult>('/ingest/batch', {
        method: 'POST',
        body: JSON.stringify({ decisions, ...(opts?.deferEnrichment ? { defer_enrichment: true } : {}) }),
      });
    },

    getStreamUrl(jobId: string): string {
      return `${gatewayUrl}/import/jobs/${jobId}/stream`;
    },
  };
}

export function createGatewayClient(env: EnvironmentConfig): ReturnType<typeof buildHttpGatewayClient> {
  if (env.mode === 'local-embedded') {
    const local = createLocalGatewayClient(env.localDbPath ?? ':memory:');
    // Local mode implements the MCP-tool subset (capture, search, alignment, drift,
    // impact, conflicts). Any other method is cloud-only - surface a clear message
    // instead of an opaque "x is not a function" TypeError if a command reaches it.
    return new Proxy(local, {
      get(target, prop, receiver) {
        if (prop in target || typeof prop !== 'string' || prop === 'then') {
          return Reflect.get(target, prop, receiver);
        }
        return () => {
          throw new Error(
            `'${prop}' is not available in local mode. Local mode supports the MCP tools ` +
            `(capture, search, alignment, drift, impact, conflicts). ` +
            `Use a cloud environment (e.g. --env preview or --env prod) for this command.`,
          );
        };
      },
    }) as unknown as ReturnType<typeof buildHttpGatewayClient>;
  }
  return buildHttpGatewayClient(env);
}
