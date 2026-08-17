/**
 * ALI-196: the DoD asks for a proof that WRITES, preserving hand-written content.
 *
 * `decisions-context.test.ts` pins the pure renderers. This pins the part that touches a real
 * filesystem, because "their bytes survive" is a claim about disk, and a string function
 * returning the right value proves nothing about what a writer actually does to a file.
 *
 * Everything runs against a temp dir. Nothing here reaches a gateway.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ALIGN_CONTEXT_PATH, ALIGN_IMPORT_LINE, writeDecisionsContext } from '../lib/decisions-context.js';

const DECISIONS = [
  { title: 'Use Postgres 16 for new services', cite: 'align-stack#1441' },
  { title: 'Synchronous gRPC for service calls', cite: 'align-stack#1200' },
];

const HAND_WRITTEN = `# My project

Hand-tuned guidance nobody else may touch.

## Conventions
- tabs, not spaces
`;

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ali196-'));
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

describe('ALI-196 writing to a real repo', () => {
  it('creates the owned file, including its directory', async () => {
    // .align/ does not exist yet, which is the normal first run.
    await writeDecisionsContext(repo, DECISIONS);

    expect(fs.existsSync(path.join(repo, ALIGN_CONTEXT_PATH))).toBe(true);
    expect(read(ALIGN_CONTEXT_PATH)).toContain('Use Postgres 16 for new services');
  });

  it('PRESERVES every hand-written byte of CLAUDE.md', async () => {
    // The whole constraint, asserted against disk rather than against a return value.
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), HAND_WRITTEN);

    await writeDecisionsContext(repo, DECISIONS);

    const after = read('CLAUDE.md');
    expect(after.startsWith(HAND_WRITTEN)).toBe(true);
    expect(after).toContain(ALIGN_IMPORT_LINE);
  });

  it('IS IDEMPOTENT on disk: a second run changes nothing', async () => {
    // The acceptance test for the feature, at the layer that actually ships. A file that
    // differs between runs turns every regeneration into a git diff in someone else's repo.
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), HAND_WRITTEN);

    await writeDecisionsContext(repo, DECISIONS);
    const firstContext = read(ALIGN_CONTEXT_PATH);
    const firstClaude = read('CLAUDE.md');

    await writeDecisionsContext(repo, DECISIONS);

    expect(read(ALIGN_CONTEXT_PATH)).toBe(firstContext);
    expect(read('CLAUDE.md')).toBe(firstClaude);
  });

  it('does NOT create CLAUDE.md when the repo has none', async () => {
    // Creating one would be inventing a file the user never had, which is a different and
    // worse surprise than the one the constraint is about. The caller prints the import line
    // instead, the way `align setup` treats MCP config.
    await writeDecisionsContext(repo, DECISIONS);

    expect(fs.existsSync(path.join(repo, 'CLAUDE.md'))).toBe(false);
    // Positive control: the run did happen, so the assertion above is not satisfied by
    // writeDecisionsContext having silently done nothing at all.
    expect(fs.existsSync(path.join(repo, ALIGN_CONTEXT_PATH))).toBe(true);
  });

  it('rethrows a real read failure instead of treating it as "no CLAUDE.md"', async () => {
    // Injecting `swallow every error` reddened NOTHING, so this branch was a living mutant.
    // It matters: ENOENT means the repo has no CLAUDE.md and is expected, while EACCES or
    // EISDIR mean we could not read one that exists. Collapsing those into a silent success
    // would report "context written" while their import line was never added.
    fs.mkdirSync(path.join(repo, 'CLAUDE.md'));   // a DIRECTORY, so readFile fails EISDIR

    await expect(writeDecisionsContext(repo, DECISIONS)).rejects.toThrow();
  });

  it('reports what it touched, so a caller can tell the user', async () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), HAND_WRITTEN);

    const first = await writeDecisionsContext(repo, DECISIONS);
    const second = await writeDecisionsContext(repo, DECISIONS);

    expect(first.importAdded).toBe(true);
    // Second run must not claim to have edited their file again.
    expect(second.importAdded).toBe(false);
    expect(second.contextPath).toBe(ALIGN_CONTEXT_PATH);
  });
});
