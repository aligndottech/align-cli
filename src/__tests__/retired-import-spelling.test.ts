import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * ALI-951: `align import` exits 2 since 0.40.0, so no LIVE string may still instruct it.
 *
 * The retirement shipped the stub and renamed the docs and left sixteen strings the running
 * CLI still printed: every connector's intro banner (`commandIntro('align import git')`), the
 * post-scan follow-ups ("Run `align import list` to check progress"), and three credential
 * errors. So a user who completed `align connect --all` was sent to a command that exits 2.
 *
 * This reads STRING LITERALS off the TypeScript AST rather than grepping the file. Comments
 * are excluded by construction, which matters in both directions: a comment recording the old
 * spelling is history and correct, and a live template literal cannot hide from a sweep that
 * never had to guess where a comment ends.
 *
 * What it does NOT cover, because the AST cannot see it: a label built at runtime from a
 * variable, and anything in `docs/` (commands-doc.test.ts holds that page).
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The only live string allowed to say `align import` is the one announcing its removal.
 * A content predicate rather than a file allowlist on purpose: an allowlist entry's reason
 * is free text and rots, and this one is re-checked on every run.
 */
const RETIREMENT_NOTICE = /was removed in 0\.40\.0/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...tsFilesUnder(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every string-ish literal in one file. A template with substitutions is taken whole
 * (`getText()`), not as its head/middle/tail chunks, so the retirement notice stays one
 * string that carries both halves of its own sentence - splitting it would hide the
 * "removed in 0.40.0" half from the predicate above.
 */
function stringsOf(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      found.push(node.getText());
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

describe('no live string still instructs the retired `align import` (ALI-951)', () => {
  const files = tsFilesUnder(SRC);
  const said = files.flatMap((file) =>
    stringsOf(file).map((text) => ({ file: path.relative(SRC, file), text })),
  );
  const namesImport = said.filter((s) => s.text.includes('align import'));

  it('parsed the tree and can see a string it must not flag (the positive control)', () => {
    // Without this, a broken walk returns nothing, the sweep below finds no offenders, and
    // the green means "I could not look" rather than "there is nothing to find".
    expect(files.length).toBeGreaterThan(50);
    expect(said.length).toBeGreaterThan(500);
    const notices = namesImport.filter((s) => RETIREMENT_NOTICE.test(s.text));
    expect(notices.map((n) => n.file)).toEqual(['commands/import.ts']);
  });

  it('prints no instruction that still says `align import`', () => {
    const offenders = namesImport
      .filter((s) => !RETIREMENT_NOTICE.test(s.text))
      .map((s) => `${s.file}: ${s.text.slice(0, 90)}`)
      .sort();
    expect(offenders).toEqual([]);
  });
});
