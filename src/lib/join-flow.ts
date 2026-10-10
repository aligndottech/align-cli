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
  config: Pick<ConfigStore, 'hasTeamDestination' | 'saveTeamDestination' | 'getShareDestination' | 'setShareDestination' | 'getEnvironment'>;
  /** stdin AND stdout are terminals. Joining is a person's act: it never runs without one. */
  isTTY: boolean;
  /** Inside an agent align launched (ALIGN_WRAPPED). Such a process is not the person, so it cannot join. */
  wrapped: boolean;
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
}

export type JoinResult = { ok: true; name: string; expiresAt?: string } | { ok: false; reason: string };

const PEEK_MAX_BYTES = 16 * 1024;
const ORG_NOTE = 'chosen by that organisation, not verified by Align';
const PEEK_TIMEOUT_MS = 10_000;
const ORG_NAME_MAX = 100;
const TOKEN_SHAPE = /^[\x21-\x7e]{8,512}$/;

interface Peek { orgName: string; appUrl: string }

export async function runJoin(deps: JoinDeps, input: JoinInput): Promise<JoinResult> {
  const refuse = (reason: string): JoinResult => {
    deps.out(`\nNothing was saved and no browser was opened.\n  ${reason}\n`);
    return { ok: false, reason };
  };
  // After the browser step: a browser WAS opened, and if the server already issued a token it is still live there. Say both.
  const refuseLate = (reason: string, issued?: { host: string; expiresAt?: string }): JoinResult => {
    const live = issued
      ? `\n  ${issued.host} issued a token to this computer and it was not saved. It stays valid until ${issued.expiresAt ? issued.expiresAt.slice(0, 10) : 'it expires'} (or until the organisation's admin revokes the invite); nothing here can revoke it.`
      : '';
    deps.out(`\nNothing was saved. A browser was opened.\n  ${reason}${live}\n`);
    return { ok: false, reason };
  };

  // First, before any request: a join gives a server a credential and a place to send shares, so it is a person's act, at a
  // terminal of their own. An agent (or a script) that has been handed a link must not be able to finish it, whichever host
  // the link names, and the refusal says nothing about a way around it.
  if (deps.wrapped) return refuse('align join has to be run by you, in your own terminal, not from inside an agent.');
  if (!deps.isTTY) return refuse('align join needs a terminal: both input and output must be a terminal, so a person answers the questions.');

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
  // A gateway that wrote gw= into the link also reports its own address when asked. An answer with none, to a link that carried one, is not that gateway.
  if (peeked.gatewayClaim === undefined && link.gatewayFromLink) {
    return refuse(`The link names the server ${gwHost}, but that server did not say it is the one that made the link. Ask for a new link.`);
  }

  const claimed = visible(peeked.orgName).slice(0, ORG_NAME_MAX);
  const gwShown = describeHost(gwHost);
  const appShown = describeHost(peekAppHost);
  deps.out('\nJoining a team graph');
  deps.out(`  Gateway:  ${gwShown.text}`);
  deps.out(`  Web app:  ${appShown.text}`);
  deps.out(`  Org:      "${claimed || '(no name given)'}" (${ORG_NOTE})`);
  for (const w of new Set([gwShown.warning, appShown.warning])) if (w) deps.out(`  Warning:  ${w}`);

  const hostTyped = { done: false };
  if (needsTypeBack(gwHost, peekAppHost)) {
    const typed = await typeBack(deps, gwHost);
    if (typed === null || typed.trim().toLowerCase() !== gwHost) return refuse(`That is not ${gwHost}, so nothing was done.`);
    hostTyped.done = true;
  } else {
    // An Align address does not make the org name Align's: any hosted org picks its own name and can issue invites.
    const yes = await deps.promptLine(`Join "${claimed}" at ${gwHost}? The name is ${ORG_NOTE}. Type y to continue: `);
    if (yes === null || !/^y(es)?$/i.test(yes.trim())) return refuse('You did not answer y, so nothing was done.');
  }

  const derived = input.name ?? slugOrgName(claimed);
  if (!derived) return refuse('Could not make a name from the org name. Choose one with --name <name>.');
  const name = derived;
  if (deps.config.hasTeamDestination(name)) {
    if (!input.replace) return refuse(`You already have a destination called "${name}". Use --replace to replace it, or --name <other> to keep both.`);
    const refusal = await confirmReplace(deps, name, gwHost, claimed, hostTyped.done);
    if (refusal) return refuse(refusal);
  }

  const received = await receive(deps, link.token, peekApp, link.gatewayUrl);
  if (typeof received === 'string') return refuseLate(received);

  const me = await verifyToken(link.gatewayUrl, received.token);
  if (typeof me === 'string') return refuseLate(`${gwHost} ${me}`, { host: gwHost, ...(received.expiresAt ? { expiresAt: received.expiresAt } : {}) });

  const tenantName = visible(me.tenantName).slice(0, ORG_NAME_MAX);
  if (tenantName.trim() !== claimed.trim()) {
    deps.out(`\n  Heads up: the invite said "${claimed}" but you are signed in to "${tenantName}". Both come from ${gwHost}, so neither proves who runs it.`);
  }

  deps.config.saveTeamDestination(name, {
    gatewayUrl: link.gatewayUrl,
    appUrl: peekApp,
    authToken: received.token,
    tenantId: me.tenantId,
    orgNameClaimed: claimed,
  }, deps.now());

  await chooseShareDestination(deps, name, claimed, gwHost);

  deps.out(`\nJoined as "${name}" (${visible(me.email)}, ${tenantName}).`);
  if (received.expiresAt) deps.out(`  This access expires on ${received.expiresAt.slice(0, 10)}. Renew it with: align login --env ${name}`);
  deps.out(`  Use it with: align <command> --env ${name}`);
  return received.expiresAt ? { ok: true, name, expiresAt: received.expiresAt } : { ok: true, name };
}

/** Replacing a destination points a saved name at a server a person has not used under that name. Never silent. */
async function confirmReplace(deps: JoinDeps, name: string, newHost: string, claimed: string, hostAlreadyTyped: boolean): Promise<string | null> {
  let oldHost = '(unknown)';
  try { oldHost = new URL(deps.config.getEnvironment(name as never).gatewayUrl).host; } catch { /* unreadable entry: shown as unknown */ }
  deps.out(`\n  Replacing "${name}":  ${describeHost(oldHost).text}  ->  ${describeHost(newHost).text}`);
  if (!hostAlreadyTyped) {
    const typed = await deps.promptLine('Type the new gateway host to confirm the replacement: ');
    if (typed === null || typed.trim().toLowerCase() !== newHost) return `That is not ${newHost}, so "${name}" was not replaced.`;
  }
  if (deps.config.getShareDestination() === name) {
    const ok = await deps.confirm(`"${name}" is where "align share" sends decisions. Send them to "${claimed}" at ${newHost} instead?`);
    if (!ok) return `"${name}" was not replaced: it is where your shares go, and you did not agree to move them.`;
  }
  return null;
}

async function typeBack(deps: JoinDeps, gwHost: string): Promise<string | null> {
  deps.out(`\n  ${gwHost} is not an Align address. If you did not expect this link, stop here.`);
  return deps.promptLine('Type the gateway host to confirm: ');
}

/** Reads at most `max` bytes, and stops reading (cancels the stream) the moment it would pass that. Null when the body is too big. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
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
    const text = await readCapped(res, PEEK_MAX_BYTES);
    if (text === null) return `${host} sent an unexpectedly large answer.`;
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

async function receive(deps: JoinDeps, token: string, appUrl: string, gatewayUrl: string): Promise<{ token: string; expiresAt?: string } | string> {
  let result: CallbackResult;
  try {
    result = await deps.waitForCallback({
      ports: deps.callbackPorts,
      timeoutMs: deps.timeoutMs,
      onBound: async (port, nonce) => {
        // cli_gw: the gateway THIS CLI validated. The web app is the one party that knows its own gateway, so it can refuse a
        // link whose gw= was swapped for another server's, which no check on this side can tell from the real one.
        const url = `${appUrl}/join?token=${token}&cli_port=${port}&cli_nonce=${nonce}&cli_gw=${encodeURIComponent(gatewayUrl)}`;
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

export interface VerifiedIdentity { email: string; tenantId: string; tenantName: string }

const ID_SHAPE = /^[\x21-\x7e]{1,128}$/;
const EMAIL_SHAPE = /^[^\s\p{C}]{3,254}$/u;

/**
 * "Verified" means the gateway answered /auth/me like an Align gateway would, with this token and no other, not that it said 2xx.
 * Every field that is saved or printed is checked for type and shape first, so a hostile server cannot save an object as a tenant
 * id or put escape sequences on the person's screen. Anything else is a string saying why, and nothing is saved.
 */
export async function verifyToken(gatewayUrl: string, token: string): Promise<VerifiedIdentity | string> {
  let raw: unknown;
  try {
    raw = await createGatewayClient({ gatewayUrl, authToken: token, tenantId: null, mode: 'auth' }).whoami();
  } catch (e) {
    return `did not accept the new token (${visible(String((e as Error).message).slice(0, 120))}).`;
  }
  const r = raw as { user?: { email?: unknown }; tenant?: { id?: unknown; name?: unknown } } | null;
  const email = r?.user?.email;
  const id = r?.tenant?.id;
  const name = r?.tenant?.name;
  if (typeof email !== 'string' || !EMAIL_SHAPE.test(email) || typeof id !== 'string' || !ID_SHAPE.test(id) || typeof name !== 'string') {
    return 'answered, but not the way an Align gateway answers who you are. The token was not saved.';
  }
  return { email, tenantId: id, tenantName: name };
}

async function chooseShareDestination(deps: JoinDeps, name: string, claimed: string, gwHost: string): Promise<void> {
  const current = deps.config.getShareDestination();
  // Where shares go is a decision about where decisions are sent, so it is made by a yes at this terminal and never by default.
  // (A replace of the share destination was already agreed to, and keeps pointing at the name it had.)
  if (current !== name) {
    const q = current === null
      ? `Send "align share" to "${claimed}" at ${gwHost} from now on?`
      : `Send "align share" to "${claimed}" at ${gwHost} from now on? It currently goes to "${current}".`;
    if (!(await deps.confirm(q))) {
      deps.out(`  "align share" ${current === null ? 'has no destination yet' : `still goes to "${current}"`}. Send one share to "${name}" with --to ${name}.`);
      return;
    }
    deps.config.setShareDestination(name);
  }
  deps.out(`  Shares from this machine now go to "${claimed}" at ${gwHost}.`);
}
