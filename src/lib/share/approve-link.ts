/**
 * The gate between an approval link and anything that acts on it: a browser launch, a QR code, a clipboard write.
 *
 * The link is built from three parts the CLI does not fully control: the app URL (from config or an env var),
 * the request id (the gateway's answer) and the key (random, ours). Before any of it reaches a child process or the
 * terminal as anything but text, the WHOLE string must match one exact shape:
 *
 *   <scheme>://<host[:port]>/share/approve/<uuid>#k=<43 base64url characters>
 *
 * with the origin equal to the configured app's origin, https (http only for a localhost dev app), no userinfo, no
 * query, no extra path, no whitespace or control characters, and a length cap. A string that passes contains none of
 * the characters a shell, a PowerShell string or an argv parser treats specially. Callers must still pass it as an
 * argument vector and never build a shell string from it; this is the second belt, not the first.
 */
export type LinkCheck = { ok: true; url: string } | { ok: false; reason: string };

export const MAX_LINK_LENGTH = 220;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HOST = '(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*';
const AUTHORITY = `(?:${HOST}|\\[::1\\])(?::[0-9]{1,5})?`;
const LINK_RE = new RegExp(`^(https?)://(${AUTHORITY})/share/approve/(${UUID})#k=([A-Za-z0-9_-]{43})$`, 'i');
const APP_RE = new RegExp(`^(https?)://(${AUTHORITY})/*$`, 'i');

const isLocalHost = (authority: string): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?$/i.test(authority);
const refuse = (reason: string): LinkCheck => ({ ok: false, reason });

export function checkApproveLink(url: string, appUrl: string): LinkCheck {
  if (typeof url !== 'string' || typeof appUrl !== 'string') return refuse('not a string');
  if (url.length > MAX_LINK_LENGTH) return refuse('too long');
  const app = APP_RE.exec(appUrl);
  if (!app) return refuse('the configured app URL is not a plain origin');
  const m = LINK_RE.exec(url);
  if (!m) return refuse('not the shape of an approval link');
  const [, scheme, authority] = m as unknown as [string, string, string];
  if (scheme.toLowerCase() === 'http' && !isLocalHost(authority)) return refuse('http is only for a localhost app');
  if (`${scheme}://${authority}`.toLowerCase() !== `${app[1]}://${app[2]}`.toLowerCase()) return refuse('not the configured app');
  return { ok: true, url };
}
