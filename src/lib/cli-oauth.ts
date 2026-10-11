import http from 'node:http';
import { randomBytes } from 'node:crypto';

export interface CallbackResult {
  data: Record<string, unknown>;
  port: number;
}

/** The page posts a token and a nonce: well under this. Anything larger is not it. */
const MAX_BODY_BYTES = 8 * 1024;

export function waitForCallback(opts: {
  ports: number[];
  timeoutMs: number;
  onBound?: (port: number, nonce: string) => void | Promise<void>;
  /** Stops the wait: the listeners close and the promise rejects. */
  signal?: AbortSignal;
}): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let servers: http.Server[] = [];
    const closeAll = (): void => { for (const x of servers) x.close(); };
    const nonce = randomBytes(16).toString('hex');

    opts.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      closeAll();
      reject(new Error('cancelled'));
    }, { once: true });
    const timer = setTimeout(() => {
      closeAll();
      reject(new Error('CLI OAuth timed out waiting for browser callback'));
    }, opts.timeoutMs);

    function tryPort(remaining: number[]): void {
      if (remaining.length === 0) {
        clearTimeout(timer);
        reject(new Error('No available port for CLI OAuth callback (tried all candidates)'));
        return;
      }
      const [port, ...rest] = remaining as [number, ...number[]];
      const onRequest: http.RequestListener = (req, res) => {
        const origin = req.headers['origin'];
        if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (origin) res.setHeader('Vary', 'Origin');

        if (req.method === 'OPTIONS') {
          res.writeHead(204).end();
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        // Any web page can POST here (a no-cors request needs no permission), so what arrives is read under a bound and a
        // stray request is answered and ignored. Only the right nonce ends the wait.
        const chunks: Buffer[] = [];
        let size = 0;
        let tooBig = false;
        req.on('data', (chunk: Buffer) => {
          if (tooBig) return;
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            tooBig = true;
            res.writeHead(413, { Connection: 'close' }).end(() => req.destroy());
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (tooBig) return;
          let parsed: Record<string, unknown>;
          try {
            const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
            parsed = v as Record<string, unknown>;
          } catch {
            res.writeHead(400).end();
            return;
          }
          if (parsed['cli_nonce'] !== nonce) {
            res.writeHead(403).end();
            return;
          }
          const { cli_nonce: _, ...payload } = parsed;
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
          clearTimeout(timer);
          closeAll();
          resolve({ data: payload, port });
        });
      };
      const s = http.createServer(onRequest);
      s.on('error', (err: Error & { code?: string }) => {
        if (err.code === 'EADDRINUSE') {
          tryPort(rest);
          return;
        }
        clearTimeout(timer);
        reject(err);
      });
      // 127.0.0.1, not every interface: this socket accepts a credential, and on 0.0.0.0 anyone on the LAN can dial it (ALI-1504).
      s.listen(port, '127.0.0.1', () => {
        // The web page posts to http://localhost, which a browser may resolve to ::1. Answer there too, or the token goes to
        // whatever else holds ::1 on this port. A port whose ::1 side is taken is skipped whole: never half of a pair.
        const s6 = http.createServer(onRequest);
        s6.once('error', (err: Error & { code?: string }) => {
          if (err.code === 'EADDRINUSE') {
            s.close();
            tryPort(rest);
            return;
          }
          // No IPv6 loopback on this machine (a container, a disabled stack): IPv4 alone is all there is to answer on.
          servers = [s];
          if (opts.signal?.aborted) { closeAll(); return; }
          void opts.onBound?.(port, nonce);
        });
        s6.listen(port, '::1', () => { servers = [s, s6]; if (opts.signal?.aborted) { closeAll(); return; } void opts.onBound?.(port, nonce); });
      });
    }

    tryPort(opts.ports);
  });
}

export const CLI_CALLBACK_PORTS = [7654, 7655, 7656, 7657, 7658];
