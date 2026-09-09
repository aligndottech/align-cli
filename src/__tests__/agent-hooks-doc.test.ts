import { describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every host detectEditors() knows must have a row in the per-host table, so nobody has to
// infer what a host can do from whether a file got written (the doc's own opening claim).
// existsSync is forced true so detection returns every host regardless of this machine.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: vi.fn().mockReturnValue(true),
}));

import { detectEditors } from '../lib/mcp-setup.js';

const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'agent-hooks.md'), 'utf8');
// A table row starts with a bold host name: `| **Claude Code** | ...`.
const rows = doc.split('\n').filter((l) => /^\|\s*\*\*/.test(l));

describe('docs/agent-hooks.md has a row for every host detectEditors() knows', () => {
  const hosts = detectEditors().map((e) => e.name);

  it('detection returned the whole list (positive control for the loop below)', () => {
    expect(hosts.length).toBeGreaterThanOrEqual(9);
    expect(rows.length).toBeGreaterThanOrEqual(hosts.length);
  });

  it.each(detectEditors().map((e) => [e.name]))('%s', (name) => {
    expect(rows.some((r) => r.includes(name)), `no row for ${name}`).toBe(true);
  });

  // One host per row. A row like "Windsurf, Zed, VS Code" satisfies includes() three times
  // over while saying nothing specific about any of them.
  it('gives each host its own row', () => {
    for (const name of hosts) {
      const own = rows.filter((r) => r.includes(name));
      expect(own.some((r) => /^\|\s*\*\*[^*]*\*\*\s*\|/.test(r) && !r.split('|')[1]!.includes(',')), `${name} shares a row`).toBe(true);
    }
  });
});
