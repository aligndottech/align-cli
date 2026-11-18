/**
 * `align adr` command: a person accepts each ADR at a terminal; without one, nothing is written.
 * 6. not at a terminal: it lists the candidates and writes nothing
 * 7. at a terminal: yes to the first, no to the second, writes exactly one file
 * 8. only decision-shaped rows are proposed (a fix commit is not)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAdr } from '../commands/adr.js';

let repo: string;
beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'align-adr-cmd-')); });
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

const rows = [
  { id: '1', title: 'Encode TRUE as FF- instead of 01-', platform: 'git', summary: 'Because FF- is what the runtime already emits.', source_url: 'https://github.com/o/r/commit/bbb2222', created_at: '2026-11-02T00:00:00Z' },
  { id: '2', title: 'Switch to a hand-written parser instead of ANTLR', platform: 'git', summary: '', source_url: 'https://github.com/o/r/commit/ccc3333', created_at: '2026-11-03T00:00:00Z' },
  { id: '3', title: 'fix: typo in README', platform: 'git', summary: '', source_url: 'https://github.com/o/r/commit/ddd4444', created_at: '2026-11-04T00:00:00Z' },
] as never[];

const adrFiles = () => { try { return fs.readdirSync(path.join(repo, 'docs/adr')); } catch { return []; } };

describe('runAdr', () => {
  it('lists the candidates and writes nothing when no one is at a terminal', async () => {
    const out: string[] = [];
    const written = await runAdr(rows, repo, { interactive: false, write: true, today: '2026-11-18', ask: async () => { throw new Error('must not ask'); }, out: (l) => out.push(l) });
    expect(written).toEqual([]);
    expect(adrFiles()).toEqual([]);
    expect(out.join('\n')).toContain('Encode TRUE as FF- instead of 01-');
    expect(out.join('\n')).toContain('Switch to a hand-written parser instead of ANTLR');
    expect(out.join('\n')).not.toContain('typo in README');
  });

  it('writes only what the person accepts', async () => {
    const answers = ['y', 'n'];
    const written = await runAdr(rows, repo, { interactive: true, write: true, today: '2026-11-18', ask: async () => answers.shift() ?? 'q', out: () => {} });
    expect(written).toEqual(['docs/adr/0001-encode-true-as-ff-instead-of-01.md']);
    expect(adrFiles()).toEqual(['0001-encode-true-as-ff-instead-of-01.md']);
    expect(fs.readFileSync(path.join(repo, written[0]), 'utf8')).toContain('Because FF- is what the runtime already emits.');
  });

  it('writes nothing without the write subcommand, even at a terminal', async () => {
    const written = await runAdr(rows, repo, { interactive: true, write: false, today: '2026-11-18', ask: async () => 'y', out: () => {} });
    expect(written).toEqual([]);
    expect(adrFiles()).toEqual([]);
  });
});
