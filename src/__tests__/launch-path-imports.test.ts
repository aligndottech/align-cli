import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The structural half of the launch cost line: bare `align` reaching a coding agent must not
 * drag in setup, the embedding model, the SQLite graph or the gateway client. Wall-clock is
 * too noisy to gate in CI, so the checkable half is the STATIC import graph from the entry
 * of the default action. `await import(...)` is deliberately not followed: that is how the
 * card path loads them after the launch decision has been made.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAVY = ['commands/setup.ts', 'lib/local-embeddings.ts', 'lib/local-db.ts', 'lib/gateway-client.ts'];

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;

function staticImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(STATIC_IMPORT)) {
    const spec = m[1] ?? m[2];
    if (spec && spec.startsWith('.') && spec.endsWith('.js')) out.push(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
  }
  return out;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...staticImports(f));
  }
  return seen;
}

describe('the launch path imports', () => {
  const graph = reachable(path.join(SRC, 'commands/default-action.ts'));
  const rel = [...graph].map((f) => path.relative(SRC, f));

  it('positive control: the walk sees the launcher and its real dependencies', () => {
    expect(rel).toContain('lib/launch/launch.ts');
    expect(rel).toContain('lib/launch/run-agent.ts');
    expect(rel).toContain('lib/config.ts');
    expect(rel).toContain('lib/agent-rules.ts');
  });
  it('positive control: the walk would catch a heavy import (it follows a known static edge)', () => {
    // commands/setup.ts statically imports gateway-client; walking from it must find it.
    expect([...reachable(path.join(SRC, 'commands/setup.ts'))].map((f) => path.relative(SRC, f))).toContain('lib/gateway-client.ts');
  });
  it.each(HEAVY)('does not reach %s', (heavy) => {
    expect(rel).not.toContain(heavy);
  });
  it('the launcher itself never names fetch or the gateway', () => {
    for (const f of rel.filter((r) => r.startsWith('lib/launch/'))) {
      expect(readFileSync(path.join(SRC, f), 'utf8'), f).not.toMatch(/\bfetch\(|gateway-client/);
    }
  });
});
