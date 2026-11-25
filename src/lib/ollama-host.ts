/**
 * The one place OLLAMA_HOST is read and turned into a base URL.
 *
 * The rules are Ollama's own (envconfig.Host in github.com/ollama/ollama), so a value that
 * works for `ollama run` works here: no scheme means http; with no scheme a missing port is
 * 11434, while http:// and https:// default to 80 and 443; an empty host is 127.0.0.1; a
 * path survives without its trailing slash; a port that is not 0-65535 falls back to the
 * default. Unset, empty and whitespace-only all mean "not configured" and give our existing
 * default (localhost, 11434) - an empty string must never reach fetch as a relative URL.
 *
 * One rule differs from Ollama's. Ollama takes the text before the first "://" as the scheme,
 * wherever that "://" is. Here that text is a scheme only when it holds no "/", "?", "#" or
 * "@". With one of those in it the "://" sits in a path, a query or a fragment, or follows a
 * user name, and reading it as a scheme would put a password or a token into the URL we print.
 */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

function splitHostPort(hostport: string): { host: string; port: string } | null {
  if (hostport.startsWith('[')) {
    const m = /^\[([^\]]*)\](?::(.*))?$/.exec(hostport);
    return m ? { host: m[1]!, port: m[2] ?? '' } : null;
  }
  const first = hostport.indexOf(':');
  if (first === -1 || first !== hostport.lastIndexOf(':')) return null; // bare host, or bare IPv6
  return { host: hostport.slice(0, first), port: hostport.slice(first + 1) };
}

export function ollamaBaseUrl(raw: string | undefined = process.env['OLLAMA_HOST']): string {
  const s = (raw ?? '').trim();
  if (!s) return DEFAULT_OLLAMA_URL;

  let scheme = 'http';
  let defaultPort = '11434';
  let rest = s;
  const lead = /^([^/?#@]*):\/\//.exec(s);
  if (lead) {
    scheme = lead[1]!;
    rest = s.slice(lead[0].length);
    if (scheme === 'http') defaultPort = '80';
    else if (scheme === 'https') defaultPort = '443';
  }

  // Past the first ? or # is a query or fragment, which Ollama's client drops with the rest of what it does
  // not use; so is a user:pass@ in front of the host. Neither may reach a URL we print or send.
  rest = rest.replace(/[?#].*$/s, '');
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const hostport = authority.slice(authority.lastIndexOf('@') + 1);
  const path = slash === -1 ? '' : rest.slice(slash).replace(/\/+$/, '');

  const parts = splitHostPort(hostport);
  let host: string;
  let port: string;
  if (parts) {
    host = parts.host || '127.0.0.1';
    port = parts.port;
  } else {
    port = defaultPort;
    host = hostport.replace(/^\[|\]$/g, '') || '127.0.0.1';
  }
  const n = /^\d+$/.test(port) ? Number(port) : NaN;
  if (!(n >= 0 && n <= 65535)) port = defaultPort;

  return `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}${path}`;
}

/**
 * OLLAMA_HOST as it may be shown in a message, or undefined when it is not set. A value carrying a user name,
 * a password, a query or a fragment may hold a secret (mcp-child-env.ts treats it the same way), so it is
 * shown as the normalised URL only, which has none of those by construction.
 */
export function configuredOllamaHost(): string | undefined {
  const v = (process.env['OLLAMA_HOST'] ?? '').trim();
  if (!v) return undefined;
  return /[@?#]/.test(v) ? ollamaBaseUrl(v) : v;
}
