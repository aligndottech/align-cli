/**
 * ALI-1668: a LOCAL graph's decisions file must never be representable in the git working
 * tree at all - not even gitignored, which is a convention anyone can bypass (edit the line,
 * `git add -f`, a merge that drops it). `writeDecisionsContext(repo, decisions, { external: true })`
 * writes the real content to `~/.align/contexts/<hash>/decisions.md` (same home-directory
 * convention as the saved tokens and the local graph DB itself) and leaves a symlink at
 * `.align/decisions.md` pointing at it, so every existing reader (the CLAUDE.md import,
 * `align context inject`, the gitignore/tracked-by-git checks in context.ts) keeps working
 * unchanged - they all resolve the relative path through the symlink transparently.
 *
 * Symlinks need POSIX semantics Windows does not give an unprivileged process, so on win32
 * this falls back to the plain in-repo file (today's behaviour) - best effort, same shape as
 * every other platform-dependent hardening in private-files.ts.
 *
 * Test List:
 * 1. POSIX: .align/decisions.md is a SYMLINK, not a real file
 * 2. POSIX: the symlink resolves outside the repo, under the isolated home's .align/contexts/
 * 3. POSIX: reading .align/decisions.md through the normal fs API returns the real content
 *    (so the CLAUDE.md-import / inject / gitignore machinery needs no changes)
 * 4. POSIX: the external file is 0600 (owner-only), matching every other file under ~/.align
 * 5. two different repos get two different external paths; the same repo, run twice, reuses one
 * 6. a PRE-EXISTING real .align/decisions.md (migration case) is replaced by the symlink
 * 7. win32: falls back to a plain in-repo file, unchanged from the non-external path
 * 8. default (no `external` option, or `external: false`): unchanged plain in-repo file,
 *    covering every caller in decisions-context-write.test.ts that predates this option
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ALIGN_CONTEXT_PATH, externalContextPath, writeDecisionsContext } from '../lib/decisions-context.js';

const DECISIONS = [{ title: 'Use Postgres 16 for new services', cite: 'align-stack#1441' }];
const posix = process.platform !== 'win32';

let repo: string;
let repo2: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ali1652-'));
  repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ali1652-'));
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(repo2, { recursive: true, force: true });
});

const localPath = (r: string) => path.join(r, ALIGN_CONTEXT_PATH);

describe.skipIf(!posix)('writeDecisionsContext({ external: true }) on POSIX', () => {
  it('leaves a SYMLINK at .align/decisions.md, not a real file', async () => {
    await writeDecisionsContext(repo, DECISIONS, { external: true });
    const stat = fs.lstatSync(localPath(repo));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('the symlink resolves to the per-repo path under ~/.align/contexts/', async () => {
    await writeDecisionsContext(repo, DECISIONS, { external: true });
    const linkTarget = fs.readlinkSync(localPath(repo));
    expect(path.resolve(path.dirname(localPath(repo)), linkTarget)).toBe(externalContextPath(repo));
    expect(externalContextPath(repo)).toContain(path.join('.align', 'contexts'));
  });

  it('reading the in-repo path returns the real content, transparently', async () => {
    await writeDecisionsContext(repo, DECISIONS, { external: true });
    expect(fs.readFileSync(localPath(repo), 'utf8')).toContain('Use Postgres 16 for new services');
  });

  it('the external file is owner-only (0600)', async () => {
    await writeDecisionsContext(repo, DECISIONS, { external: true });
    const mode = fs.statSync(externalContextPath(repo)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('two repos get two different external paths; one repo run twice reuses the same path', async () => {
    await writeDecisionsContext(repo, DECISIONS, { external: true });
    await writeDecisionsContext(repo2, DECISIONS, { external: true });
    expect(externalContextPath(repo)).not.toBe(externalContextPath(repo2));

    const first = fs.readlinkSync(localPath(repo));
    await writeDecisionsContext(repo, DECISIONS, { external: true });
    expect(fs.readlinkSync(localPath(repo))).toBe(first);
  });

  it('replaces a pre-existing REAL file at .align/decisions.md (the migration case)', async () => {
    fs.mkdirSync(path.join(repo, '.align'), { recursive: true });
    fs.writeFileSync(localPath(repo), 'stale committed content');

    await writeDecisionsContext(repo, DECISIONS, { external: true });

    expect(fs.lstatSync(localPath(repo)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(localPath(repo), 'utf8')).toContain('Use Postgres 16 for new services');
  });
});

describe.skipIf(posix)('writeDecisionsContext({ external: true }) on win32', () => {
  it('falls back to a plain in-repo file - no symlink support to rely on', async () => {
    await writeDecisionsContext(repo, DECISIONS, { external: true });
    expect(fs.lstatSync(localPath(repo)).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(localPath(repo), 'utf8')).toContain('Use Postgres 16 for new services');
  });
});

describe('writeDecisionsContext without the external option', () => {
  it('is unchanged: a plain in-repo file, never a symlink', async () => {
    await writeDecisionsContext(repo, DECISIONS);
    expect(fs.lstatSync(localPath(repo)).isSymbolicLink()).toBe(false);
  });

  it('{ external: false } is the same as omitting the option', async () => {
    await writeDecisionsContext(repo, DECISIONS, { external: false });
    expect(fs.lstatSync(localPath(repo)).isSymbolicLink()).toBe(false);
  });
});
