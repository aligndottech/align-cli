/**
 * L9: `align share` as a function of injected dependencies, returning an exit code. The commander
 * wrapper (commands/share.ts) wires the real config, gateway client and prompts; tests wire fakes.
 *
 * Who may complete a share depends on what the gateway says (GET /share-requests/config, ALI-1540):
 *
 * - `required`, or `available` without `--typed`: the person approves in a BROWSER session. This process stages
 *   an encrypted request, prints a link and a code, waits, and sends only what the gateway says was approved.
 *   It never prompts on a terminal and never calls shareBatch. It may run inside an agent (ALIGN_WRAPPED): an
 *   agent can ask, and its own CLI token cannot approve, because the approve route refuses it. A browser session can (SECURITY.md lists how an agent may get one), so this is not a lock.
 * - `off`, a gateway with no such route (404), or `available` with `--typed`: today's flow. EVERY path (a plain
 *   `align share` and `align share --confirm <code>`) shows the preview on the CONTROLLING terminal and needs a
 *   typed yes there (default No). There is no `--yes`: a flag is exactly what an agent would pass. A caller with
 *   no controlling terminal, or inside an agent align launched, is refused. The known gap (an agent that
 *   allocates its own pseudo-terminal) is stated in SECURITY.md. `required` never reaches this branch.
 */
import { visible } from './visible.js';
import { type EnvironmentConfig } from '../config.js';
import { teamCtaLine } from '../team-cta.js';
import { runBrowserShare } from './browser-flow.js';
import { type DeliveryPlan, type PresentDeps, presentLink } from './delivery.js';
import { approveUrl } from './approval.js';
import { combinedHash, consumeCode, loadRequest, lookupCode, sweepPending } from './pending.js';
import { prepare, type Prepared, ratifiedRows, renderResults, renderTeamText, retract, secretRefusal, send, type ShareClient, ShareError } from './run.js';
import type { Judge } from '../curation/judgements-db.js';

export interface ShareOptions {
  ids: string[];
  allRatified?: boolean;
  /** An already-parsed lower bound (ISO), for --since. */
  sinceIso?: string;
  confirm?: string;
  retract?: string;
  /** Use the typed-yes flow although the gateway offers browser approval (refused when it requires it). */
  typed?: boolean;
  /** --open <request id>: re-open or re-print the link of a request an agent staged on this machine. */
  openRequest?: string;
  envName: string;
}

/** Everything the browser flow needs from the outside world, so tests drive it with a fake clock and no browser. */
export interface ApprovalDeps {
  /** The web app's base URL (the link's origin), from the environment. */
  appUrl: string;
  /** This machine's label, shown on the page as client-claimed. */
  label: string;
  openUrl?: (url: string) => Promise<boolean>;
  /** Open and/or QR for the link: see decideDelivery. */
  plan?: DeliveryPlan;
  qr?: PresentDeps['qr'];
  columns?: number;
  copy?: (url: string) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  /**
   * Runs the waiting part with a signal that aborts on Ctrl-C (the request is then cancelled and nothing is sent),
   * and takes the handler away afterwards. Absent, nothing can interrupt the wait but the expiry.
   */
  guard?: <T>(run: (signal: AbortSignal | undefined) => Promise<T>) => Promise<T>;
}

export interface ShareDeps {
  cloudEnv: EnvironmentConfig;
  /** This install's salt for the opaque client_key. */
  salt: string;
  /** The environment's default gateway URL: anything else is shown in the preview. */
  defaultGatewayUrl: string;
  localDbPath: string | null;
  client: () => ShareClient;
  judge: () => Promise<Judge>;
  /** The person's own git identity: `--all-ratified` shares only what they ratified. */
  owner: () => Promise<string>;
  /** True inside an agent that `align` launched (ALIGN_WRAPPED): the TYPED flow is then refused, as a speed bump. Asking for browser approval is not. */
  wrapped: boolean;
  approval: ApprovalDeps;
  /** Show `shown` and ask on the controlling terminal; null when there is no interactive terminal. */
  ttyConfirm: (shown: string, question: string) => Promise<boolean | null>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const WRAPPED = 'align share needs you to type your answer at a terminal, and this run is inside an agent that align launched, so it cannot ask you. Open a normal terminal of your own and run it there. Nothing was sent.';
const NO_TERMINAL = 'Confirm this in your own terminal. There is no interactive terminal here (an agent shell, a pipe and a hook have none). Nothing was sent.';

export async function runShare(opts: ShareOptions, deps: ShareDeps): Promise<number> {
  // Every line this prints can carry text a stranger wrote (a remote id, a tenant name, a server error, a
  // pending file's env). visible() is idempotent, so lines that were already escaped pass through unchanged.
  const out = (l: string): void => deps.out(visible(l, { keepNewline: true }));
  const err = (l: string): void => deps.err(visible(l, { keepNewline: true }));
  if (deps.cloudEnv.mode === 'demo') {
    err('align share needs a team account, and this environment is in demo mode. Run: align login');
    return 1;
  }
  if (deps.cloudEnv.mode === 'local-embedded' || !deps.cloudEnv.authToken) {
    err(`align share sends decisions from your local graph to your team's.\n  ${teamCtaLine()}\n  Already have a team? Run: align login`);
    return 1;
  }
  if (opts.openRequest !== undefined) return await reopenRequest(opts, deps, out, err);
  if (!deps.localDbPath) {
    err('There is no local graph on this machine to share from. `align setup --local` creates one.');
    return 1;
  }
  const dbPath = deps.localDbPath;
  sweepPending(); // codes are 10 minutes; a file a day old is leftover
  const ctx = async () => ({ dbPath, envName: opts.envName, client: deps.client(), judge: await deps.judge(), salt: deps.salt, gatewayUrl: deps.cloudEnv.gatewayUrl, defaultGatewayUrl: deps.defaultGatewayUrl });

  try {
    if (opts.retract !== undefined) {
      if (deps.wrapped) { err(WRAPPED); return 1; }
      const r = await retract(await ctx(), opts.retract);
      (r.ok ? out : err)(r.message);
      return r.ok ? 0 : 1;
    }

    // Who approves is the gateway's call. A 404 is an older gateway (the typed flow); any other failure stops here
    // and does NOT fall back, so a broken answer can never loosen the rule.
    const cfg = await deps.client().shareRequestsConfig();
    const mode = cfg?.mode ?? 'off';
    if (mode === 'required' && (opts.typed || opts.confirm !== undefined)) {
      err('This workspace requires approval in your browser, so --typed and --confirm are not accepted. Run: align share <id>. Nothing was sent.');
      return 1;
    }
    const browser = mode === 'required' || (mode === 'available' && !opts.typed);
    if (browser && opts.confirm !== undefined) {
      err('Shares are approved in your browser on this gateway, so a confirmation code does not apply. Run: align share <id>. (Or add --typed to answer at this terminal.) Nothing was sent.');
      return 1;
    }
    if (!browser && deps.wrapped) { err(WRAPPED); return 1; }
    // No silent downgrade: when the typed flow runs because the gateway has no browser approval, say so.
    if (!browser && !opts.typed) out(cfg === null ? 'This gateway does not offer browser approval (it has no such route), so this uses the typed answer at your terminal.' : 'This gateway has browser approval turned off, so this uses the typed answer at your terminal.');

    let ids = opts.ids;
    let pendingCode: string | undefined;
    if (opts.confirm !== undefined) {
      const found = lookupCode(opts.confirm);
      if (!found.ok) {
        err(found.reason === 'expired' ? 'That confirmation code has expired. Ask your agent to start the share again.' : 'That confirmation code is not valid (unknown, malformed or already used). Nothing was sent.');
        return 1;
      }
      if (found.pending.envName !== opts.envName) {
        err(`That code was issued for ${found.pending.envName}, not ${opts.envName}. Nothing was sent.`);
        return 1;
      }
      ids = found.pending.localIds;
      pendingCode = opts.confirm;
    } else if (ids.length === 0) {
      if (!opts.allRatified && opts.sinceIso === undefined) {
        err('Name what to share: align share <id> [<id>...], or --all-ratified, or --since <30d|2w|6m>.');
        return 2;
      }
      ids = ratifiedRows(dbPath, { owner: await deps.owner(), sinceIso: opts.sinceIso }).map((r) => r.id);
      if (ids.length === 0) { out('Nothing to share: you have no ratified decisions in that range.'); return 0; }
    }

    const c = await ctx();
    const prep: Prepared = await prepare(c, ids);
    if (prep.secrets.length) { err(secretRefusal(prep.secrets)); return 1; }
    for (const a of prep.already) out(`Already shared as ${visible(a.remoteId)}: ${visible(a.title)}`);
    if (prep.payloads.length === 0) return 0;

    if (browser) {
      out(prep.preview);
      const { guard, ...rest } = deps.approval;
      const maxWaitMs = ((cfg?.pendingTtlS ?? 900) + (cfg?.completeTtlS ?? 600)) * 1000;
      return await (guard ?? ((run) => run(undefined)))((signal) => runBrowserShare(c, prep, { ...rest, raw: deps.out, signal, maxWaitMs, client: c.client, out, err, ...(deps.wrapped ? { agent: 'wrapped' } : {}) }));
    }

    if (pendingCode !== undefined) {
      const found = lookupCode(pendingCode);
      if (!found.ok) { err('That confirmation code is no longer valid. Nothing was sent.'); return 1; }
      if (found.pending.hash !== combinedHash(prep.payloads, prep)) {
        err('What would be shared, or where it would go (the workspace or the gateway), has changed since your agent previewed it. Nothing was sent. Ask your agent to start again.');
        return 1;
      }
      const yes = await deps.ttyConfirm(prep.preview, `Share ${prep.payloads.length} decision${prep.payloads.length === 1 ? '' : 's'} with ${visible(prep.dest.workspace)}?`);
      if (yes === null) { err(NO_TERMINAL); return 1; }
      if (!yes) { out('Nothing was sent.'); return 0; }
      if (!consumeCode(pendingCode)) { err('That code was already used. Nothing was sent.'); return 1; }
    } else {
      const yes = await deps.ttyConfirm(prep.preview, `Share ${prep.payloads.length} decision${prep.payloads.length === 1 ? '' : 's'} with ${visible(prep.dest.workspace)}?`);
      if (yes === null) { err(NO_TERMINAL); return 1; }
      if (!yes) { out('Nothing was sent.'); return 0; }
    }

    const results = await send(c, prep, {
      confirmTeamText: async (i) => {
        const shown = `"${visible(i.title)}" is already on your team graph, as:\n${renderTeamText(i.team)}\nYour ratification would put your name on THAT text, not on yours.`;
        return (await deps.ttyConfirm(shown, 'Do you stand behind the team\'s text?')) === true;
      },
    });
    out(`\n${renderResults(results)}`);
    const failed = results.some((r) => r.outcome.kind === 'refused' || r.outcome.kind === 'unknown');
    return failed ? 1 : 0;
  } catch (e) {
    if (e instanceof ShareError) { err(e.message); return e.exitCode; }
    err((e as Error).message);
    return 1;
  }
}

/**
 * `align share --open <id>`. The key for an agent-staged request rests in one place, the 0600 pending file on the machine
 * that staged it, so this works there and nowhere else. Every refusal below prints no key. It only shows the link again: the
 * person approves in the browser, and the agent's own status call finishes the share.
 */
async function reopenRequest(opts: ShareOptions, deps: ShareDeps, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  sweepPending();
  const rec = loadRequest(opts.openRequest!);
  if (rec === null) { err('No pending request with that id on this machine. A request can only be re-opened on the machine that staged it, and only until it expires. Ask your agent to start the share again.'); return 1; }
  if (!(Date.parse(rec.expiresAt) > Date.now())) { err('That request has expired. Ask your agent to start the share again.'); return 1; }
  if (rec.envName !== opts.envName) { err(`That request was staged for ${rec.envName}, not ${opts.envName}. Run: align share --open ${rec.requestId} --env ${rec.envName}`); return 1; }
  if (rec.gatewayUrl !== deps.cloudEnv.gatewayUrl || (deps.cloudEnv.tenantId !== undefined && rec.tenantId !== deps.cloudEnv.tenantId)) {
    err('That request was staged for a different workspace or gateway than the one you are signed in to now, so it was not shown.');
    return 1;
  }
  let state: string;
  try { state = (await deps.client().getShareRequest(rec.requestId)).state; } catch (e) { err(`Could not ask the gateway about that request (${visible((e as Error).message)}), so the link was not shown. Try again in a moment.`); return 1; }
  if (state !== 'pending') { err(`That request is ${visible(state)}, so there is nothing to approve. Ask your agent to start the share again if you still want it.`); return 1; }
  const url = approveUrl(deps.approval.appUrl, rec.requestId, rec.keyB64Url);
  const minutes = Math.max(1, Math.round((Date.parse(rec.expiresAt) - Date.now()) / 60000));
  out(`Approve in your browser: ${url}`);
  out(`Code: ${rec.userCode}  (the page shows the same code. Check they match before you approve.)`);
  out(`It expires in ${minutes} minutes. Nothing is sent until you approve. When you have, tell your agent so it can finish the share.`);
  const a = deps.approval;
  await presentLink(url, {
    appUrl: a.appUrl, plan: a.plan ?? { open: a.openUrl !== undefined, qr: false, qrIfOpenFails: false, why: 'default' },
    ...(a.openUrl ? { openUrl: a.openUrl } : {}), ...(a.qr ? { qr: a.qr } : {}), ...(a.columns !== undefined ? { columns: a.columns } : {}),
    ...(a.copy ? { copy: a.copy } : {}), out, raw: deps.out,
  });
  return 0;
}
