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
    // Attribution an agent needs to CITE a decision rather than just repeat its
    // title: which repository it came from, how a human writes it (align-cli#76),
    // and the URL it was decided at. Optional because a decision from Slack or a
    // meeting has no repository, and omitting beats emitting an empty string.
    platform?: string; source_url?: string; repository?: string; cite?: string;
    // Present only in cloud mode, where a hosted UI can actually serve it.
    decision_url?: string;
  }>;
  count: number;
  strategy: 'semantic' | 'keyword';
}

/**
 * Why an alignment check could not reach a verdict (ALI-414 / ALI-348).
 *
 * The `brain_*` codes come from the cloud gateway (`/alignment/check`), the rest
 * from the local embedded client. Both are listed because this one type describes
 * both clients' responses, and an agent branching on `reason` sees either.
 */
export type UnknownReason =
  | 'brain_timeout'
  | 'brain_error'
  | 'brain_degraded'
  | 'no_llm_key'
  | 'classifier_error'
  | 'classifier_unparseable';

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

  async function request<T>(path: string, options: Parameters<typeof fetch>[1] = {}): Promise<T> {
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

    async searchDecisions(q: string, limit = 10): Promise<SearchResults> {
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
    async checkAlignment(
      diff: string,
      context?: string,
      opts: { depth?: 'related' | 'full'; title?: string } = {},
    ): Promise<AlignmentResult> {
      return request<AlignmentResult>('/alignment/check', {
        method: 'POST',
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
      // defer_enrichment (ALI-114): the gateway inserts snapshots with raw titles
      // and runs synthesis + relationship analysis in the background, returning
      // immediately. Older gateways ignore the unknown field (Zod strips it).
      return request<BatchIngestResult>('/ingest/batch', {
        method: 'POST',
        body: JSON.stringify({ decisions: items, ...(opts?.deferEnrichment ? { defer_enrichment: true } : {}) }),
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
