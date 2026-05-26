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
    let server: http.Server | undefined;
    const nonce = randomBytes(16).toString('hex');

    const timer = setTimeout(() => {
      server?.close();
      reject(new Error('CLI OAuth timed out waiting for browser callback'));
    }, opts.timeoutMs);

    function tryPort(remaining: number[]): void {
      if (remaining.length === 0) {
        clearTimeout(timer);
        reject(new Error('No available port for CLI OAuth callback (tried all candidates)'));
        return;
      }
      const [port, ...rest] = remaining as [number, ...number[]];
      const s = http.createServer((req, res) => {
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
          s.close();
          resolve({ data: payload, port });
        });
      });
      s.on('error', (err: Error & { code?: string }) => {
        if (err.code === 'EADDRINUSE') {
          tryPort(rest);
          return;
        }
        clearTimeout(timer);
        reject(err);
      });
      s.listen(port, () => { server = s; void opts.onBound?.(port, nonce); });
    }

    tryPort(opts.ports);
  });
}

export const CLI_CALLBACK_PORTS = [7654, 7655, 7656, 7657, 7658];
