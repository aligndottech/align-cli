import http from 'node:http';
import { randomBytes } from 'node:crypto';

export interface CallbackResult {
  data: Record<string, unknown>;
  port: number;
}

export function waitForCallback(opts: {
  ports: number[];
  timeoutMs: number;
  onBound?: (port: number, nonce: string) => void | Promise<void>;
}): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let servers: http.Server[] = [];
    const closeAll = (): void => { for (const x of servers) x.close(); };
    const nonce = randomBytes(16).toString('hex');

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
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', () => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(body) as Record<string, unknown>;
          } catch {
            res.writeHead(400).end();
            reject(new Error('Invalid JSON received in CLI OAuth callback'));
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
          void opts.onBound?.(port, nonce);
        });
        s6.listen(port, '::1', () => { servers = [s, s6]; void opts.onBound?.(port, nonce); });
      });
    }

    tryPort(opts.ports);
  });
}

export const CLI_CALLBACK_PORTS = [7654, 7655, 7656, 7657, 7658];
