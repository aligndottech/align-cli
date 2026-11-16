#!/usr/bin/env node
// Rewrites the exact @aligndottech/cli@X.Y.Z pins in the Claude Code plugin (plugins/align) to
// the version in package.json. The plugin directory requires an exact npx pin, and release-please
// cannot edit a version embedded in a JSON string. Run it after a release is promoted to latest
// (docs/RELEASING.md), never on the release PR: an exact pin would bypass the next-then-latest gate.
// `--check` exits 1 instead of writing. Parity is also asserted by src/__tests__/claude-plugin.test.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(root + 'package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version "${version}" is not X.Y.Z`);
const files = ['plugins/align/.claude-plugin/plugin.json', 'plugins/align/hooks/hooks.json'];
const check = process.argv.includes('--check');
let stale = 0;
for (const rel of files) {
  const before = readFileSync(root + rel, 'utf8');
  const pins = before.match(/@aligndottech\/cli@[^"\s]+/g) ?? [];
  if (pins.length === 0) throw new Error(`${rel}: no @aligndottech/cli@ pin found`);
  const after = before.replace(/@aligndottech\/cli@[^"\s]+/g, `@aligndottech/cli@${version}`);
  if (after === before) continue;
  stale++;
  if (!check) writeFileSync(root + rel, after);
  console.log(`${check ? 'stale' : 'updated'}: ${rel}`);
}
if (check && stale) process.exit(1);
