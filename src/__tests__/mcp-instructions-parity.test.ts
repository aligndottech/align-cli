import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ALI-952: the MCP server instructions are ONE text in two repositories - this one
 * (src/lib/mcp-instructions.shared.ts) and align-stack
 * (connectors/mcp-align/src/mcpInstructions.shared.ts). Two writers of one fact is the
 * defect this file exists to stop (align-stack .claude/rules/code-style.md), and the two
 * texts had already drifted once before this test existed.
 *
 * BOTH sides are read from git, never a working tree: this repo's copy from HEAD, the
 * other's from its origin/main. Committed bytes on both sides make the comparison symmetric
 * (the same answer whichever repo you run it from) and immune to a checkout's line-ending
 * conversion - readFileSync on an autocrlf checkout sees \r\n where git show emits \n
 * (Copilot, align-stack#2230) - and the result names its own provenance. The cross-repo
 * comparison is over committed bytes; a separate control below fails on an uncommitted
 * local edit, naming it as such rather than as drift from the other repo. The sibling checkout is assumed at
 * ../align-stack (override with ALIGN_STACK_DIR); its ref can be overridden with
 * ALIGN_MCP_PARITY_REF, which is how the negative control is run against a branch before
 * it merges. CI has no sibling checkout, so there it skips - LOUDLY, below - and the
 * parity is a local gate plus the same test on the align-stack side.
 */
const HERE = 'src/lib/mcp-instructions.shared.ts';
const THERE = 'connectors/mcp-align/src/mcpInstructions.shared.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sibling = process.env['ALIGN_STACK_DIR'] ?? resolve(root, '..', 'align-stack');
const ref = process.env['ALIGN_MCP_PARITY_REF'] ?? 'origin/main';

// Belt to the braces above: git show already emits LF, so this only matters if a future
// edit reads a working tree again. Normalising both sides keeps the comparison about text.
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

function committed(repo: string, at: string, file: string): string {
  return lf(execFileSync('git', ['-C', repo, 'show', `${at}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

function siblingCopy(): { ok: true; text: string } | { ok: false; why: string } {
  if (!existsSync(join(sibling, '.git'))) {
    return { ok: false, why: `no align-stack checkout at ${sibling} (set ALIGN_STACK_DIR)` };
  }
  try {
    return { ok: true, text: committed(sibling, ref, THERE) };
  } catch (err) {
    return { ok: false, why: `${THERE} is not on ${ref} of ${sibling} - has the align-stack side merged? (${(err as Error).message.split('\n')[0]})` };
  }
}

const other = siblingCopy();
if (!other.ok) {
  // Loud on purpose: a skipped parity test that says nothing is indistinguishable from one
  // that passed, and this is the only gate on the two copies agreeing.
  console.warn(`\n[mcp-instructions-parity] SKIPPED: ${other.why}\n`);
}

describe.skipIf(!other.ok)('the shared MCP instructions are byte-identical to align-stack\'s copy', () => {
  it(`matches ${THERE} on ${ref}`, () => {
    const mine = committed(root, 'HEAD', HERE);
    // Positive controls: both sides were actually read, so two empty strings cannot pass -
    // and HEAD's copy is the file on disk, so a stale HEAD cannot pass for the working tree.
    expect(mine.length).toBeGreaterThan(500);
    expect(mine).toBe(lf(readFileSync(join(root, HERE), 'utf8')));
    expect(mine).toContain('{check_alignment}');
    expect((other as { text: string }).text.length).toBeGreaterThan(500);
    expect(mine).toBe((other as { text: string }).text);
  });
});
