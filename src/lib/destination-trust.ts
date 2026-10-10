import { domainToUnicode } from 'node:url';
import { validateDestinationName } from './destination-name.js';

/**
 * Pure trust rules for a team destination: what a gateway or web-app URL may look like before the
 * CLI will send a credential to it, or open a browser at it. No I/O here, so every rule is a
 * plain test and the same functions serve `align join`, the config setter and the share preview.
 */

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * https, or http to the loopback only. Returns the normalised origin (lowercase host, no trailing
 * slash). A URL that carries credentials, a path, a query or a fragment is refused: the first is
 * how `https://api.align.tech@evil.example` passes a glance, and the rest would make two spellings
 * of one server compare unequal. Exact host match is on the parsed hostname, never a prefix.
 */
export function assertTransport(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TransportError(`"${raw.slice(0, 80)}" is not a URL`);
  }
  if (u.username || u.password) throw new TransportError('the URL must not carry a username or password');
  if (u.pathname !== '/' || u.search || u.hash) throw new TransportError('use the server address only, with no path, query or fragment');
  const loopback = LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new TransportError(`${u.host} must be reached over https (http is allowed only for localhost)`);
  }
  return u.origin;
}

/** `align.tech` or a subdomain of it, on a label boundary (`api.align.tech.evil.example` and `evilalign.tech` are not). Any port. */
export function isAlignHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return h === 'align.tech' || h.endsWith('.align.tech');
}

/**
 * Whether the person must type the gateway host back before the CLI trusts it. False only when
 * BOTH hosts are Align's own, on a label boundary: `api.align.tech.evil.example` and
 * `evilalign.tech` both need it. Either host being foreign is enough to need it, because a
 * real gateway with an attacker's web app (or the reverse) is the same phish.
 */
export function needsTypeBack(gatewayHost: string, appHost: string): boolean {
  return !(isAlignHost(gatewayHost) && isAlignHost(appHost));
}

/**
 * A host as it should be printed before a person trusts it. URL parsing already turns a
 * non-ASCII host into punycode, so a lookalike (a Cyrillic "a") arrives as `xn--...` and would
 * read as noise; show the decoded form beside the raw one and say why.
 */
export function describeHost(host: string): { text: string; warning: string | null } {
  const m = /^(.*?)(:\d+)?$/.exec(host);
  const name = m?.[1] ?? host;
  const port = m?.[2] ?? '';
  const decoded = domainToUnicode(name);
  if (decoded === '' || decoded === name) return { text: host, warning: null };
  return {
    text: `${host} (shown as ${decoded}${port})`,
    warning: 'This host name uses non-ASCII characters, which can imitate another address. Compare the raw form above character by character.',
  };
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface ParsedJoinLink {
  token: string;
  /** Normalised origin of the gateway the link (or --gateway) names. */
  gatewayUrl: string;
  /** `host[:port]` of the web app the link points at, compared with the gateway's own claim later. */
  appHost: string;
}

/**
 * Reads an invite link. Nothing here trusts the link: it is only a claim that the gateway's
 * own `invite-peek` answer is later checked against. The gateway comes from the link's `gw`
 * parameter or `--gateway`; with neither there is nothing to ask, and guessing one from the app
 * host is exactly the substitution this flow exists to prevent.
 */
export function parseJoinLink(raw: string, opts: { gateway?: string } = {}): ParsedJoinLink {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TransportError('That does not look like an invite link. Paste the whole link, in quotes.');
  }
  const appOrigin = assertTransport(u.origin);
  const token = u.searchParams.get('token') ?? '';
  if (!TOKEN_RE.test(token)) throw new TransportError('The link has no valid invite token. Ask for a new link.');
  const gw = u.searchParams.get('gw');
  const flag = opts.gateway;
  const fromLink = gw ? assertTransport(gw) : null;
  const fromFlag = flag ? assertTransport(flag) : null;
  if (fromLink && fromFlag && fromLink !== fromFlag) {
    throw new TransportError(`The link names ${new URL(fromLink).host} but --gateway names ${new URL(fromFlag).host}. They differ, so nothing was done.`);
  }
  const gatewayUrl = fromLink ?? fromFlag;
  if (!gatewayUrl) {
    throw new TransportError('The link does not say which server to join. Ask the sender for a newer link, or pass the gateway yourself: --gateway https://api.<their-domain>');
  }
  return { token, gatewayUrl, appHost: new URL(appOrigin).host };
}

/** A destination name derived from the org name the server claimed, or null when nothing usable is left. */
export function slugOrgName(claimed: string): string | null {
  const slug = claimed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  return validateDestinationName(slug) === null ? slug : null;
}
