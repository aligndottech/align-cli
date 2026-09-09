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
 * The other side is read from its committed origin/main, never its working tree, so the
 * number this test reports names its own provenance. The sibling checkout is assumed at
 * ../align-stack (override with ALIGN_STACK_DIR); the ref can be overridden with
 * ALIGN_MCP_PARITY_REF, which is how the negative control is run against a branch before
 * it merges. CI has no sibling checkout, so there it skips - LOUDLY, below - and the
 * parity is a local gate plus the same test on the align-stack side.
 */
const HERE = 'src/lib/mcp-instructions.shared.ts';
const THERE = 'connectors/mcp-align/src/mcpInstructions.shared.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sibling = process.env['ALIGN_STACK_DIR'] ?? resolve(root, '..', 'align-stack');
const ref = process.env['ALIGN_MCP_PARITY_REF'] ?? 'origin/main';

function siblingCopy(): { ok: true; text: string } | { ok: false; why: string } {
  if (!existsSync(join(sibling, '.git'))) {
    return { ok: false, why: `no align-stack checkout at ${sibling} (set ALIGN_STACK_DIR)` };
  }
  try {
    const text = execFileSync('git', ['-C', sibling, 'show', `${ref}:${THERE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, text };
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
    const mine = readFileSync(join(root, HERE), 'utf8');
    // Positive controls: both sides were actually read, so two empty strings cannot pass.
    expect(mine.length).toBeGreaterThan(500);
    expect(mine).toContain('{check_alignment}');
    expect((other as { text: string }).text.length).toBeGreaterThan(500);
    expect(mine).toBe((other as { text: string }).text);
  });
});
