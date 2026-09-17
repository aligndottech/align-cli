/**
 * ALI-951: docs/commands.md is generated from the command registry (`npm run docs:commands`),
 * with the hidden commands in their own section, and this test fails when the doc and the
 * registry disagree - so a command cannot be added, renamed or re-tiered without the page
 * following. The generated region sits between two markers; prose outside them is hand-written.
 *
 * README's "Everyday commands" block is pinned to the same five for the same reason.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../commands/default-action.js', () => ({ runDefaultAction: vi.fn() }));

import { buildProgram } from '../cli.js';
import { COMMANDS_DOC_END, COMMANDS_DOC_START, generatedRegion, renderCommandsReference } from '../lib/commands-doc.js';
import { COMMAND_REGISTRY } from '../commands/registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Read a committed text file with LF line endings, whatever the checkout did to it.
 *
 * This test compares a COMMITTED file against RENDERER output. The renderer emits `\n`; git on
 * Windows checks the file out as `\r\n` because `core.autocrlf` is the default there and this
 * repo had no `.gitattributes`. So both assertions below failed on `windows-latest` only, and
 * for a reason with nothing to do with their subject: the region comparison diffed identical
 * text, and the README regex's `\n+` could not match `\r\n` so it returned null and reported
 * "README has no Everyday commands code block".
 *
 * A `.gitattributes` pinning `eol=lf` now fixes the checkout, and this normalises anyway -
 * because a test that depends on the runner's git config has not established its own
 * precondition (tdd.md), and the next contributor's `core.autocrlf` is not ours to assume.
 */
function readLf(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

const DOC = readLf('docs', 'commands.md');
const README = readLf('README.md');

function program() {
  return buildProgram({ internal: false, exitOverride: true, output: { writeOut() {}, writeErr() {} } });
}

describe('docs/commands.md is generated from the registry', () => {
  it('the committed generated region equals what the renderer produces now (run `npm run docs:commands`)', () => {
    const committed = generatedRegion(DOC);
    expect(committed, `docs/commands.md has no ${COMMANDS_DOC_START} .. ${COMMANDS_DOC_END} region`).not.toBeNull();
    expect(committed).toBe(renderCommandsReference(program()));
  });

  it('visible commands sit under "Everyday" and every hidden one under "Everything else"', () => {
    const text = renderCommandsReference(program());
    const everyday = text.indexOf('## Everyday');
    const rest = text.indexOf('## Everything else');
    expect(everyday).toBeGreaterThanOrEqual(0);
    expect(rest).toBeGreaterThan(everyday);
    for (const entry of COMMAND_REGISTRY) {
      if (entry.internal) continue;
      for (const name of entry.names) {
        const at = text.indexOf(`\nalign ${name}`);
        expect(at, `align ${name} is not in the reference`).toBeGreaterThanOrEqual(0);
        if (entry.visible) expect(at, `align ${name} should be under Everyday`).toBeLessThan(rest);
        else expect(at, `align ${name} should be under Everything else`).toBeGreaterThan(rest);
      }
    }
  });

  it('lists subcommands and flags, so the reference is the whole surface (positive control: import\'s tree)', () => {
    const text = renderCommandsReference(program());
    expect(text).toMatch(/^align connect jira\b/m);
    expect(text).toMatch(/^align decisions list\b/m);
    expect(text).toContain('--json');
    expect(text).toMatch(/^align import\b.*alias/m);
  });
});

describe('README "Everyday commands"', () => {
  it('names exactly the five, and points at docs/commands.md for the rest', () => {
    const section = /## Everyday commands\n+```bash\n([\s\S]*?)```/.exec(README);
    expect(section, 'README has no "## Everyday commands" code block').not.toBeNull();
    const verbs = section![1]!.split('\n').map((l) => /^align(?:\s+([a-z]+))?/.exec(l)).filter(Boolean).map((m) => m![1] ?? 'align');
    expect([...new Set(verbs)]).toEqual(['align', 'ask', 'connect', 'check', 'mcp']);
    const after = README.slice(README.indexOf('## Everyday commands'), README.indexOf('## Everyday commands') + 1500);
    expect(after).toContain('docs/commands.md');
  });
});

describe('a CRLF checkout must not fail these assertions (windows-latest, cli 0.39.0)', () => {
  // The two tests above failed on `windows-latest` ONLY, twice on main, right after the 0.39.0
  // release. Nothing was wrong with the docs: git checked them out CRLF and the renderer emits
  // LF, so the region comparison diffed identical text and the README regex returned null.
  //
  // This reproduces that condition on any OS, because a fix verified only by a green Windows
  // run is a fix nobody can check locally - and the runner's git config is not a precondition
  // this suite ever established for itself (tdd.md).
  const toCrlf = (s: string) => s.replace(/\n/g, '\r\n');
  const readLfFrom = (s: string) => s.replace(/\r\n/g, '\n');

  it('the generated-region comparison survives CRLF once normalised', () => {
    const crlfDoc = toCrlf(DOC);

    // Negative control FIRST: without normalisation this is the exact failure CI reported.
    expect(generatedRegion(crlfDoc)).not.toBe(renderCommandsReference(program()));

    // And with it, the assertion the test actually means.
    expect(generatedRegion(readLfFrom(crlfDoc))).toBe(renderCommandsReference(program()));
  });

  it("the README regex matches CRLF once normalised, and demonstrably does not before", () => {
    const pattern = /## Everyday commands\n+```bash\n([\s\S]*?)```/;
    const crlfReadme = toCrlf(README);

    // The negative control is the whole point: this is why CI said "README has no Everyday
    // commands code block" about a README that plainly has one.
    expect(pattern.exec(crlfReadme)).toBeNull();

    expect(pattern.exec(readLfFrom(crlfReadme))).not.toBeNull();
  });

  it('normalising is idempotent, so an LF checkout is unaffected', () => {
    // The other side. A fix that only works on CRLF input would break every non-Windows run.
    expect(readLfFrom(DOC)).toBe(DOC);
    expect(readLfFrom(README)).toBe(README);
  });
});
