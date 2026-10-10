/**
 * ALI-1540: the MCP tool `align_share_status` - the second half of an approved share.
 *
 * `align_share` stages a request and hands the person a link. This tool reads where that request stands and, ONLY
 * when the gateway says the person approved it, sends the exact bytes that were approved (the completion call).
 * Everything else it does is read-only: waiting, declined, expired and cancelled change nothing on the team graph.
 *
 * It completes at most once: the pending file is taken by an atomic rename, so a second call finds nothing to
 * complete. Before it completes it rebuilds the share from the local graph and refuses (and cancels the request)
 * if what would be shared changed since the person was shown it, the same rule `--confirm` applies to a code.
 *
 * Input: one string, the request id. No token or key can be passed.
 */
import { defaultJudge } from '../curation/judge.js';
import { defaultGatewayUrlFor } from '../config.js';
import type { EnvironmentConfig } from '../config.js';
import { completeRequest, CompletionError } from '../share/approval.js';
import { claimRequest, combinedHash, deleteRequest, loadRequest, sweepPending } from '../share/pending.js';
import { REQUEST_ID_RE } from '../share/requests-client.js';
import { prepare, renderResults, send, ShareError } from '../share/run.js';
import { visible } from '../share/visible.js';
import { hasLogin, NO_LOGIN, resolveShareTarget, SHARE_STATUS_TOOL, type ShareToolContext, type ShareToolResult } from './share-tool.js';
import { jsonSchemaOf, strictInput, type StrictSpec } from './tool-rules.js';

const SPEC: StrictSpec = {
  tool: SHARE_STATUS_TOOL,
  required: ['request_id'],
  properties: { request_id: { type: 'string', description: 'The request_id align_share returned', maxLength: 64 } },
};

export const SHARE_STATUS_TOOL_SCHEMA = {
  name: SHARE_STATUS_TOOL,
  // It writes: once the user has approved, it completes the share, which creates or updates decisions on the team graph. It deletes nothing there.
  annotations: { readOnlyHint: false, destructiveHint: false },
  description:
    'Check a share the user was asked to approve in their browser (from align_share), and finish it once they have. ' +
    'It reports waiting, declined, expired or cancelled, and changes nothing in those cases. When the user HAS approved, the first call sends exactly what they approved and returns the result; a second call sends nothing. ' +
    'It does not approve anything: approving is the user\'s act, in their browser, and you must not attempt it. Call it after the user says they approved, or to see whether they have. ' +
    'It never takes a token or key.',
  inputSchema: jsonSchemaOf(SPEC),
} as const;

const minutes = (iso: string, now = Date.now()): number => Math.max(0, Math.round((Date.parse(iso) - now) / 60000));

export async function runShareStatusTool(args: Record<string, unknown> | undefined, env: EnvironmentConfig, ctx: ShareToolContext = {}): Promise<ShareToolResult> {
  const input = strictInput(SPEC, args);
  const id = input['request_id'] as string;
  const t = resolveShareTarget(env, ctx, SHARE_STATUS_TOOL);
  sweepPending();
  if (!hasLogin(t.cloudEnv)) return { text: NO_LOGIN(), shared: false };
  if (!REQUEST_ID_RE.test(id)) return { text: 'That is not a share request id. Use the request_id align_share returned.', shared: false };
  const rec = loadRequest(id);
  if (rec === null) return { text: 'No share is waiting under that id on this machine. It may already be finished, cancelled or expired. Call align_share again to start a new one.', shared: false, state: 'unknown' };
  try {
    const { state } = await t.client.getShareRequest(id);
    const ended = (text: string, st: string): ShareToolResult => { deleteRequest(id); return { text, shared: false, state: st }; };
    switch (state) {
      case 'pending': return { text: `Still waiting for the user to approve it in their browser. Code ${visible(rec.userCode)}; it expires in about ${minutes(rec.expiresAt)} minutes. Nothing has been sent. Ask the user to open the link align_share gave them.`, shared: false, state, request_id: id };
      case 'declined': return ended('The user declined it in their browser. Nothing was sent.', state);
      case 'expired': return ended('The request expired before it was approved. Nothing was sent. Call align_share again to start a new one.', state);
      case 'cancelled': return ended('The request was cancelled. Nothing was sent.', state);
      case 'failed': return ended('The gateway marked the request as failed. Nothing was sent. Call align_share again to start a new one.', state);
      case 'completed': return ended('That share was already completed.', state);
      case 'completing': return { text: 'The gateway is finishing that share now. Check again in a moment.', shared: false, state, request_id: id };
      case 'approved': break;
    }
    // Approved: take the request (atomically), so two calls cannot both complete it.
    const claim = claimRequest(id);
    if (claim === null) return { text: 'That share is already being completed or has been. Nothing more was sent by this call.', shared: false, state: 'completing', request_id: id };
    try {
      const shareCtx = { dbPath: env.localDbPath!, envName: t.envName, client: t.client, judge: await (ctx.judge ?? defaultJudge)(), salt: t.salt, gatewayUrl: t.cloudEnv.gatewayUrl, defaultGatewayUrl: defaultGatewayUrlFor(t.envName) };
      const prep = await prepare(shareCtx, claim.request.localIds);
      if (prep.secrets.length || prep.payloads.length === 0 || combinedHash(prep.payloads, prep) !== claim.request.hash || claim.request.envName !== t.envName) {
        // What the user approved is no longer what this machine would send: do not send it.
        await t.client.cancelShareRequest(id).catch(() => undefined);
        claim.finish();
        return { text: 'What would be shared, or where it would go, changed since the user was shown it, so nothing was sent and the request was cancelled. Call align_share to start again.', shared: false, state: 'changed' };
      }
      const response = await completeRequest(t.client, id, claim.request.bytesB64);
      const rows = await send(shareCtx, prep, { post: async (_b, phase) => (phase === 'share' ? response : null) });
      claim.finish();
      const waiting = rows.some((r) => r.judgementFailures.some((f) => f.error === 'needs_confirmation'));
      const more = waiting ? `\n\nSome of the user's judgements wait for the team's existing text to be confirmed. Tell the user to run align share ${visible(claim.request.localIds[0] ?? '<id>')} in their own terminal: they approve that second step in the browser too.` : '';
      return { text: `Approved by the user, and sent:\n${renderResults(rows)}${more}`, shared: !rows.every((r) => r.outcome.kind === 'refused' || r.outcome.kind === 'unknown'), state: 'completed' };
    } catch (e) {
      // No verdict from the gateway means the same bytes may be sent again; any other failure is final for this request.
      if (e instanceof CompletionError && e.retryable) claim.release(); else claim.finish();
      throw e;
    }
  } catch (e) {
    if (e instanceof ShareError) throw new Error(e.message);
    throw new Error(visible((e as Error).message));
  }
}
