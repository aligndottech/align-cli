import { readdir } from 'node:fs/promises';
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

/** Headings under which a README section can be a rule. CONTRIBUTING needs none: all of it is process. */
const CONVENTION_HEADING =
  /changelog|contribut|convention|guideline|\brules?\b|policy|versioning|release process|commit|pull request|branch|review|style|deprecat|workflow|standards?/i;

/** Headings a changelog uses for policy rather than history. */
const CHANGELOG_POLICY_HEADING = /versioning|convention|policy|deprecat|contribut|guideline|\brules?\b|how to/i;

/** `[1.2.0] - 2026-01-01`, `2026-07-07`, `v2`, `Unreleased`: a release entry, never a rule. */
const RELEASE_HEADING = /^\[?v?\d+(?:\.\d+)|^\[?unreleased\b|\d{4}-\d{2}(?:-\d{2})?/i;

export type DocKind = 'readme' | 'contributing' | 'changelog';

export function isRuleSection(kind: DocKind, heading: string, body: string): boolean {
  // A changelog policy section is a rule by its heading: a versioning policy is often written
  // as plain description ("breaking changes create a new dated version") with no "must" in it.
  if (kind === 'changelog') return !RELEASE_HEADING.test(heading.trim()) && CHANGELOG_POLICY_HEADING.test(heading);
  if (!RULE_MARKER.test(body)) return false;
  return kind === 'contributing' || CONVENTION_HEADING.test(heading);
}

const SAME_PR = /\bsame (?:PR|pull request)\b/i;
const CHANGELOG_PATH = /[\w./-]*changelog[\w.-]*\.md/i;
const BACKTICKED_DIR = /`((?:[\w.-]+\/)+)(?:\*\*)?`/g;
const SPEC_DIRS = ['openapi', 'api', 'spec', 'specs', 'swagger'];

/**
 * The structured form of "add an entry to <changelog> in the same PR", when the text says
 * both halves. `require_paths` is the changelog the text names. `when_paths` is a directory
 * the text names in backticks, else the repo's spec directory when the rule is about "the API"
 * - and when neither is clear there is NO rule: an empty trigger would demand the file on
 * every PR, which the text never asked for. The prose decision is still imported.
 */
export async function inferCoChangeRule(body: string, repoRoot: string): Promise<CoChangeRule | undefined> {
  if (!SAME_PR.test(body)) return undefined;
  const required = body.match(CHANGELOG_PATH)?.[0];
  if (!required) return undefined;

  const named = [...body.matchAll(BACKTICKED_DIR)].map((m) => `${m[1]}**`);
  let when = [...new Set(named)];
  if (when.length === 0 && /\bAPI\b/.test(body)) {
    const dirs = await readdir(repoRoot, { withFileTypes: true }).catch(() => []);
    const present = new Set(dirs.filter((d) => d.isDirectory()).map((d) => d.name));
    const spec = SPEC_DIRS.find((d) => present.has(d));
    if (spec) when = [`${spec}/**`];
  }
  if (when.length === 0) return undefined;
  return { when_paths: when, require_paths: [path.posix.normalize(required)], scope: 'same_pr' };
}
