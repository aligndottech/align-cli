/**
 * `align join <link>`: save a team's server as a named destination, additively.
 *
 * The link is a claim, not an instruction. Everything that decides where a credential goes is
 * checked against the gateway's own answer BEFORE a browser opens, and the person confirms the
 * host when it is not Align's. Nothing already saved is moved, archived or expired: the new token
 * is minted by the server for this machine only, verified with one request, and only then stored.
 * Join plan: thoughts/shared/plans/2026-10-10-org-invite-join-destination.md (attacks S1-S10).
 */
import type { CallbackResult } from './cli-oauth.js';
import { createGatewayClient } from './gateway-client.js';
import type { createConfigStore } from './config.js';
import { validateDestinationName } from './destination-name.js';
import { assertTransport, describeHost, needsTypeBack, parseJoinLink, slugOrgName, TransportError } from './destination-trust.js';
import { visible } from './share/visible.js';

type ConfigStore = ReturnType<typeof createConfigStore>;

export interface JoinDeps {
  config: Pick<ConfigStore, 'hasTeamDestination' | 'saveTeamDestination' | 'getShareDestination' | 'setShareDestination'>;
  isTTY: boolean;
  out(line: string): void;
  openUrl(url: string): Promise<boolean>;
  /** One line typed by the person, or null if they cancelled. Only called on a terminal. */
  promptLine(question: string): Promise<string | null>;
  confirm(question: string): Promise<boolean>;
  waitForCallback(opts: {
    ports: number[];
    timeoutMs: number;
    onBound?: (port: number, nonce: string) => void | Promise<void>;
  }): Promise<CallbackResult>;
  now(): Date;
  callbackPorts: number[];
  timeoutMs: number;
}

export interface JoinInput {
  link: string;
  gateway?: string;
  name?: string;
  replace?: boolean;
  confirmHost?: string;
  makeShareDestination?: boolean;
}

export type JoinResult = { ok: true; name: string; expiresAt?: string } | { ok: false; reason: string };

const PEEK_MAX_BYTES = 16 * 1024;
const PEEK_TIMEOUT_MS = 10_000;
const ORG_NAME_MAX = 100;
const TOKEN_SHAPE = /^[\x21-\x7e]{8,512}$/;

interface Peek { orgName: string; appUrl: string }

export async function runJoin(deps: JoinDeps, input: JoinInput): Promise<JoinResult> {
  const refuse = (reason: string): JoinResult => {
    deps.out(`\nNothing was saved and no browser was opened.\n  ${reason}\n`);
    return { ok: false, reason };
  };

  let link;
  try {
    link = parseJoinLink(input.link, input.gateway === undefined ? {} : { gateway: input.gateway });
  } catch (e) {
    return refuse(e instanceof TransportError ? e.message : 'That link could not be read.');
  }
  const gwHost = new URL(link.gatewayUrl).host;

  if (input.name !== undefined) {
    const bad = validateDestinationName(input.name);
    if (bad) return refuse(`The name "${visible(input.name.slice(0, 40))}" cannot be used: ${bad}.`);
  }

  const peeked = await peek(link.gatewayUrl, link.token);
  if (typeof peeked === 'string') return refuse(peeked);

  // The gateway's own account of itself has to match the link, or the link is lying about one of them.
  let peekApp: string;
  try {
    peekApp = assertTransport(peeked.appUrl);
  } catch (e) {
    return refuse(`The server's web app address is not acceptable: ${(e as Error).message}`);
  }
  const peekAppHost = new URL(peekApp).host;
  if (peekAppHost !== link.appHost) {
    return refuse(`The link points at the web app ${link.appHost}, but ${gwHost} says its web app is ${peekAppHost}. Both are shown so you can see which to trust; neither was used.`);
  }
  if (peeked.gatewayClaim !== undefined && peeked.gatewayClaim !== link.gatewayUrl) {
    return refuse(`The link names the server ${gwHost}, but that server says it is ${new URL(peeked.gatewayClaim).host}. Neither was used.`);
  }

  const claimed = visible(peeked.orgName).slice(0, ORG_NAME_MAX);
  const gwShown = describeHost(gwHost);
  const appShown = describeHost(peekAppHost);
  deps.out('\nJoining a team graph');
  deps.out(`  Gateway:  ${gwShown.text}`);
  deps.out(`  Web app:  ${appShown.text}`);
  deps.out(`  Org:      "${claimed || '(no name given)'}" (as claimed by ${gwHost})`);
  for (const w of new Set([gwShown.warning, appShown.warning])) if (w) deps.out(`  Warning:  ${w}`);

  if (needsTypeBack(gwHost, peekAppHost)) {
    const typed = input.confirmHost !== undefined ? input.confirmHost : await typeBack(deps, gwHost);
    if (typed === null) return refuse(`This server is not under align.tech, so the host has to be confirmed. Re-run with --confirm-host ${gwHost} to confirm it without a prompt.`);
    if (typed.trim().toLowerCase() !== gwHost) return refuse(`"${visible(typed.slice(0, 80))}" is not ${gwHost}.`);
  }

  const derived = input.name ?? slugOrgName(claimed);
  if (!derived) return refuse('Could not make a name from the org name. Choose one with --name <name>.');
  const name = derived;
  if (deps.config.hasTeamDestination(name) && !input.replace) {
    return refuse(`You already have a destination called "${name}". Use --replace to replace it, or --name <other> to keep both.`);
  }

  const received = await receive(deps, link.token, peekApp);
  if (typeof received === 'string') return refuse(received);

  let me;
  try {
    me = await createGatewayClient({ gatewayUrl: link.gatewayUrl, authToken: received.token, tenantId: null, mode: 'auth' }).whoami();
  } catch (e) {
    return refuse(`${gwHost} did not accept the new token (${visible(String((e as Error).message).slice(0, 120))}).`);
  }

  const tenantName = visible(String(me.tenant?.name ?? '')).slice(0, ORG_NAME_MAX);
  if (tenantName.trim() !== claimed.trim()) {
    deps.out(`\n  Heads up: the invite said "${claimed}" but you are signed in to "${tenantName}". Both come from ${gwHost}, so neither proves who runs it.`);
  }

  deps.config.saveTeamDestination(name, {
    gatewayUrl: link.gatewayUrl,
    appUrl: peekApp,
    authToken: received.token,
    tenantId: me.tenant?.id ?? null,
    orgNameClaimed: claimed,
  }, deps.now());

  await chooseShareDestination(deps, name, input.makeShareDestination === true);

  deps.out(`\nJoined as "${name}" (${me.user.email}, ${tenantName}).`);
  if (received.expiresAt) deps.out(`  This access expires on ${received.expiresAt.slice(0, 10)}. Renew it with: align login --env ${name}`);
  deps.out(`  Use it with: align <command> --env ${name}`);
  return received.expiresAt ? { ok: true, name, expiresAt: received.expiresAt } : { ok: true, name };
}

async function typeBack(deps: JoinDeps, gwHost: string): Promise<string | null> {
  if (!deps.isTTY) return null;
  deps.out(`\n  ${gwHost} is not an Align address. If you did not expect this link, stop here.`);
  return deps.promptLine('Type the gateway host to confirm: ');
}

async function peek(gatewayUrl: string, token: string): Promise<(Peek & { gatewayClaim: string | undefined }) | string> {
  const host = new URL(gatewayUrl).host;
  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}/auth/invite-peek?token=${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(PEEK_TIMEOUT_MS),
    });
  } catch {
    return `Could not reach ${host}.`;
  }
  if (res.status === 404) return 'That invite was not found. It may have expired, been used, or been revoked. Ask for a new link.';
  if (!res.ok) return `${host} answered ${res.status} when asked about the invite.`;
  let body: unknown;
  try {
    const text = await res.text();
    if (text.length > PEEK_MAX_BYTES) return `${host} sent an unexpectedly large answer.`;
    body = JSON.parse(text);
  } catch {
    return `${host} did not answer with an invite description.`;
  }
  const b = body as { org_name?: unknown; app_url?: unknown; gateway_url?: unknown } | null;
  if (typeof b !== 'object' || b === null) return `${host} did not answer with an invite description.`;
  if (typeof b.app_url !== 'string' || b.app_url === '') {
    return `${host} did not say where its web app is. It may be too old to join from the CLI; ask its admin to update it.`;
  }
  let gatewayClaim: string | undefined;
  if (b.gateway_url !== undefined) {
    if (typeof b.gateway_url !== 'string') return `${host} sent a malformed server address.`;
    try {
      gatewayClaim = assertTransport(b.gateway_url);
    } catch (e) {
      return `The server address ${host} reports is not acceptable: ${(e as Error).message}`;
    }
  }
  return { orgName: typeof b.org_name === 'string' ? b.org_name : '', appUrl: b.app_url, gatewayClaim };
}

async function receive(deps: JoinDeps, token: string, appUrl: string): Promise<{ token: string; expiresAt?: string } | string> {
  let result: CallbackResult;
  try {
    result = await deps.waitForCallback({
      ports: deps.callbackPorts,
      timeoutMs: deps.timeoutMs,
      onBound: async (port, nonce) => {
        const url = `${appUrl}/join?token=${token}&cli_port=${port}&cli_nonce=${nonce}`;
        deps.out(`\nOpening your browser at:\n  ${url}`);
        if (!(await deps.openUrl(url))) deps.out('  Could not open a browser here. Open that link yourself.');
        deps.out('Waiting for you to approve in the browser (5 min)...');
      },
    });
  } catch (e) {
    return `No approval arrived: ${(e as Error).message}.`;
  }
  const t = result.data['token'];
  if (typeof t !== 'string' || !TOKEN_SHAPE.test(t)) return 'The browser sent back no usable token. Run the command again.';
  const raw = result.data['expires_at'];
  let expiresAt: string | undefined;
  if (typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) expiresAt = new Date(raw).toISOString();
  return expiresAt ? { token: t, expiresAt } : { token: t };
}

async function chooseShareDestination(deps: JoinDeps, name: string, force: boolean): Promise<void> {
  const current = deps.config.getShareDestination();
  if (current === null) {
    deps.config.setShareDestination(name);
    return;
  }
  if (current === name) return;
  if (force || (deps.isTTY && await deps.confirm(`Send "align share" to "${name}" from now on? It currently goes to "${current}".`))) {
    deps.config.setShareDestination(name);
    return;
  }
  deps.out(`  "align share" still goes to "${current}". Send one share to "${name}" with --to ${name}, or re-run this join with --make-share-destination.`);
}
