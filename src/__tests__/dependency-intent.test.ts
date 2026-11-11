import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dependencyIntentQuery } from '../lib/agent/dependency-intent.js';

/**
 * Retrieval embeds the raw new text, and JSON or an import line scores far under the relates
 * threshold against a rule like "No new dependencies without review". A sentence about the same
 * change does not. The query is built deterministically from what the edit adds to an npm
 * manifest or imports, with no model call and no new threshold.
 */
let dir: string;
const manifest = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'shop', description: 'A small shop', dependencies: { zod: '^3.23.0' }, devDependencies: { vitest: '^3.0.0' }, ...extra }, null, 2);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'align-dep-intent-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'package.json'), manifest());
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const pkg = (): string => join(dir, 'package.json');

describe('dependencyIntentQuery', () => {
  it('(1) adding a dependency key to package.json names the dependency and the manifest', () => {
    const q = dependencyIntentQuery({ file_path: pkg(), old_string: '"zod": "^3.23.0"', new_string: '"zod": "^3.23.0",\n    "lodash": "^4.17.21"' }, dir);
    expect(q).toBe('Add dependency lodash to package.json');
  });

  it('(1b) a Write of a manifest with a new devDependency counts too', () => {
    const q = dependencyIntentQuery({ file_path: pkg(), content: manifest({ devDependencies: { vitest: '^3.0.0', prettier: '^3.0.0' } }) }, dir);
    expect(q).toBe('Add dependency prettier to package.json');
  });

  it('(2) a Write that imports a package missing from package.json names it', () => {
    const q = dependencyIntentQuery({ file_path: join(dir, 'src', 'util.ts'), content: 'import _ from "lodash";\nexport const u = _.uniq;\n' }, dir);
    expect(q).toBe('Add dependency lodash to package.json');
  });

  it('(2b) require, dynamic import and a scoped package name are all seen', () => {
    const q = dependencyIntentQuery({ file_path: join(dir, 'src', 'a.js'), content: "const a = require('left-pad/lib');\nconst b = await import('@scope/pkg/sub');\n" }, dir);
    expect(q).toBe('Add dependency left-pad, @scope/pkg to package.json');
  });

  it('(3) importing a package already in the manifest, a relative path or a node builtin stays silent', () => {
    const content = 'import { z } from "zod";\nimport { it } from "vitest";\nimport x from "./x.js";\nimport fs from "node:fs";\nimport p from "path";\n';
    expect(dependencyIntentQuery({ file_path: join(dir, 'src', 'a.ts'), content }, dir)).toBeNull();
  });

  it('(3b) an alias such as $lib or ~/ is not a package', () => {
    expect(dependencyIntentQuery({ file_path: join(dir, 'src', 'a.ts'), content: 'import a from "$lib/a";\nimport b from "~/b";\nimport c from "@/c";\n' }, dir)).toBeNull();
  });

  it('(3c) a baseUrl import of a project folder such as src/foo or components/x is not a package', () => {
    mkdirSync(join(dir, 'components'));
    const content = 'import a from "src/foo";\nimport b from "components/x";\n';
    expect(dependencyIntentQuery({ file_path: join(dir, 'src', 'a.ts'), content }, dir)).toBeNull();
  });

  it('(3d) a dependency listed in a workspace root manifest above the package is not new', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'], dependencies: { lodash: '^4.17.21' } }));
    mkdirSync(join(dir, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@acme/app', dependencies: { zod: '^3.23.0' } }));
    const content = 'import _ from "lodash";\nimport { z } from "zod";\n';
    expect(dependencyIntentQuery({ file_path: join(dir, 'packages', 'app', 'src', 'a.ts'), content }, dir)).toBeNull();
  });

  it('(3e) a sibling workspace package is not new', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
    mkdirSync(join(dir, 'packages', 'app', 'src'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@acme/app' }));
    writeFileSync(join(dir, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@acme/core' }));
    const content = 'import { c } from "@acme/core";\n';
    expect(dependencyIntentQuery({ file_path: join(dir, 'packages', 'app', 'src', 'a.ts'), content }, dir)).toBeNull();
  });

  it('(3f) a type-only import is not a runtime dependency, a value import of the same file is', () => {
    expect(dependencyIntentQuery({ file_path: join(dir, 'src', 'a.ts'), content: 'import type { X } from "lodash";\n' }, dir)).toBeNull();
    expect(dependencyIntentQuery({ file_path: join(dir, 'src', 'a.ts'), content: 'import { X } from "lodash";\n' }, dir)).toBe('Add dependency lodash to package.json');
  });

  it('(4) a description-only edit of package.json stays silent', () => {
    const q = dependencyIntentQuery({ file_path: pkg(), old_string: '"description": "A small shop"', new_string: '"description": "A tiny shop for testing"' }, dir);
    expect(q).toBeNull();
  });

  it('(5) a version bump of an existing dependency stays silent', () => {
    const q = dependencyIntentQuery({ file_path: pkg(), old_string: '"zod": "^3.23.0"', new_string: '"zod": "^3.24.0"' }, dir);
    expect(q).toBeNull();
  });

  it('an Edit that leaves an import already in the file alone stays silent', () => {
    writeFileSync(join(dir, 'src', 'old.ts'), 'import _ from "lodash";\nconst a = 1;\n');
    const q = dependencyIntentQuery({ file_path: join(dir, 'src', 'old.ts'), old_string: 'const a = 1;', new_string: 'const a = 2;' }, dir);
    expect(q).toBeNull();
  });

  it('the file already carries the edit (a post-edit hook): the new dependency is still found', () => {
    writeFileSync(pkg(), manifest({ dependencies: { zod: '^3.23.0', lodash: '^4.17.21' } }));
    const q = dependencyIntentQuery({ file_path: pkg(), old_string: '"zod": "^3.23.0"', new_string: '"zod": "^3.23.0",\n    "lodash": "^4.17.21"' }, dir);
    expect(q).toBe('Add dependency lodash to package.json');
  });

  it('no package.json above the file means no query', () => {
    const lone = mkdtempSync(join(tmpdir(), 'align-dep-lone-'));
    try {
      expect(dependencyIntentQuery({ file_path: join(lone, 'a.ts'), content: 'import _ from "lodash";' }, lone)).toBeNull();
    } finally { rmSync(lone, { recursive: true, force: true }); }
  });

  it('a file that is neither a manifest nor source stays silent', () => {
    expect(dependencyIntentQuery({ file_path: join(dir, 'README.md'), content: 'import _ from "lodash"' }, dir)).toBeNull();
  });

  it('an unparseable manifest edit fails open to no query', () => {
    expect(dependencyIntentQuery({ file_path: pkg(), content: '{ "dependencies": { ' }, dir)).toBeNull();
  });
});
