import type { EnvironmentConfig } from './config.js';

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
  results: Array<{ id: string; title: string; summary: string; status: string; similarity?: number }>;
  count: number;
  strategy: 'semantic' | 'keyword';
}

export interface AlignmentResult {
  status: 'aligned' | 'conflicting' | 'no-context';
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

export interface BatchIngestItem {
  source_url: string;
  platform: string;
  raw_text: string;
  title?: string;
}

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

export function createGatewayClient(env: EnvironmentConfig) {
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
        headers: { ...buildHeaders(), ...(options.headers as Record<string, string> ?? {}) },
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

    async checkAlignment(diff: string, context?: string): Promise<AlignmentResult> {
      return request<AlignmentResult>('/alignment/check', {
        method: 'POST',
        body: JSON.stringify({
          action_type: 'pull_request',
          content: diff.slice(0, 8000),
          context: context?.slice(0, 1000),
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

    async getConflicts(): Promise<unknown> {
      return request('/decision-links?relation=conflicts_with,contradicts&paginated=true&limit=50');
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

    async listDecisionLinks(filters?: { relation?: string; decision_id?: string }): Promise<DecisionLink[]> {
      const entries = Object.entries(filters ?? {}).filter(([, v]) => Boolean(v)) as [string, string][];
      const qs = new URLSearchParams(entries);
      return request(`/decision-links${qs.size ? `?${  qs}` : ''}`);
    },

    async getDriftSummary(): Promise<DriftItem[]> {
      return request('/drift-summary');
    },

    async ingestBatch(items: BatchIngestItem[]): Promise<BatchIngestResult> {
      return request<BatchIngestResult>('/ingest/batch', {
        method: 'POST',
        body: JSON.stringify({ decisions: items }),
      });
    },

    getStreamUrl(jobId: string): string {
      return `${gatewayUrl}/import/jobs/${jobId}/stream`;
    },
  };
}
