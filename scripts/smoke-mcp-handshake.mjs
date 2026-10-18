#!/usr/bin/env node
/**
 * MCP handshake smoke: `node smoke-mcp-handshake.mjs <align-binary> [env]` (env defaults to local).
 *
 * Spawns `align mcp --env <env>` as a real MCP client would (stdio transport),
 * performs the protocol handshake (initialize -> notifications/initialized ->
 * tools/list), asserts the tool list names `align_search`, then makes one real
 * tools/call of `align_ask` that must come back with non-empty text.
 *
 * The tools/call step is the point (ALI-1740). tools/list is answered locally by
 * the server and never reaches the graph or the gateway, so it passes with a
 * wrong-type credential or a broken backend. A smoke that stops there goes green
 * on an install that cannot answer a single question.
 *
 * This is the "verify MCP handshake" launch-gate condition from ALI-214, made
 * repeatable. It crosses the layer unit tests cannot: the installed binary,
 * its shebang, Commander's argv parsing, and the stdio framing - not the
 * dispatch functions the existing mcp-*.test.ts suites already pin.
 *
 * Exit codes: 0 on a handshake that lists align_search AND a tools/call that returns
 * text; 1 on any protocol failure, a JSON-RPC error, a tool error or an empty answer;
 * 124 on timeout (no response inside 30s reads as a hung server).
 */
import { spawn } from 'node:child_process';

const bin = process.argv[2];
if (!bin) {
  console.error('usage: smoke-mcp-handshake.mjs <align-binary>');
  process.exit(2);
}

const envName = process.argv[3] ?? 'local';
const QUESTION = 'postgres';

const TIMEOUT_MS = 30_000;
// The first real question may start the embedding model (local env), so it gets its own, longer budget.
const CALL_TIMEOUT_MS = 50_000;
// Windows global installs expose align.cmd, which spawn() only resolves via a shell.
const child = spawn(bin, ['mcp', '--env', envName], {
  // ALIGN_DOCTOR=1: this smoke asks a real question, and a local run must not send the server's usage pings.
  env: { ...process.env, ALIGN_DOCTOR: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
});

// Timeout is a flag, not a scheduled exit: killing the child fires its 'exit'
// handler, which would otherwise reach finish(1) first and report a hung
// server as a protocol failure. finish() reads the flag so 124 always wins.
let timedOut = false;
let awaiting = 'tools/list';
let timer;
let armedMs = TIMEOUT_MS;
function arm(ms) {
  clearTimeout(timer);
  armedMs = ms;
  timer = setTimeout(() => {
    timedOut = true;
    console.error(`smoke-mcp-handshake: no ${awaiting} response within ${armedMs / 1000}s`);
    child.kill('SIGKILL');
    // Backstop in case the child ignores the kill and 'exit' never fires.
    setTimeout(() => process.exit(124), 2000).unref();
  }, ms);
}
arm(TIMEOUT_MS);

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
        console.log(`smoke-mcp-handshake: ${tools.length} tools listed, align_search present; now a real tools/call`);
        awaiting = 'tools/call';
        arm(CALL_TIMEOUT_MS);
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'align_ask', arguments: { question: QUESTION } } });
      }
    } else if (msg.id === 3) {
      if (msg.error) {
        console.error(`smoke-mcp-handshake: tools/call align_ask failed with a JSON-RPC error: ${JSON.stringify(msg.error).slice(0, 300)}`);
        finish(1);
        return;
      }
      const content = Array.isArray(msg.result?.content) ? msg.result.content : [];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      if (msg.result?.isError === true) {
        console.error(`smoke-mcp-handshake: tools/call align_ask reported a tool error: ${text.slice(0, 300)}`);
        finish(1);
      } else if (text.trim() === '') {
        console.error('smoke-mcp-handshake: tools/call align_ask returned no text - an empty answer is a failure, not a pass');
        finish(1);
      } else if (!hasResultsList(text)) {
        console.error(`smoke-mcp-handshake: tools/call align_ask returned JSON with no results list - an empty answer is a failure, not a pass: ${text.slice(0, 200)}`);
        finish(1);
      } else {
        console.log(`smoke-mcp-handshake: OK - tools/call align_ask returned ${text.length} characters`);
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
    console.error(`smoke-mcp-handshake: server exited early (code ${code}) before ${awaiting} answered`);
    finish(1);
  }
});

// JSON text must carry a results list (an empty one is a real answer from an empty graph); plain text passes.
function hasResultsList(text) {
  try {
    return Array.isArray(JSON.parse(text)?.results);
  } catch {
    return true;
  }
}

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
