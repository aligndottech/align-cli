/**
 * ALI-951: `align --help` is five entries in at most 14 lines. Every other command still
 * parses and runs, hidden, and is documented in docs/commands.md, the full reference this
 * suite pins (rather than an `align --help --all`, which does not exist).
 *
 * Measured before (origin/main 279672f): 24 visible top-level commands, 29 subcommands,
 * 137 flags, `align --help` 54 lines. Benchmark: Claude Code documents 34 subcommands and
 * its quickstart shows one - bare command = product, subcommands = escape hatches.
 *
 * Nothing here touches the network: the only action ever run is `--help`, which Commander
 * handles before any command's own action. Modules with startup side effects are mocked so
 * building the tree stays a pure read.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CommanderError } from 'commander';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../commands/default-action.js', () => ({ runDefaultAction: vi.fn() }));

import { buildProgram } from '../cli.js';
import { COMMAND_REGISTRY, visibleEntries } from '../commands/registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMANDS_DOC = readFileSync(join(ROOT, 'docs', 'commands.md'), 'utf8');

/** Runs `align <argv>` against a fresh tree and returns what Commander wrote to stdout. */
async function helpOutput(argv: string[]): Promise<string> {
  let out = '';
  const program = buildProgram({
    internal: true,
    exitOverride: true,
    output: { writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } },
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    // Commander signals a displayed help through its exit override; anything else is real.
    if (!(e instanceof CommanderError) || e.code !== 'commander.helpDisplayed') throw e;
  }
  return out;
}

/** The command names `align --help` lists: the first word of every two-space-indented line
 *  that does not start an option (`-V`, `-h`). */
function listedEntries(help: string): string[] {
  return help
    .split('\n')
    .map((l) => /^ {2}([a-z]+)\b/.exec(l)?.[1])
    .filter((n): n is string => n !== undefined);
}

describe('`align --help` (ALI-951)', () => {
  it('is at most 14 lines', async () => {
    const help = await helpOutput(['--help']);
    const lines = help.replace(/\n+$/, '').split('\n');
    expect(lines.length, help).toBeLessThanOrEqual(14);
  });

  it('lists exactly align, ask, connect, check, mcp - in that order', async () => {
    const help = await helpOutput(['--help']);
    expect(listedEntries(help)).toEqual(['align', 'ask', 'connect', 'check', 'mcp']);
  });

  it('hides import from --help, and the doc (the pinned full reference) still carries it', async () => {
    const help = await helpOutput(['--help']);
    expect(help).not.toMatch(/^\s+import\b/m);
    // Positive control, in the same test: absence from --help means hidden, not deleted.
    expect(COMMANDS_DOC).toMatch(/^align import\b/m);
    expect(COMMANDS_DOC).toMatch(/^align decisions list\b/m);
  });

  it('names the full reference so a hidden command is one step away', async () => {
    expect(await helpOutput(['--help'])).toContain('docs/commands.md');
  });
});

describe('every registered command still parses and runs, hidden or not', () => {
  const names = COMMAND_REGISTRY.flatMap((e) => e.names);

  it('the registry is the real command set (positive control for the per-command cases)', () => {
    expect(names.length).toBeGreaterThanOrEqual(24);
    expect(visibleEntries().map((e) => e.names).flat()).toEqual(['ask', 'connect', 'check', 'mcp']);
  });

  it.each(names)('`align %s --help` parses and prints that command\'s own usage', async (name) => {
    const help = await helpOutput([name, '--help']);
    expect(help).toMatch(new RegExp(`^Usage: align ${name}\\b`, 'm'));
  });

  it('every command the tree registers is claimed by exactly one registry entry (a new command must choose a tier)', () => {
    const program = buildProgram({ internal: true, exitOverride: true, output: { writeOut() {}, writeErr() {} } });
    const registered = program.commands.map((c) => c.name()).filter((n) => n !== 'help');
    expect(registered.length).toBeGreaterThanOrEqual(24);
    const claimed = COMMAND_REGISTRY.flatMap((e) => e.names);
    const unclaimed = registered.filter((n) => !claimed.includes(n));
    expect(unclaimed, `registered but not in COMMAND_REGISTRY: ${unclaimed.join(', ')}`).toEqual([]);
    const missing = claimed.filter((n) => !registered.includes(n));
    expect(missing, `in COMMAND_REGISTRY but never registered: ${missing.join(', ')}`).toEqual([]);
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});
