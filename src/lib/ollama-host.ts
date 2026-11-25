/**
 * The one place OLLAMA_HOST is read and turned into a base URL.
 *
 * The rules are Ollama's own (envconfig.Host in github.com/ollama/ollama), so a value that
 * works for `ollama run` works here: no "://" means http; with no scheme a missing port is
 * 11434, while http:// and https:// default to 80 and 443; an empty host is 127.0.0.1; a
 * path survives without its trailing slash; a port that is not 0-65535 falls back to the
 * default. Unset, empty and whitespace-only all mean "not configured" and give our existing
 * default (localhost, 11434) - an empty string must never reach fetch as a relative URL.
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
  const sep = s.indexOf('://');
  if (sep !== -1) {
    scheme = s.slice(0, sep);
    rest = s.slice(sep + 3);
    if (scheme === 'http') defaultPort = '80';
    else if (scheme === 'https') defaultPort = '443';
  }

  const slash = rest.indexOf('/');
  const hostport = slash === -1 ? rest : rest.slice(0, slash);
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

/** The raw OLLAMA_HOST when one is set (non-blank), for naming it in an error. */
export function configuredOllamaHost(): string | undefined {
  const v = (process.env['OLLAMA_HOST'] ?? '').trim();
  return v || undefined;
}
