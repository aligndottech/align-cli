#!/usr/bin/env node
/**
 * Portable timeout runner: `node smoke-timeout.mjs <seconds> <cmd> [args...]`.
 *
 * Exists because the smoke matrix spans ubuntu/macos/windows and no `timeout`
 * binary is on PATH on all three (macOS ships none; Git Bash varies). Node is
 * the one runtime every leg is guaranteed to have.
 *
 * Windows needs a shell: `npm i -g` exposes align as align.cmd, which spawn()
 * cannot exec directly (ENOENT with shell:false - that failure took out all
 * three windows legs on the first CI run). cmd.exe resolves it via PATHEXT.
 * Node's shell:true joins argv with spaces and quotes NOTHING, so an argument
 * containing a space is silently split into two.
 *
 * That precondition used to be stated here and nothing enforced it, which cost
 * two rounds of misdiagnosis: a step carrying `align ask "why postgres"` made
 * cmd.exe see `ask why postgres`, Commander bound query="why" and dropped the
 * rest (it permits excess arguments), and the empty result was written up as a
 * platform embedding defect. It is a check now - see REFUSED below - and any
 * command that needs to pass real text uses --stdin-file rather than a shell
 * pipeline, because `sh -c "printf ... | align"` is mangled the same way.
 *
 * Exit codes: the child's own code on completion; 124 on timeout (matching GNU
 * timeout, so a hang is distinguishable from a real failure in the log). The
 * timeout is tracked with a flag, not by inspecting the kill signal - on
 * Windows the 'exit' handler's signal argument is unreliable, and the exit
 * handler can win the race against a scheduled process.exit(124).
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

const argv = process.argv.slice(2);
// Optional leading `--stdin-file <path>`, so a command that needs real text on stdin does not
// need a shell pipeline to get it.
let stdinFile = null;
if (argv[0] === '--stdin-file') {
  stdinFile = argv[1];
  argv.splice(0, 2);
}

const [secondsArg, cmd, ...args] = argv;
const seconds = Number(secondsArg);
if (!Number.isFinite(seconds) || seconds <= 0 || !cmd) {
  console.error('usage: smoke-timeout.mjs [--stdin-file <path>] <seconds> <cmd> [args...]');
  process.exit(2);
}

// REFUSED, rather than documented: shell:true on win32 quotes nothing, so this argument would
// arrive as two. Enforced on every platform because the SHAPE is what is wrong - letting it run
// on ubuntu and macos is how it reached Windows in the first place.
const spaced = [cmd, ...args].find((a) => /\s/.test(a));
if (spaced !== undefined) {
  console.error(
    `smoke-timeout: argument contains a space and cannot survive the win32 shell join: ${JSON.stringify(spaced)}\n` +
      '  Use a single-token argument, or pass the text via --stdin-file.',
  );
  process.exit(2);
}

// Opened before spawning so an unreadable payload fails loudly here. Feeding the child an empty
// stdin instead would look exactly like a command that legitimately had nothing to read.
let stdin = 'ignore';
if (stdinFile !== null) {
  try {
    stdin = openSync(stdinFile, 'r');
  } catch (err) {
    console.error(`smoke-timeout: cannot read --stdin-file ${stdinFile}: ${err.message}`);
    process.exit(2);
  }
}

// stdin defaults to closed ('ignore'): the smoke asserts every command completes without a
// terminal, which is the scripted/CI condition under test.
const child = spawn(cmd, args, {
  stdio: [stdin, 'inherit', 'inherit'],
  shell: process.platform === 'win32',
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`smoke-timeout: '${cmd}' still running after ${seconds}s - killing (exit 124)`);
  child.kill('SIGKILL');
  // Backstop in case the child ignores the kill and 'exit' never fires.
  setTimeout(() => process.exit(124), 2000).unref();
}, seconds * 1000);

child.on('error', (err) => {
  clearTimeout(timer);
  console.error(`smoke-timeout: failed to start '${cmd}': ${err.message}`);
  process.exit(127);
});

child.on('exit', (code) => {
  clearTimeout(timer);
  if (timedOut) process.exit(124);
  process.exit(code ?? 1);
});
