#!/usr/bin/env node
/**
 * ALI-1135: what `align mcp --setup` WRITES must be spawnable by a client that does not use a
 * shell. `node smoke-mcp-config-spawn.mjs <installed-cli-package-dir>`.
 *
 * The install smoke already asserts that `align mcp --setup` exits 0, and that a bare `align`
 * completes an MCP handshake when spawned THROUGH a shell. Neither of those can see this
 * defect. The setup step writes no config at all on CI, because the harness exports a synthetic
 * HOME and detectEditors() then finds no editor; and the handshake step passes
 * `shell: process.platform === 'win32'`, which is precisely the thing VS Code does not do.
 *
 * So this drives the write itself, through the INSTALLED package's own writer, and then spawns
 * exactly what landed in the file with `shell: false` - the way a client spawns it. On Windows
 * an npm global install exposes `align.cmd`, which no shell-less spawn can launch, so a config
 * naming a bare `align` fails here and a `cmd /c align` one does not.
 *
 * MEASURED, rather than assumed. A temporary probe on this branch spawned the OLD form
 * (`command: "align"`, shell:false) on both legs of this matrix:
 *   windows-latest -> spawned=false, `spawn align ENOENT`   (the defect, reproduced)
 *   ubuntu-latest  -> spawned=true                          (the control: POSIX unaffected)
 * It was reverted rather than kept, because a permanent assertion that a bare `align` FAILS
 * would go red the day npm ships a real executable, which would be good news.
 *
 * Exit codes: 0 on a config that spawns and answers `initialize`; 1 on a bad config, a spawn
 * failure or a protocol failure; 2 on usage; 124 on timeout.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: smoke-mcp-config-spawn.mjs <installed-cli-package-dir>');
  process.exit(2);
}

// A missing subject passes any assertion below for the wrong reason, so it is fatal rather
// than a failure (tdd.md, "make a missing subject FATAL, not a test").
const writerPath = path.join(pkgDir, 'dist', 'lib', 'mcp-setup.js');
if (!existsSync(writerPath)) {
  console.error(`FATAL: ${writerPath} does not exist - the installed package has no MCP writer to drive`);
  process.exit(2);
}

const TIMEOUT_MS = 30_000;
const fail = (msg) => { console.error(`smoke-mcp-config-spawn: ${msg}`); process.exit(1); };

/** Can this harness SEE an unspawnable command? If not, its pass below means nothing. */
function negativeControl() {
  return new Promise((resolve) => {
    const bogus = spawn('align-no-such-binary-ali1135', ['mcp'], { stdio: 'ignore', shell: false });
    bogus.on('error', () => resolve(true));
    bogus.on('spawn', () => { bogus.kill(); resolve(false); });
  });
}

const { writeMcpConfig } = await import(pathToFileURL(writerPath).href);

if (!(await negativeControl())) {
  fail('negative control did not fire: a command that cannot exist spawned anyway, so a clean pass here proves nothing');
}
console.log('smoke-mcp-config-spawn: negative control OK - an unspawnable command is detected');

const dir = mkdtempSync(path.join(tmpdir(), 'align-mcp-cfg-'));
const configPath = path.join(dir, 'mcp.json');
writeMcpConfig({ name: 'VS Code', configPath, format: 'vscode' }, 'local');

const entry = JSON.parse(readFileSync(configPath, 'utf8')).servers?.align;
if (!entry) fail(`no servers.align entry in the config that was just written (${configPath})`);
console.log(`smoke-mcp-config-spawn: wrote ${JSON.stringify(entry)}`);

// The command has to be spawnable AND still run our server. A config that spawns something
// else would satisfy the handshake-free half of this check and ship a broken setup.
const argv = [entry.command, ...(entry.args ?? [])].join(' ');
if (!argv.includes('align') || !argv.includes('mcp')) fail(`the written entry does not invoke align mcp: ${argv}`);

const child = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'inherit'], shell: false });

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`smoke-mcp-config-spawn: no initialize response within ${TIMEOUT_MS / 1000}s`);
  child.kill('SIGKILL');
  setTimeout(() => process.exit(124), 2000).unref();
}, TIMEOUT_MS);

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  try { child.kill(); } catch { /* already gone */ }
  process.exit(code);
}

child.on('error', (err) => {
  console.error(
    `smoke-mcp-config-spawn: the config align just wrote is NOT spawnable on ${process.platform}: ` +
    `spawn ${entry.command} failed with ${err.message}`,
  );
  finish(1);
});

child.on('exit', (code) => {
  if (timedOut) finish(124);
  else if (!done) { console.error(`smoke-mcp-config-spawn: server exited early (code ${code})`); finish(1); }
});

let buffer = '';
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
      console.error(`smoke-mcp-config-spawn: non-JSON on stdout: ${line.slice(0, 200)}`);
      finish(1);
      return;
    }
    if (msg.id === 1) {
      if (!msg.result) { console.error(`smoke-mcp-config-spawn: initialize returned no result: ${line.slice(0, 200)}`); finish(1); return; }
      console.log(`smoke-mcp-config-spawn: OK - the written config spawned without a shell and answered initialize on ${process.platform}`);
      finish(0);
    }
  }
});

child.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'align-config-spawn-smoke', version: '0.0.0' } },
})}\n`);
