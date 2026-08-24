#!/usr/bin/env node
/**
 * MCP handshake smoke: `node smoke-mcp-handshake.mjs <align-binary>`.
 *
 * Spawns `align mcp --env local` as a real MCP client would (stdio transport),
 * performs the protocol handshake (initialize -> notifications/initialized ->
 * tools/list), and asserts the tool list names `align_search`.
 *
 * This is the "verify MCP handshake" launch-gate condition from ALI-214, made
 * repeatable. It crosses the layer unit tests cannot: the installed binary,
 * its shebang, Commander's argv parsing, and the stdio framing - not the
 * dispatch functions the existing mcp-*.test.ts suites already pin.
 *
 * Exit codes: 0 on a handshake that lists align_search; 1 on any protocol
 * failure; 124 on timeout (no response inside 30s reads as a hung server).
 */
import { spawn } from 'node:child_process';

const bin = process.argv[2];
if (!bin) {
  console.error('usage: smoke-mcp-handshake.mjs <align-binary>');
  process.exit(2);
}

const TIMEOUT_MS = 30_000;
// Windows global installs expose align.cmd, which spawn() only resolves via a shell.
const child = spawn(bin, ['mcp', '--env', 'local'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
});

// Timeout is a flag, not a scheduled exit: killing the child fires its 'exit'
// handler, which would otherwise reach finish(1) first and report a hung
// server as a protocol failure. finish() reads the flag so 124 always wins.
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`smoke-mcp-handshake: no tools/list response within ${TIMEOUT_MS / 1000}s`);
  child.kill('SIGKILL');
  // Backstop in case the child ignores the kill and 'exit' never fires.
  setTimeout(() => process.exit(124), 2000).unref();
}, TIMEOUT_MS);

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

let buffer = '';
let initialized = false;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`smoke-mcp-handshake: non-JSON on stdout (protocol corruption): ${line.slice(0, 200)}`);
      finish(1);
      return;
    }
    if (msg.id === 1 && !initialized) {
      initialized = true;
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (msg.id === 2) {
      const tools = msg.result?.tools?.map((t) => t.name) ?? [];
      if (tools.length === 0) {
        console.error('smoke-mcp-handshake: tools/list returned zero tools - the parse found nothing, which is a failure, not an empty success');
        finish(1);
      } else if (!tools.includes('align_search')) {
        console.error(`smoke-mcp-handshake: align_search missing from tools/list (got: ${tools.join(', ')})`);
        finish(1);
      } else {
        console.log(`smoke-mcp-handshake: OK - ${tools.length} tools listed, align_search present`);
        finish(0);
      }
    }
  }
});

child.on('error', (err) => {
  console.error(`smoke-mcp-handshake: failed to start '${bin}': ${err.message}`);
  finish(127);
});

child.on('exit', (code) => {
  if (timedOut) {
    finish(124);
    return;
  }
  // The server must not exit before the handshake completes.
  if (!done) {
    console.error(`smoke-mcp-handshake: server exited early (code ${code}) before tools/list answered`);
    finish(1);
  }
});

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  try { child.kill(); } catch { /* already gone */ }
  process.exit(code);
}

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'align-install-smoke', version: '0.0.0' },
  },
});
