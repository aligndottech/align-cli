import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The structural half of the launch cost line. Wall-clock is too noisy to gate in CI, so the
 * checkable half is the STATIC import graph. `await import(...)` is deliberately not
 * followed: that is how the card path loads its heavy modules after the launch decision.
 *
 * WHAT THIS PROVES, stated narrowly because an earlier version claimed more:
 *  1. From default-action.ts (the launch decision itself): setup, local-embeddings, local-db
 *     and gateway-client are not statically reachable, so the launch decision never adds them.
 *  2. From index.ts (what really runs): the embedding model (`@huggingface/transformers`) and
 *     its WASM backend are reachable only through dynamic import, so no launch ever pays for them.
 * WHAT IT DOES NOT PROVE: that the process loads nothing heavy before the launch decision.
 * index.ts -> cli.ts -> registry.ts statically imports every command, including setup.ts and
 * local-db.ts, so `node:sqlite` and gateway-client ARE loaded at startup (see the last test).
 * That cost is already inside the ~150 ms `align --version` baseline; removing it is a
 * registry-laziness refactor, out of scope for C1.
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

function externalImports(files: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(STATIC_IMPORT)) {
      const spec = m[1] ?? m[2];
      if (spec && !spec.startsWith('.')) out.add(spec);
    }
  }
  return out;
}

/** Repo-relative with forward slashes on every OS, so the assertions below name files one way. */
const relSrc = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');

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

describe('the launch decision imports (from default-action.ts)', () => {
  const graph = reachable(path.join(SRC, 'commands/default-action.ts'));
  const rel = [...graph].map((f) => relSrc(f));

  it('positive control: the walk sees the launcher and its real dependencies', () => {
    expect(rel).toContain('lib/launch/launch.ts');
    expect(rel).toContain('lib/launch/run-agent.ts');
    expect(rel).toContain('lib/config.ts');
    expect(rel).toContain('lib/agent-rules.ts');
  });
  it('positive control: the walk would catch a heavy import (it follows a known static edge)', () => {
    // commands/setup.ts statically imports gateway-client; walking from it must find it.
    expect([...reachable(path.join(SRC, 'commands/setup.ts'))].map((f) => relSrc(f))).toContain('lib/gateway-client.ts');
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

describe('what the process loads at startup (from index.ts)', () => {
  const graph = reachable(path.join(SRC, 'index.ts'));
  const rel = [...graph].map((f) => relSrc(f));
  const external = externalImports(graph);

  it('positive control: the walk reaches the registry and sees node: and package imports', () => {
    expect(rel).toContain('commands/registry.ts');
    expect(rel).toContain('lib/launch/launch.ts');
    expect(external.has('commander')).toBe(true);
  });
  it('the embedding model and its WASM backend are never statically reachable', () => {
    expect(external.has('@huggingface/transformers')).toBe(false);
    expect(rel).not.toContain('lib/local-embeddings-wasm.ts');
  });
  it('control for the line above: the same walk DOES find the embedding module that loads the model lazily', () => {
    // local-embeddings.ts is reachable (registry -> setup -> ...), but names the package only
    // inside a dynamic import, which is why the assertion above holds.
    expect(rel).toContain('lib/local-embeddings.ts');
    expect(readFileSync(path.join(SRC, 'lib/local-embeddings.ts'), 'utf8')).toMatch(/await import\(HF_TRANSFORMERS\)/);
  });
  it('KNOWN GAP, pinned so it cannot change silently: node:sqlite is loaded eagerly via the registry', () => {
    expect(external.has('node:sqlite')).toBe(true);
    // When the registry becomes lazy this flips; replace it with `.toBe(false)` then.
  });
});
