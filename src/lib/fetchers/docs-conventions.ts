import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CoChangeRule } from '../co-change-rule.js';

/**
 * Where a repo writes its working rules when it has no ADRs and no CLAUDE.md. Measured on
 * recart/openapi: the rule "every notable API change adds an entry to docs/changelog.md in the
 * same PR" lived in README.md, and the versioning policy in the changelog's own Versioning
 * section, so `connect docs` imported nothing.
 *
 * Only rule-bearing SECTIONS are taken. A README is mostly install and usage steps, and a
 * changelog is mostly release entries ("what changed in 1.2.0"), which are history and not
 * decisions about how to work. Both are left out.
 */

export const README_FILES = ['README.md'];
export const CONTRIBUTING_FILES = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'];
export const CHANGELOG_FILES = ['CHANGELOG.md', 'docs/changelog.md', 'docs/CHANGELOG.md', 'changelog.md'];

/** A line that states an obligation or prohibition. */
const RULE_MARKER = /\b(?:must(?: not)?|never|always|every|do not|don't|required?|ensure|make sure|should)\b/i;

/** Headings under which a README section can be a rule. CONTRIBUTING needs no heading, but still needs a RULE_MARKER line. */
const CONVENTION_HEADING =
  /changelog|contribut|convention|guideline|\brules?\b|policy|versioning|release process|commit|pull request|branch|review|style|deprecat|workflow|development|process|branching|how to|standards?/i;

/** Headings a changelog uses for policy rather than history. */
const CHANGELOG_POLICY_HEADING = /versioning|convention|policy|deprecat|contribut|guideline|\brules?\b|how to/i;

/** Keep a Changelog's category headings: entries of one release, never policy. */
const CHANGELOG_CATEGORY = /^(?:added|changed|deprecated|removed|fixed|security)$/i;

/** `[1.2.0] - 2026-01-01`, `2026-07-07`, `v2`, `Unreleased`: a release entry, never a rule. */
const RELEASE_HEADING = /^\[?v?\d+(?:\.\d+)|^\[?unreleased\b|\d{4}-\d{2}(?:-\d{2})?/i;

export type DocKind = 'readme' | 'contributing' | 'changelog';

/** A changelog that uses `# 1.2.0` as a release heading puts the whole release inside the
 *  previous section's text: cut the body where the next top-level heading starts. */
export function sectionBody(kind: DocKind, body: string): string {
  return kind === 'changelog' ? body.split(/\n(?=#\s)/)[0].trim() : body;
}

export function isRuleSection(kind: DocKind, heading: string, body: string): boolean {
  // A changelog policy section is a rule by its heading: a versioning policy is often written
  // as plain description ("breaking changes create a new dated version") with no "must" in it.
  if (kind === 'changelog') {
    const h = heading.trim();
    return !RELEASE_HEADING.test(h) && !CHANGELOG_CATEGORY.test(h) && CHANGELOG_POLICY_HEADING.test(h);
  }
  if (!RULE_MARKER.test(body)) return false;
  return kind === 'contributing' || CONVENTION_HEADING.test(heading);
}

const SAME_PR = /\bsame (?:PR|pull request)\b/i;
const CHANGELOG_PATH = /[\w./-]*changelog[\w.-]*\.md/i;
const BACKTICKED_DIR = /`((?:[\w.-]+\/)+)(?:\*\*)?`/g;
/** Not `spec`/`specs`: in most repos that is rspec or a test dir, not an API description. */
const SPEC_DIRS = ['openapi', 'api', 'swagger'];

/** A sentence, or a list item, so "same PR" and a directory can be required to sit together. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
}

/** Does this directory hold an OpenAPI/Swagger description: a yaml/yml/json file named for one, or
 *  whose top-level key is `openapi:` / `swagger:` (read from the first 4 KB). */
async function holdsApiSpec(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile() || !/\.(?:ya?ml|json)$/i.test(e.name)) continue;
    if (/openapi|swagger/i.test(e.name)) return true;
    const head = (await readFile(path.join(dir, e.name), 'utf8').catch(() => '')).slice(0, 4096);
    if (/^["']?(?:openapi|swagger)["']?\s*:/m.test(head)) return true;
  }
  return false;
}

/**
 * The structured form of "add an entry to <changelog> in the same PR", when the text says
 * both halves. `require_paths` is the changelog the text names. `when_paths` is a directory
 * named in backticks in the SAME sentence as the "same PR" clause, else - when the rule is
 * about "the API" - the repo's top-level openapi/api/swagger directory that actually holds a
 * spec file. When neither is clear there is NO rule: an empty or guessed trigger would demand
 * the file on PRs the text never mentioned. The prose decision is still imported.
 */
export async function inferCoChangeRule(body: string, repoRoot: string): Promise<CoChangeRule | undefined> {
  const clause = sentences(body).filter((s) => SAME_PR.test(s));
  if (clause.length === 0) return undefined;
  const required = clause.join(' ').match(CHANGELOG_PATH)?.[0] ?? body.match(CHANGELOG_PATH)?.[0];
  if (!required) return undefined;

  const named = clause.flatMap((s) => [...s.matchAll(BACKTICKED_DIR)].map((m) => `${m[1]}**`));
  let when = [...new Set(named)];
  if (when.length === 0 && /\bAPI\b/.test(body)) {
    for (const d of SPEC_DIRS) {
      if (await holdsApiSpec(path.join(repoRoot, d))) { when = [`${d}/**`]; break; }
    }
  }
  if (when.length === 0) return undefined;
  return { when_paths: when, require_paths: [path.posix.normalize(required)], scope: 'same_pr' };
}
