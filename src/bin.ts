#!/usr/bin/env node
import { nodeFloorMessage } from './lib/node-floor.js';

// ESM links every static import before running any code, and the CLI's graph reaches node:sqlite,
// which an older Node does not have. So the floor is checked here, and the CLI loads after it.
const tooOld = nodeFloorMessage(process.versions.node);
if (tooOld) {
  console.error(tooOld);
  process.exit(1);
}
await import('./index.js');
