// ALI-1774: on Node 20, `align --version` died with a raw ERR_UNKNOWN_BUILTIN_MODULE for
// node:sqlite, so the user never learned the cause was the Node version. ESM links every static
// import before running any code, so the check has to live in an entry file that statically
// imports nothing which reaches node:sqlite, and loads the real CLI with a dynamic import.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nodeFloorMessage } from '../lib/node-floor.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

describe('nodeFloorMessage', () => {
  it('is null on the floor itself and above it', () => {
    expect(nodeFloorMessage('22.16.0')).toBeNull();
    expect(nodeFloorMessage('24.20.0')).toBeNull();
  });

  it('names the version in use, the floor, and a way out, below the floor', () => {
    for (const v of ['20.19.0', '22.15.9', '18.0.0']) {
      const msg = nodeFloorMessage(v);
      expect(msg).toContain(`Node ${v}`);
      expect(msg).toContain('22.16');
      expect(msg).toContain('https://nodejs.org');
      expect(msg).toContain('curl -fsSL https://align.tech/install.sh | sh');
    }
  });

  it('refuses a version string it cannot parse rather than letting it through', () => {
    expect(nodeFloorMessage('banana')).not.toBeNull();
  });
});

describe('the npm entry point', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { bin: Record<string, string> };

  it('is a file that runs the floor check before it loads the CLI', () => {
    expect(pkg.bin['align']).toBe('./dist/bin.js');
    const src = readFileSync(resolve(root, 'src', 'bin.ts'), 'utf8');
    const staticImports = src.split('\n').filter((l) => /^import\s/.test(l));
    // The only static import allowed is the pure floor check.
    // ...plus the warning filter, which has to be installed before the CLI (and node:sqlite) loads.
    expect(staticImports).toEqual([
      "import { nodeFloorMessage } from './lib/node-floor.js';",
      "import { installSqliteWarningFilter } from './lib/suppress-sqlite-warning.js';",
    ]);
    expect(src.indexOf('installSqliteWarningFilter(process)')).toBeLessThan(src.indexOf("await import('./index.js')"));
    expect(src).toContain("await import('./index.js')");
    expect(src.indexOf('nodeFloorMessage(')).toBeLessThan(src.indexOf("await import('./index.js')"));
  });

  it('node-floor.ts reaches no module that imports node:sqlite', () => {
    const src = readFileSync(resolve(root, 'src', 'lib', 'node-floor.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^import\s/.test(l));
    expect(imports).toEqual(["import { MIN_NODE, nodeMeetsFloor } from './doctor.js';"]);
    const doctor = readFileSync(resolve(root, 'src', 'lib', 'doctor.ts'), 'utf8');
    expect(doctor.split('\n').filter((l) => /^import\s/.test(l))).toEqual(["import type { EnvironmentConfig } from './config.js';"]);
  });
});
