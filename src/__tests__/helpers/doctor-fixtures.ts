/**
 * Fixtures shared by the `align doctor` end-to-end test and the smoke-script test.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** A stand-in `align` that speaks just enough MCP. FAKE_MCP_MODE: ok | empty | call-401 | no-results | die. */
export const FAKE_ALIGN = `#!/usr/bin/env node
const fs = require('fs');
const log = process.env.FAKE_MCP_LOG;
const mode = process.env.FAKE_MCP_MODE || 'ok';
if (mode === 'die') { process.stderr.write('FATAL: Unknown environment bogus\\n'); process.exit(1); }
const seen = (m) => log && fs.appendFileSync(log, m + '\\n');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method) seen(m.method);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: ['align_search', 'align_ask'].map((name) => ({ name, description: 'x', inputSchema: { type: 'object' } })) } });
    else if (m.method === 'tools/call') {
      if (mode === 'empty') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '' }] } });
      else if (mode === 'no-results') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{}' }] } });
      else if (mode === 'call-401') send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'Gateway returned 401 for /decisions/smart-search' }] } });
      else send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"results":[{"title":"Use Postgres"}]}' }] } });
    }
  }
});
`;

export interface FakeGateway {
  server: http.Server;
  port: number;
  requests: Array<{ method: string; url: string; auth: string | undefined }>;
  /** searchStatus other than 200 makes POST /decisions/smart-search answer that status even for a good token. */
  mode: { searchStatus: number; hang: string[] };
}

/** A loopback gateway: /health, /auth/me and /decisions/smart-search answer for `goodToken` only; everything else is accepted and recorded. */
export async function startFakeGateway(goodToken: string): Promise<FakeGateway> {
  const requests: FakeGateway['requests'] = [];
  const mode = { searchStatus: 200, hang: [] as string[] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = req.headers['authorization'] as string | undefined;
      requests.push({ method: req.method ?? '', url: req.url ?? '', auth });
      if (mode.hang.includes(req.url ?? '')) return; // never answered
      const json = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
      const good = auth === `Bearer ${goodToken}`;
      if (req.url === '/health') return json(200, { ok: true });
      if (req.url === '/auth/me') return good ? json(200, { user: { email: 'buyer@example.test', role: 'member' }, tenant: { id: 't-1', name: 'Acme' } }) : json(401, { error: 'unauthorized' });
      if (req.url === '/decisions/smart-search') {
        if (mode.searchStatus !== 200) return json(mode.searchStatus, { error: 'unauthorized' });
        return good ? json(200, { results: [{ id: 'd1', title: 'Use Postgres' }] }) : json(401, { error: 'unauthorized' });
      }
      void body;
      return json(201, { ok: true });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests, mode };
}
