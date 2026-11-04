/**
 * Co-change rules: "a change that touches X must also touch Y, in the same PR".
 *
 * This is a question about WHICH FILES a change touches, so it has one right answer and is computed
 * from the changed-file list, never judged. The LLM check cannot do it: it reads a slice of the diff,
 * and a file a PR forgot to touch is not in a diff at all.
 *
 * The rule shape is shared with the import lane (README rules) and the hosted gateway. Do not rename
 * its fields.
 */
export type CoChangeScope = 'same_pr';

export interface CoChangeRule {
  /** Globs. The rule applies when the change touches any of them. */
  when_paths: string[];
  /** Globs. The rule is met when the change touches any of them. */
  require_paths: string[];
  scope: CoChangeScope;
}

/** A rule with the decision it belongs to, as the local graph returns it. */
export interface StoredCoChangeRule { decisionId: string; title: string; summary: string; url?: string; rule: CoChangeRule }

export interface CoChangeViolation {
  decisionId: string;
  title: string;
  summary: string;
  url?: string;
  /** The changed files that matched a when path. */
  triggeredBy: string[];
  /** The require globs, none of which matched a changed file. */
  missing: string[];
}

function normalise(p: string): string {
  return p.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

const globCache = new Map<string, RegExp>();

/** `*` and `?` stay inside one path segment; `**` crosses segments; a trailing `/` means everything under it. */
function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let g = normalise(glob);
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(glob, compiled);
  return compiled;
}

export function pathMatches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(normalise(path));
}

function pathList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${field} must be a non-empty list of paths or globs`);
  for (const p of raw) {
    if (typeof p !== 'string' || p.trim() === '') throw new Error(`${field} must contain only non-blank strings`);
  }
  return raw as string[];
}

/**
 * Validates a rule from outside (a flag, a stored row, another lane's writer). An empty list is
 * refused rather than stored: empty require_paths could never be met, so the rule would flag every
 * matching PR forever, and empty when_paths could never trigger.
 */
export function parseCoChangeRule(raw: unknown): CoChangeRule {
  if (typeof raw !== 'object' || raw === null) throw new Error('A co-change rule must be an object');
  const r = raw as Record<string, unknown>;
  if (r['scope'] !== 'same_pr') throw new Error("scope must be 'same_pr'");
  return { when_paths: pathList(r['when_paths'], 'when_paths'), require_paths: pathList(r['require_paths'], 'require_paths'), scope: 'same_pr' };
}

/** Every rule the change violates: it touches a when path and touches none of the require paths. */
export function evaluateCoChange(rules: StoredCoChangeRule[], changed: string[]): CoChangeViolation[] {
  const violations: CoChangeViolation[] = [];
  for (const { decisionId, title, summary, url, rule } of rules) {
    const triggeredBy = changed.filter((f) => rule.when_paths.some((g) => pathMatches(g, f)));
    if (triggeredBy.length === 0) continue;
    if (changed.some((f) => rule.require_paths.some((g) => pathMatches(g, f)))) continue;
    violations.push({ decisionId, title, summary, ...(url ? { url } : {}), triggeredBy, missing: [...rule.require_paths] });
  }
  return violations;
}
