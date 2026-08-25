/**
 * ALI-675: every import entry point resolves its env through resolveImportEnv,
 * the chokepoint that redirects a no-account user to the local graph.
 *
 * Why a parity gate over source rather than 14 behavioural tests: the defect
 * was never the resolver - it was 14 call sites each free to call the bare
 * form, which is the ALI-422 collision surface again (13 sites, one missing
 * flag each). One chokepoint plus a gate that every site uses it is the
 * code-style.md "fix the shared choke point" rule, made enforceable. The
 * resolver's own behaviour is pinned in resolve-env.test.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = path.join(HERE, '..', 'commands', 'import');
const IMPORT_TS = path.join(HERE, '..', 'commands', 'import.ts');

function importSources(): Array<{ name: string; text: string }> {
  const files = fs
    .readdirSync(IMPORT_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: `import/${f}`, text: fs.readFileSync(path.join(IMPORT_DIR, f), 'utf8') }));
  files.push({ name: 'import.ts', text: fs.readFileSync(IMPORT_TS, 'utf8') });
  return files;
}

describe('import env-resolution parity (ALI-675)', () => {
  it('examines the real command set, not an empty directory', () => {
    // Positive control: a moved directory must fail loudly, not pass on [].
    expect(importSources().length).toBeGreaterThanOrEqual(11);
  });

  it('every import entry point uses resolveImportEnv and never the bare resolver', () => {
    const offenders = importSources()
      .filter(({ text }) => /\bresolveEnv\(/.test(text))
      .map(({ name }) => name);
    expect(
      offenders,
      `these files call bare resolveEnv(...), which 401s a no-account local user; ` +
        `use resolveImportEnv (ALI-675): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every file that resolves an env resolves it through the chokepoint', () => {
    // The inverse half: a file that dropped env resolution entirely would pass
    // the test above. Every file that constructs a gateway client must name
    // resolveImportEnv.
    const resolvers = importSources().filter(({ text }) => text.includes('createGatewayClient'));
    expect(resolvers.length).toBeGreaterThanOrEqual(11); // control: the set is real
    const missing = resolvers
      .filter(({ text }) => !text.includes('resolveImportEnv'))
      .map(({ name }) => name);
    expect(
      missing,
      `these files build a client without resolveImportEnv: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
