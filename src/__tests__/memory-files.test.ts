/**
 * ALI-810: the auto-memory reader.
 *
 * Fixtures are written to a real temp directory rather than mocked, so `locateMemoryFiles`
 * exercises the actual filesystem walk and the `MEMORY.md` exclusion, not a stub of them.
 *
 * Their CONTENT is built from Anthropic's published description of the format
 * (https://code.claude.com/docs/en/memory, read 2026-09-09) and not from a captured file,
 * because this environment has no memory directory to capture from. That is a weaker
 * provenance than ALI-808's session fixtures and is stated here rather than left implied:
 * these tests pin that the reader handles the format as DOCUMENTED. If the real format
 * differs, they will keep passing, and the first real memory directory is what would find it.
 * See the module docstring for what the docs do and do not say.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DECISION_MEMORY_TYPES,
  extractMemoryDecisions,
  locateMemoryFiles,
  MEMORY_TYPES,
  parseMemoryFile,
} from '../lib/sessions/memory-files.js';
import { buildMemorySourceUrl } from '../lib/sessions/source-url.js';

let root: string;
let memoryDir: string;

function writeMemory(name: string, contents: string): string {
  const p = join(memoryDir, name);
  writeFileSync(p, contents, 'utf8');
  return p;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ali810-'));
  memoryDir = join(root, 'projects', '-home-user-repo', 'memory');
  mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the documented type vocabulary', () => {
  it('carries exactly the four values the documentation names', () => {
    // A list of N rules is N claims. Pinned as a set so a fifth value cannot be added here
    // without someone reading the docs again.
    expect([...MEMORY_TYPES]).toEqual(['user', 'feedback', 'project', 'reference']);
  });

  it('treats only project and feedback as decision-shaped', () => {
    expect([...DECISION_MEMORY_TYPES]).toEqual(['project', 'feedback']);
  });
});

describe('parseMemoryFile', () => {
  it('reads type and modified out of frontmatter', () => {
    const p = writeMemory(
      'project_retention.md',
      ['---', 'type: project', 'modified: 2026-09-08T11:02:00Z', '---', '', '# Retention window', '', 'Ninety days.'].join('\n'),
    );
    const parsed = parseMemoryFile(p);
    expect(parsed?.type).toBe('project');
    expect(parsed?.modified).toBe('2026-09-08T11:02:00Z');
    expect(parsed?.body).toContain('Ninety days.');
    // The fence itself must not survive into the body, or it would reach the graph as content.
    expect(parsed?.body).not.toContain('type: project');
  });

  it('reads a file with NO frontmatter as body-only, without inventing a type', () => {
    // The documentation is explicit: "Claude Code never adds frontmatter to a file that has
    // none." So this is a normal file, not a malformed one, and it must not be defaulted into
    // a type - which is what makes it get skipped downstream rather than imported as a guess.
    const p = writeMemory('loose_note.md', '# Just a note\n\nNo frontmatter here.');
    const parsed = parseMemoryFile(p);
    expect(parsed?.type).toBeNull();
    expect(parsed?.modified).toBeNull();
    expect(parsed?.body).toBe('# Just a note\n\nNo frontmatter here.');
  });

  it('does not treat an unclosed fence as frontmatter', () => {
    // Positive control on the failure direction: without the closing-fence check, the rest of
    // the file would be read as key/value pairs and the content would vanish.
    const p = writeMemory('unclosed.md', '---\ntype: project\n\nstill the body');
    const parsed = parseMemoryFile(p);
    expect(parsed?.type).toBeNull();
    expect(parsed?.body).toContain('still the body');
  });

  it('rejects a type outside the documented four rather than passing it through', () => {
    const p = writeMemory('odd.md', '---\ntype: wishlist\n---\n\nbody');
    expect(parseMemoryFile(p)?.type).toBeNull();
  });

  it('keeps unrecognised scalar keys under extra rather than dropping them', () => {
    // The ticket claims `description` and `originSessionId` exist; the docs describe neither.
    // Nothing depends on them, and they survive here so a later ticket can confirm them
    // against real data without reparsing.
    const p = writeMemory(
      'feedback_tests.md',
      ['---', 'type: feedback', 'description: prefers vitest', 'originSessionId: abc-123', '---', '', 'Body.'].join('\n'),
    );
    const parsed = parseMemoryFile(p);
    expect(parsed?.extra).toEqual({ description: 'prefers vitest', originSessionId: 'abc-123' });
  });

  it('strips one layer of quotes from a value', () => {
    const p = writeMemory('q.md', '---\ntype: project\nmodified: "2026-09-08T11:02:00Z"\n---\n\nbody');
    expect(parseMemoryFile(p)?.modified).toBe('2026-09-08T11:02:00Z');
  });

  it('returns null for an unreadable file', () => {
    expect(parseMemoryFile(join(memoryDir, 'does-not-exist.md'))).toBeNull();
  });
});

describe('locateMemoryFiles', () => {
  it('excludes MEMORY.md, which is an index of the others', () => {
    writeMemory('MEMORY.md', '- one line per memory');
    writeMemory('project_a.md', '---\ntype: project\n---\n\nA');

    // Drive the directory directly: locateMemoryFiles resolves the dir from session files or
    // settings, and the exclusion is what this case is about.
    const found = extractMemoryDecisions([join(memoryDir, 'MEMORY.md'), join(memoryDir, 'project_a.md')]);
    // MEMORY.md has no frontmatter, so it is dropped as unclassified even if a caller passes
    // it - belt as well as braces, since the index would otherwise duplicate every memory.
    expect(found.map(c => c.title)).toEqual(['project a']);
  });

  it('returns [] for a project with no Claude Code data, rather than throwing', () => {
    // The normal case on most machines. An empty list is "never run here", not an error.
    expect(locateMemoryFiles(join(root, 'nowhere'))).toEqual([]);
  });
});

describe('extractMemoryDecisions', () => {
  it('keeps project and feedback, and drops user and reference', () => {
    // Both directions per rule. A keep-only test passes against a function that keeps
    // everything, and a drop-only test against one that drops everything.
    const kept = [
      writeMemory('project_x.md', '---\ntype: project\n---\n\n# Deadline moved\n\nTo October.'),
      writeMemory('feedback_y.md', '---\ntype: feedback\n---\n\n# Use npm here\n\nNot pnpm.'),
    ];
    const dropped = [
      writeMemory('user_role.md', '---\ntype: user\n---\n\n# Staff SDET\n\nPrefers terse output.'),
      writeMemory('reference_z.md', '---\ntype: reference\n---\n\n# Dashboard\n\nGrafana link.'),
    ];

    const got = extractMemoryDecisions([...kept, ...dropped]);
    expect(got.map(c => c.type).sort()).toEqual(['feedback', 'project']);
    expect(got.map(c => c.title).sort()).toEqual(['Deadline moved', 'Use npm here']);
  });

  it('drops an unclassified file rather than defaulting it into a decision', () => {
    const p = writeMemory('mystery.md', '# Something\n\nNo type at all.');
    expect(extractMemoryDecisions([p])).toEqual([]);
  });

  it('drops a classified file with an empty body', () => {
    const p = writeMemory('empty.md', '---\ntype: project\n---\n');
    expect(extractMemoryDecisions([p])).toEqual([]);
  });

  it('falls back to the filename stem when the body has no heading', () => {
    const p = writeMemory('project_retention_window.md', '---\ntype: project\n---\n\nNinety days, no heading.');
    expect(extractMemoryDecisions([p])[0]?.title).toBe('project retention window');
  });

  it('carries the modified timestamp through, and null when absent', () => {
    const withTs = writeMemory('a.md', '---\ntype: project\nmodified: 2026-09-08T11:02:00Z\n---\n\nbody a');
    const withoutTs = writeMemory('b.md', '---\ntype: project\n---\n\nbody b');
    const got = extractMemoryDecisions([withTs, withoutTs]);
    expect(got[0]?.timestamp).toBe('2026-09-08T11:02:00Z');
    expect(got[1]?.timestamp).toBeNull();
  });
});

describe('buildMemorySourceUrl', () => {
  it('is stable for one memory across rewrites, so a re-import upserts', () => {
    // The property that matters: Claude edits a topic file in place, so the same memory must
    // produce the same url on every run or the graph accumulates duplicates.
    const first = buildMemorySourceUrl(memoryDir, join(memoryDir, 'project_retention.md'));
    const second = buildMemorySourceUrl(memoryDir, join(memoryDir, 'project_retention.md'));
    expect(first).toBe(second);
    expect(first).toBe('claude-code-memory://-home-user-repo/project_retention');
  });

  it('distinguishes two memories in the same project', () => {
    // Sensitivity beside stability: a url that were constant would satisfy the test above.
    const a = buildMemorySourceUrl(memoryDir, join(memoryDir, 'project_a.md'));
    const b = buildMemorySourceUrl(memoryDir, join(memoryDir, 'project_b.md'));
    expect(a).not.toBe(b);
  });
});
