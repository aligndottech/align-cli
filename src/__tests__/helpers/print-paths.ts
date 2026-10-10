// Prints where THE PRODUCT keeps its local graph, its config and its private state, as JSON, from whatever
// environment this process is started in. Test fixtures call it in a child with the exact env the CLI child
// will get, so they seed where the CLI looks on every platform (macOS puts these under ~/Library, not XDG_*).
import { alignStateDir } from '../../lib/backfill-state.js';
import { getLocalDbPath } from '../../lib/local-mode.js';
import { createConfigStore } from '../../lib/config.js';
import path from 'node:path';

const dbPath = getLocalDbPath();
const store = createConfigStore() as unknown as { path?: string };
console.log(JSON.stringify({ dbPath, configDir: path.dirname(dbPath), stateDir: alignStateDir(), configFile: store.path ?? null }));
