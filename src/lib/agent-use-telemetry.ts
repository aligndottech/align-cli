import type { EnvironmentConfig } from './config.js';
import pkg from '../../package.json' with { type: 'json' };
import { localTierAllows, noticeShownOn, postAnonymous, telemetryOptedOut } from './usage-telemetry.js';

/**
 * One anonymous, content-free event per edit-check hook run and per MCP tool call, so the funnel
 * can count the use that happens INSIDE a coding agent (Tom, 12 Nov 2026: this reverses the old
 * "hooks and agent runs never send" rule for this one event; every user opt-out still applies).
 *
 * The payload is built from fixed fields and four closed lists, never from the call: no file, repo,
 * org, decision text, prompt or code can reach it. The lists mirror the gateway's AGENT_USE_*
 * (align-stack telemetryAnonymousRoutes.ts) and telemetry-server-parity.test.ts pins them.
 */
/** The gateway's stage name for this event. Not in FUNNEL_STAGES: it has its own emitter. */
export const AGENT_USE_STAGE = 'agent_use';
export const AGENT_USE_VIA = ['hook', 'mcp'] as const;
export const AGENT_USE_TOOLS = [
  'check_advisory',
  'align_check_alignment', 'align_ask', 'align_search', 'align_capture', 'align_check_drift',
  'align_get_impact', 'align_get_conflicts', 'align_get_related_decisions', 'align_get_topic_timeline',
  'align_get_decision_rationale', 'align_get_decision_timeline', 'align_stale_code',
  'align_backfill', 'align_sync', 'align_scope', 'align_mark', 'align_share', 'align_share_status',
] as const;
export const AGENT_USE_VERDICTS = ['aligned', 'conflicting', 'related', 'unknown', 'no_context', 'not_applicable'] as const;

export type AgentUse = {
  via: (typeof AGENT_USE_VIA)[number];
  tool: (typeof AGENT_USE_TOOLS)[number];
  verdict: (typeof AGENT_USE_VERDICTS)[number];
};

/**
 * At most one event per via+tool in this window, kept in the config store so it holds across the
 * separate processes a hook is. Chosen over a per-process cap because a hook IS a new process per
 * edit, and over a daily counter because a counter needs a second send to report it. Ten minutes
 * keeps the worst case (every tool, both paths) near 80 events an hour per install, under the
 * gateway's 120 an hour per-install limit, and the funnel reads days, not volume.
 */
export const AGENT_USE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Resolves true when a send was made (not necessarily delivered). Never throws and never waits
 * longer than `capMs`: a hook must not be slowed by telemetry. Local mode only - a cloud install
 * already has the server-side `mcp.tool_invoked` / `alignment.check_executed` events.
 *
 * Deliberately NOT gated on hook context or ALIGN_WRAPPED: those are exactly the runs this event
 * exists to count. Everything the user chose still stops it: DO_NOT_TRACK, ALIGN_TELEMETRY=0, CI,
 * a stored `off` or `declined`. Until the notice has printed once on this install (or the user ran
 * `align telemetry on`) nothing goes out.
 */
export async function recordAgentUse(
  env: EnvironmentConfig,
  use: AgentUse,
  opts: { capMs?: number; now?: number } = {},
): Promise<boolean> {
  try {
    if (env.mode !== 'local-embedded') return false;
    if (telemetryOptedOut()) return false;
    if (!(AGENT_USE_VIA as readonly string[]).includes(use.via)) return false;
    if (!(AGENT_USE_TOOLS as readonly string[]).includes(use.tool)) return false;
    if (!(AGENT_USE_VERDICTS as readonly string[]).includes(use.verdict)) return false;

    const { createConfigStore } = await import('./config.js');
    const config = createConfigStore();
    if (!localTierAllows(config.getTelemetryConsent(), 'command', noticeShownOn(config))) return false;

    const key = `${use.via}:${use.tool}`;
    const now = opts.now ?? Date.now();
    const last = config.getAgentUseSentAt(key);
    if (last !== undefined && now - last >= 0 && now - last < AGENT_USE_WINDOW_MS) return false;
    // Marked before the send, like agent_active: a lost ping undercounts one window, where marking
    // after would re-send on every edit from a machine that cannot reach the gateway.
    config.setAgentUseSentAt(key, now);

    await postAnonymous({
      installId: config.getInstallId(),
      command: use.via === 'hook' ? 'check' : 'mcp',
      cliVersion: pkg.version,
      stage: AGENT_USE_STAGE,
      via: use.via,
      tool: use.tool,
      verdict: use.verdict,
      os: process.platform,
    }, opts.capMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The class of an MCP tool's answer, from its status or result count only. `not_applicable` is a
 * tool with no verdict to report (capture, impact, timelines). Never reads decision text.
 */
export function mcpVerdictClass(tool: string, result: unknown): AgentUse['verdict'] {
  const r = (result ?? {}) as { status?: unknown; results?: unknown };
  if (tool === 'align_check_alignment') {
    if (r.status === 'aligned') return 'aligned';
    if (r.status === 'conflicting') return 'conflicting';
    if (r.status === 'retrieved') return 'related';
    if (r.status === 'no-context') return 'no_context';
    return 'unknown';
  }
  if (tool === 'align_ask' || tool === 'align_search') {
    return Array.isArray(r.results) && r.results.length > 0 ? 'related' : 'no_context';
  }
  return 'not_applicable';
}
