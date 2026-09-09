/**
 * Regenerates the command reference in docs/commands.md from the registry (ALI-951).
 * `npm run docs:commands`. commands-doc.test.ts fails when the committed region is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildProgram } from '../src/cli.js';
import { renderCommandsReference, withGeneratedRegion } from '../src/lib/commands-doc.js';

const doc = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'commands.md');
const program = buildProgram({ internal: false, exitOverride: true, output: { writeOut() {}, writeErr() {} } });
const before = readFileSync(doc, 'utf8');
const after = withGeneratedRegion(before, renderCommandsReference(program));
writeFileSync(doc, after);
console.log(after === before ? 'docs/commands.md: unchanged' : 'docs/commands.md: regenerated');
