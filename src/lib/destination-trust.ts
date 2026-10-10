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
