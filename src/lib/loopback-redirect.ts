import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { CLI_CALLBACK_PORTS } from './cli-oauth.js';

/**
 * An RFC 8252 loopback redirect receiver, for OAuth flows a PROVIDER completes.
 *
 * This exists because `waitForCallback` cannot serve one, and the difference is not
 * cosmetic. That function answers 405 to any non-POST and then requires a JSON body
 * carrying `cli_nonce` - which is the contract of the hosted gateway's browser page,
 * the only thing that had ever called it. A provider finishing an authorization-code
 * flow sends a plain GET with `?code=...&state=...` and no body at all.
 *
 * So the PKCE half of ALI-778 (GitLab, Linear, Zoom) could never complete: the
 * browser landed on a 405, nothing resolved, and the flow sat until its five-minute
 * timeout before reporting a failure and falling back to a token paste. Nothing
 * surfaced it, because no client id was ever configured, so the path was unreachable.
 *
 * Two properties `waitForCallback` did not give us, both required here:
 *   - `state` is CHECKED, not merely sent. A comment in local-oauth.ts claimed a
 *     stray request "cannot be mistaken for this flow's response"; nothing read it
 *     back, so the claim was false.
 *   - a provider `error=` redirect fails FAST with the provider's own reason,
 *     instead of looking identical to the user closing the tab.
 */

export interface LoopbackRedirectResult {
  code: string;
  state: string;
  port: number;
}

export interface LoopbackRedirectOptions {
  ports?: number[];
  timeoutMs?: number;
  /** Called once the port is bound, with the state this flow will require back. */
  onBound?: (port: number, state: string) => void | Promise<void>;
}

const PAGE = (heading: string, detail: string) =>
  `<!doctype html><meta charset="utf-8"><title>Align</title>` +
  `<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;text-align:center">` +
  `<h1 style="font-size:1.25rem">${heading}</h1><p>${detail}</p>` +
  `<p style="color:#666">You can close this tab.</p></body>`;

export function waitForLoopbackRedirect(
  opts: LoopbackRedirectOptions = {},
): Promise<LoopbackRedirectResult> {
  const ports = opts.ports ?? [...CLI_CALLBACK_PORTS];
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const state = randomBytes(16).toString('base64url');

  return new Promise<LoopbackRedirectResult>((resolve, reject) => {
    const tryPort = (list: number[]): void => {
      const [port, ...rest] = list;
      if (port === undefined) {
        reject(new Error(`No free loopback port among ${ports.join(', ')}`));
        return;
      }

      // One-shot: once the flow is done, drop the sockets too. server.close() alone
      // stops listening but leaves keep-alive connections open, which holds the
      // process open and lets a client pool reuse a socket to a dead server.
      const shutdown = (): void => {
        server.close();
        server.closeAllConnections?.();
      };

      const server = createServer((req, res) => {
        // A browser follows the provider's 302 with a GET. Anything else is not this
        // flow; answer plainly rather than resolving on it.
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        const q = url.searchParams;

        const finish = (status: number, body: string, err?: Error): void => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
          if (err) { clearTimeout(timer); shutdown(); reject(err); }
        };

        // Checked, not just sent. Without this a stray request to a fixed, publicly
        // known port could complete the flow.
        if (q.get('state') !== state) {
          finish(403, PAGE('Not this sign-in', 'The request did not match the one Align started.'));
          return;
        }

        const providerError = q.get('error');
        if (providerError) {
          const desc = q.get('error_description') ?? '';
          finish(
            200,
            PAGE('Sign-in cancelled', 'Align did not receive access.'),
            new Error(`${providerError}${desc ? `: ${desc}` : ''}`),
          );
          return;
        }

        const code = q.get('code');
        if (!code) {
          finish(400, PAGE('Something is missing', 'No authorization code was returned.'));
          return;
        }

        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(PAGE('Connected', 'Align has what it needs.'));
        clearTimeout(timer);
        shutdown();
        resolve({ code, state, port });
      });

      const timer = setTimeout(() => {
        shutdown();
        reject(new Error(`Timed out waiting for the browser to return to Align (port ${port})`));
      }, timeoutMs);

      server.on('error', (err: Error & { code?: string }) => {
        if (err.code === 'EADDRINUSE') { clearTimeout(timer); tryPort(rest); return; }
        clearTimeout(timer);
        reject(err);
      });

      server.listen(port, '127.0.0.1', () => { void opts.onBound?.(port, state); });
    };

    tryPort(ports);
  });
}
