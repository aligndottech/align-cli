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
const DOC = readFileSync(join(ROOT, 'docs', 'commands.md'), 'utf8');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

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
