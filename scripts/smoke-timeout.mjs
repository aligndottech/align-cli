#!/usr/bin/env node
/**
 * Portable timeout runner: `node smoke-timeout.mjs <seconds> <cmd> [args...]`.
 *
 * Exists because the smoke matrix spans ubuntu/macos/windows and no `timeout`
 * binary is on PATH on all three (macOS ships none; Git Bash varies). Node is
 * the one runtime every leg is guaranteed to have.
 *
 * Exit codes: the child's own code on completion; 124 on timeout (matching GNU
 * timeout, so a hang is distinguishable from a real failure in the log).
 */
import { spawn } from 'node:child_process';

const [, , secondsArg, cmd, ...args] = process.argv;
const seconds = Number(secondsArg);
if (!Number.isFinite(seconds) || seconds <= 0 || !cmd) {
  console.error('usage: smoke-timeout.mjs <seconds> <cmd> [args...]');
  process.exit(2);
}

// stdin is closed deliberately ('ignore'): the smoke asserts every command
// completes without a terminal, which is the scripted/CI condition under test.
const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: false });

const timer = setTimeout(() => {
  console.error(`smoke-timeout: '${cmd}' still running after ${seconds}s - killing (exit 124)`);
  child.kill('SIGKILL');
  // Give the kill a moment to propagate, then hard-exit regardless.
  setTimeout(() => process.exit(124), 2000).unref();
}, seconds * 1000);

child.on('error', (err) => {
  clearTimeout(timer);
  console.error(`smoke-timeout: failed to start '${cmd}': ${err.message}`);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (signal === 'SIGKILL') process.exit(124);
  process.exit(code ?? 1);
});
