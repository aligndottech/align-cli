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
export interface StoredCoChangeRule { ruleId: string; repo: string | null; decisionId: string; title: string; summary: string; url?: string; rule: CoChangeRule }

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

type Token =
  | { kind: 'lit'; ch: string }
  | { kind: 'one' }            // ?   one non-slash character
  | { kind: 'star' }           // *   any run of non-slash characters
  | { kind: 'globstar' }       // **  any run of characters, slashes included
  | { kind: 'dirs' };          // **/ zero or more whole directories

const tokenCache = new Map<string, Token[]>();

/** `*` and `?` stay inside one path segment; `**` crosses segments; a trailing `/` means everything under it. */
function tokenise(glob: string): Token[] {
  const cached = tokenCache.get(glob);
  if (cached) return cached;
  let g = normalise(glob);
  if (g.endsWith('/')) g += '**';
  const tokens: Token[] = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { tokens.push({ kind: 'dirs' }); i += 2; } else { tokens.push({ kind: 'globstar' }); i += 1; }
    } else if (c === '*') tokens.push({ kind: 'star' });
    else if (c === '?') tokens.push({ kind: 'one' });
    else tokens.push({ kind: 'lit', ch: c });
  }
  tokenCache.set(glob, tokens);
  return tokens;
}

/**
 * Not a RegExp on purpose. `**a**a**a...**b` compiled to `.*a.*a.*a...b` backtracks exponentially
 * (68s measured at eight repeats against sixty characters), and a rule is data a person or another
 * lane wrote. This walks the tokens once, keeping the set of path positions still reachable, so the
 * cost is tokens x path length whatever the glob looks like.
 */
export function pathMatches(glob: string, path: string): boolean {
  const p = normalise(path);
  const n = p.length;
  let cur = new Uint8Array(n + 1);
  cur[0] = 1;
  for (const t of tokenise(glob)) {
    const next = new Uint8Array(n + 1);
    if (t.kind === 'lit') {
      for (let j = 0; j < n; j++) if (cur[j] && p[j] === t.ch) next[j + 1] = 1;
    } else if (t.kind === 'one') {
      for (let j = 0; j < n; j++) if (cur[j] && p[j] !== '/') next[j + 1] = 1;
    } else if (t.kind === 'star') {
      for (let j = 0; j <= n; j++) next[j] = cur[j] || (j > 0 && next[j - 1] && p[j - 1] !== '/') ? 1 : 0;
    } else if (t.kind === 'globstar') {
      for (let j = 0; j <= n; j++) next[j] = cur[j] || (j > 0 && next[j - 1]) ? 1 : 0;
    } else {
      // zero directories, or any run of characters that ends in a slash
      let seen = false; // some cur[k] with k <= j - 1
      for (let j = 0; j <= n; j++) {
        if (j > 0 && cur[j - 1]) seen = true;
        next[j] = cur[j] || (j > 0 && p[j - 1] === '/' && seen) ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur[n] === 1;
}

/** Syntax from fuller glob dialects. The matcher would treat each as a literal character, so the rule would never trigger or never be met. */
const UNSUPPORTED_GLOB = /[{}[\]!\\]/;

function pathList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${field} must be a non-empty list of paths or globs`);
  for (const p of raw) {
    if (typeof p !== 'string' || p.trim() === '') throw new Error(`${field} must contain only non-blank strings`);
    const bad = UNSUPPORTED_GLOB.exec(p);
    if (bad) throw new Error(`${field}: "${p}" uses ${bad[0] === '\\' ? 'a backslash' : `"${bad[0]}"`}, which is not supported. Only *, ** and ? are: no {a,b} lists, [abc] classes, ! negation or escapes. Write one path per alternative.`);
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
