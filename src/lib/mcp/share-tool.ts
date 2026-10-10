/**
 * L9: the MCP tool `align_share` - step ONE of a two-step share, and never step two.
 *
 * What it does: builds the exact preview of what would leave this machine, runs the secret scan,
 * stores the payload under a short-lived single-use code and returns the preview plus the command
 * a PERSON runs: `align share --confirm <code>`. What it cannot do: send. Nothing in this module
 * calls `shareBatch`; the only network call is `whoami` (a read) to name the destination. There is
 * no elicitation path here either: an answer shown by the client is only as trustworthy as the
 * client, so completion is reserved for the CLI at a controlling terminal (Decision 17, stage 1).
 *
 * The input schema is closed and has one property, the decision id: a token or key cannot be
 * passed, and the destination is the user's own logged-in environment, never an argument.
 */
import type { EnvironmentConfig } from '../config.js';
import { createConfigStore, defaultGatewayUrlFor } from '../config.js';
import { defaultJudge } from '../curation/judge.js';
import type { Judge } from '../curation/judgements-db.js';
import { createGatewayClient } from '../gateway-client.js';
import { resolveEnv } from '../resolve-env.js';
import { issueCode } from '../share/pending.js';
import { visible } from '../share/visible.js';
import { prepare, secretRefusal, type ShareClient, ShareError } from '../share/run.js';
import { teamCtaLine } from '../team-cta.js';
import { agentIdFrom, jsonSchemaOf, strictInput, type StrictSpec } from './tool-rules.js';

export const SHARE_TOOL = 'align_share';

const SPEC: StrictSpec = {
  tool: SHARE_TOOL,
  required: ['id'],
  properties: { id: { type: 'string', description: 'The local decision to share (its id; it must be ratified)', maxLength: 200 } },
};

export const SHARE_TOOL_SCHEMA = {
  name: SHARE_TOOL,
  annotations: { readOnlyHint: true, destructiveHint: false },
  description:
    'Prepare sharing one RATIFIED local decision, and the user\'s judgements on it, with their team. This only PREVIEWS: it sends nothing and cannot. ' +
    'It returns exactly what would leave the machine, and a one-time code. Show the user the preview, then give them the command `align share --confirm <code>` to run in their own terminal; ' +
    'they read the preview again there and answer yes or no. The code expires in 10 minutes and works once. ' +
    'Offer it when the user asks to share a decision with their team. If the user has no team login it returns `align login` and a way to bring Align to their team. ' +
    'It never takes a token or key.',
  inputSchema: jsonSchemaOf(SPEC),
} as const;

export interface ShareToolContext {
  clientInfo?: { name?: unknown };
  judge?: () => Promise<Judge>;
  /** Test seam: the destination and the (read-only) client. Production resolves the user's default cloud env. */
  share?: { cloudEnv: EnvironmentConfig; envName: string; client: ShareClient; salt?: string };
}

export interface ShareToolResult { text: string; code?: string; [k: string]: unknown }

export async function runShareTool(args: Record<string, unknown> | undefined, env: EnvironmentConfig, ctx: ShareToolContext = {}): Promise<ShareToolResult> {
  const input = strictInput(SPEC, args);
  if (env.mode !== 'local-embedded' || !env.localDbPath) {
    throw new Error(`${SHARE_TOOL} shares from the local graph on this machine, and this server reads a hosted Align graph. Use the local Align server (align mcp --env local).`);
  }
  let target = ctx.share;
  if (!target) {
    const config = createConfigStore();
    const envName = resolveEnv();
    const cloudEnv = config.getEnvironment(envName);
    target = { cloudEnv, envName, client: createGatewayClient(cloudEnv) as unknown as ShareClient, salt: config.getInstallId() };
  }
  const { cloudEnv, envName, client } = target;
  if (cloudEnv.mode === 'local-embedded' || (!cloudEnv.authToken && cloudEnv.mode !== 'demo')) {
    return { text: `Sharing needs a team login, and none is set up. Ask the user to run: align login\n${teamCtaLine()}`, shared: false };
  }
  try {
    const prep = await prepare({ dbPath: env.localDbPath, envName, client, judge: await (ctx.judge ?? defaultJudge)(), salt: target.salt ?? createConfigStore().getInstallId(), gatewayUrl: cloudEnv.gatewayUrl, defaultGatewayUrl: defaultGatewayUrlFor(envName) }, [input['id'] as string]);
    if (prep.secrets.length) return { text: secretRefusal(prep.secrets), shared: false };
    if (prep.payloads.length === 0) {
      return { text: prep.already.map((a) => `Already shared as ${visible(a.remoteId)}: ${visible(a.title)}`).join('\n'), shared: false };
    }
    const agentId = agentIdFrom(ctx.clientInfo);
    const code = issueCode(prep.payloads, { agentId, envName, preview: prep.preview, to: { tenantId: prep.tenantId, gatewayUrl: prep.gatewayUrl } });
    if (code === null) return { text: 'Could not store a confirmation code safely on this machine, so nothing was prepared.', shared: false };
    return {
      shared: false,
      code,
      text: `${prep.preview}\n\nNOTHING HAS BEEN SENT. Show the user the text above. To share it they run, in their own terminal:\n  align share --confirm ${code}\nThe code works once and expires in 10 minutes.`,
    };
  } catch (e) {
    if (e instanceof ShareError) throw new Error(e.message);
    throw e;
  }
}
