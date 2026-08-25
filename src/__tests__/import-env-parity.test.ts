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

/**
 * Two populations with OPPOSITE contracts, and the gate pins both:
 *
 * - `import/<tool>.ts` are FETCHER-based: the fetcher runs client-side and the
 *   local client serves ingestBatch, so they take the redirect.
 * - `import.ts` is JOB-based: listImportJobs / listSuggestions / listScanRuns
 *   exist only on the cloud gateway (the local client implements none of
 *   them), so redirecting a no-account user there converts a clean 401 into a
 *   "not a function" crash. It stays on the bare resolver DELIBERATELY
 *   (Copilot, #122).
 */
function fetcherSources(): Array<{ name: string; text: string }> {
  return fs
    .readdirSync(IMPORT_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: `import/${f}`, text: fs.readFileSync(path.join(IMPORT_DIR, f), 'utf8') }));
}

describe('import env-resolution parity (ALI-675)', () => {
  it('examines the real command set, not an empty directory', () => {
    // Positive control: a moved directory must fail loudly, not pass on [].
    expect(fetcherSources().length).toBeGreaterThanOrEqual(10);
  });

  it('every fetcher-based import uses resolveImportEnv and never the bare resolver', () => {
    const offenders = fetcherSources()
      .filter(({ text }) => /\bresolveEnv\(/.test(text))
      .map(({ name }) => name);
    expect(
      offenders,
      `these files call bare resolveEnv(...), which 401s a no-account local user; ` +
        `use resolveImportEnv (ALI-675): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every fetcher file that builds a client resolves through the chokepoint', () => {
    // The inverse half: a file that dropped env resolution entirely would pass
    // the test above.
    const resolvers = fetcherSources().filter(({ text }) => text.includes('createGatewayClient'));
    expect(resolvers.length).toBeGreaterThanOrEqual(10); // control: the set is real
    const missing = resolvers
      .filter(({ text }) => !text.includes('resolveImportEnv'))
      .map(({ name }) => name);
    expect(
      missing,
      `these files build a client without resolveImportEnv: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the jobs-based import.ts stays on the bare resolver - redirecting it trades a 401 for a crash', () => {
    const text = fs.readFileSync(IMPORT_TS, 'utf8');
    // Positive control first: the file really is jobs-based. If these methods
    // ever appear on the local client, this whole exemption should be
    // re-examined rather than silently kept.
    expect(text).toMatch(/listImportJobs|listSuggestions|listScanRuns/);
    expect(
      text.includes('resolveImportEnv'),
      'import.ts adopted resolveImportEnv: its job endpoints do not exist on the local ' +
        'client, so a no-account user gets "not a function" instead of a clean 401. ' +
        'Either implement the job methods locally first, or keep the bare resolver.',
    ).toBe(false);
  });
});
