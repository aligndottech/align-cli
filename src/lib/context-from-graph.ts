/**
 * The session-start hook's fallback when the repo has no `.align/decisions.md`.
 *
 * `align context inject` prints that file at session start, and only `align context sync` writes
 * it, so after a normal setup the hook printed nothing: the agent met the graph only if it chose
 * to call a tool. For a LOCAL graph the same list can be read straight from the SQLite file on
 * this machine. That keeps the two reasons the hook reads a file rather than the gateway: no
 * network call, and fast enough to sit inside a hook. A hosted graph still needs `align context
 * sync`, because reading it is a network call.
 *
 * Fails open on every branch, like every other hook shim: anything it cannot read is null, and
 * null prints nothing. It never creates a graph file that is not already there.
 */
import fs from 'node:fs';
import { createConfigStore } from './config.js';
import { localCitationFor } from './commit-cite.js';
import { navigableSourceUrl } from './decision-links.js';
import { type ContextDecision, renderDecisionsFile } from './decisions-context.js';
import { createLocalGatewayClient } from './local-gateway-client.js';
import { stripLeadingHtmlComments } from './fetchers/strip-leading-comments.js';
import { isDependencyBumpSubject, isRenovateBump, TITLE_CUT_AT } from './commit-shape.js';
import { decidedTime, tidyDecisions } from './decisions-tidy.js';
import { DECISION_SHAPED, MECHANICAL_PREFIX, statedBodyReason, subjectReason, withoutIssuePrefix } from './decision-body.js';
import { extractReason } from './reason-extract.js';
import { resolveEnv } from './resolve-env.js';

/** The fields `align context sync` and this fallback both read off a listed decision. */
export interface ListedDecision {
  title: string;
  platform?: string;
  summary?: string;
  source_url?: string | null;
  decider_kind?: string | null;
  ratified_by?: string | null;
  ratified_at?: string | null;
  decided_at?: string | null;
}

/** One listed decision as the decisions file renders it. Shared with `align context sync`, so the two cannot drift. */
export function contextDecisionOf(d: ListedDecision): ContextDecision {
  const cite = localCitationFor(d.source_url ?? undefined);
  // A hosted decision can carry a synthetic align://claimed/... identity, not a place anyone can open.
  const sourceUrl = navigableSourceUrl(d.source_url ?? undefined);
  return {
    title: d.title,
    ...(cite ? { cite } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    // What the renderer needs to put an unratified agent claim in its own section.
    ...(d.decider_kind ? { deciderKind: d.decider_kind } : {}),
    ...(d.ratified_by ? { ratifiedBy: d.ratified_by } : {}),
    ...(d.ratified_at ? { ratifiedAt: d.ratified_at } : {}),
    ...(d.decided_at ? { decidedAt: d.decided_at } : {}),
  };
}

export interface GraphEnv { mode?: string; localDbPath?: string }

/** The file header's note (decisions-context.ts), and what this list says instead. A test pins that the swap happened. */
const FILE_NOTE = 'Generated from your decision graph. Edits here are overwritten; this file is owned by\n`align`. Re-run the generator to bring it up to date.';
const GRAPH_NOTE = 'Read from your local Align graph when this session started. There is no file to edit;\n`align context sync` writes one you can read.';

function configuredEnv(): GraphEnv | undefined {
  return createConfigStore().getEnvironment(resolveEnv(undefined, { preferLocalEmbedded: true }));
}

/** The rendered decisions for `root`'s repo from the local graph, or null when there is no local graph or nothing in it. */
export async function decisionsFromLocalGraph(root: string, o: { env?: () => GraphEnv | undefined; limit?: number } = {}): Promise<string | null> {
  try {
    const env = (o.env ?? configuredEnv)();
    if (env?.mode !== 'local-embedded' || !env.localDbPath || !fs.existsSync(env.localDbPath)) return null;
    const client = createLocalGatewayClient(env.localDbPath, { cwd: root });
    try {
      // The same query `align context sync` runs: active only, so a superseded decision never reads as current.
      const rows = await client.listDecisions({ limit: LOCAL_SCAN, status: 'active' });
      if (rows.length === 0) return null;
      // The same selection as the file, so the session and the file never disagree.
      const picked = selectForFile(rows, o.limit ?? LOCAL_FILE_CAP);
      if (picked.decisions.length === 0) return null;
      // The rendered header describes a file Align owns. There is no file here, so say where the list came from instead.
      return renderDecisionsFile(picked.decisions, { leftOut: picked.leftOut }).replace(FILE_NOTE, GRAPH_NOTE);
    } finally {
      client.close();
    }
  } catch {
    return null;
  }
}

/** A commit or PR shaped like a fix, a test, a chore or an issue reference: it states a reason, and it is not a decision. */
const FIX_SHAPED = /^(?:fix(?:es|ed)?|bug|hotfix|tests?|ci|style|chore|build|docs?|refactor|perf|revert|bump|deps?)\b|^#\d+|^\w+\([^)]*\):/i;
/** How many active rows a local graph's file is chosen from, and how many it holds by default. */
export const LOCAL_SCAN = 5000;
export const LOCAL_FILE_CAP = 30;

const CODE_PLATFORMS: ReadonlySet<string> = new Set(['git', 'github', 'gitlab']);
const FEAT_PREFIX = /^feat(?:\([^)]*\))?:\s*(?:#\d+\s*)?/i;
/**
 * What a LOCAL graph's decisions file holds: the repo's written rules (docs) first, then commits and pull requests that
 * read as decisions, each with the reason it states, capped at `limit`. A local graph is every commit that states a reason,
 * and in an active repo most of those are fixes (1,317 of 1,817 on objectionary/eo), which is not what an agent should
 * read as "what was decided". A hosted graph is already curated by the model, so this is never applied to it.
 */
/** The non-docs rows that read as decisions: what the decisions file lists and what `align adr` proposes. */
export function decisionShapedRows(rows: ListedDecision[]): ListedDecision[] {
  return rows.filter((r) => r.platform !== 'docs').filter((r) => isDecisionRow(r));
}

/** The old route: the subject itself holds a decision word and is not shaped like a fix. */
function bySubject(r: ListedDecision): boolean {
  const title = r.title.replace(FEAT_PREFIX, '');
  return !isRenovateBump(title) && !FIX_SHAPED.test(title) && DECISION_SHAPED.test(title);
}

/** Only a feat: subject may be kept for a cause alone; any other English "what changed" line needs a stated choice. */
const needsChoice = (title: string): boolean => !FEAT_PREFIX.test(title);

function isDecisionRow(r: ListedDecision): boolean {
  // Chat and ticket importers already choose decision-shaped items; only commits and PRs are every reasoned change.
  if (!CODE_PLATFORMS.has(r.platform ?? '')) return true;
  // A feat: prefix is dropped first, so "feat: fix retry policy" is judged as the fix it is.
  const title = r.title.replace(FEAT_PREFIX, '');
  if (isRenovateBump(title)) return false;
  // A merge is never one, even when its branch name holds a decision word ("Merge branch 'policy'").
  if (/^merge\b/i.test(withoutIssuePrefix(title))) return false;
  if (bySubject(r)) return true;
  // Any other subject (a fix, docs, a scoped or plain "what changed" line) is a decision when its BODY states why. An
  // issue prefix ("#12:", "bug(#12):") is looked past, so a bump or a fix behind one is still a bump or a fix. A bump, a
  // revert and a test/ci/chore commit are never one, whatever the body says, and a fix needs a stated CHOICE.
  const bare = withoutIssuePrefix(title);
  if (isRenovateBump(bare) || MECHANICAL_PREFIX.test(bare) || isDependencyBumpSubject(bare)) return false;
  return statedBodyReason(r.title, r.summary, needsChoice(r.title)) !== null;
}

/** The graph keeps only the first 80 characters of a title, so a long commit subject arrives cut mid-word. Its summary starts with the whole subject. */
const SUBJECT_CAP = 120;
function wholeTitle(title: string, summary: string | undefined): string {
  // Not isCutTitle: that trims, and a title cut right after a space is 80 characters stored and 79 trimmed.
  if (title.length < TITLE_CUT_AT) return title;
  const first = (summary ?? '').split('\n')[0]!.trim();
  const recovered = first.startsWith(title);
  if (recovered && first.length <= SUBJECT_CAP) return first;
  // No whole subject in the summary: a title of exactly 80 characters may have been cut, and nothing here can tell a
  // complete one from a cut one. Keep every word and mark it, rather than guess which word to drop.
  if (!recovered) return title.length === TITLE_CUT_AT ? `${title.trimEnd()}...` : title;
  const cut = first.slice(0, SUBJECT_CAP - 3);
  // A word ending exactly at the limit is whole already.
  const atBoundary = first.length > SUBJECT_CAP - 3 && /\s/.test(first[SUBJECT_CAP - 3]!);
  return `${atBoundary ? cut : cut.replace(/\s*\S*$/, '')}...`.replace(/[\s,;:]+\.\.\.$/, '...');
}

/**
 * A docs row that is one rule of a list (fetchers/docs-rule-list.ts) has the rule as its title, and the graph keeps 80
 * characters of that. Its summary starts with the whole rule, so the file prints the rule and not a stump. Only a
 * rule row is touched: its summary ends with the marker the importer writes, which an ADR or a heading never has.
 */
const RULE_TITLE_CAP = 300;
const RULE_MARKER = /\n\nFrom the ".+" section\.(?: \(further rules, graph only\))?\s*$/;
const OVERFLOW_MARKER = /\n\nFrom the ".+" section\. \(further rules, graph only\)\s*$/;
/** The one row that holds a section's rules past the per-section cap (fetchers/docs.ts). Graph only, never in the file. */
const isOverflowRow = (r: ListedDecision): boolean => r.platform === 'docs' && OVERFLOW_MARKER.test(r.summary ?? '');
export const isRuleRow = (r: ListedDecision): boolean => r.platform === 'docs' && RULE_MARKER.test(r.summary ?? '');
/**
 * An ADR or heading row: the graph kept 80 characters of its heading, which can end mid-word ("OKF is not mar"). The
 * summary starts with the whole heading (after any comment header an older import stored), so it is read back from there.
 * With no whole heading to read, the title is cut back to the last whole word and marked, never left in a half word.
 */
function displayDocTitle(r: ListedDecision): string {
  if (r.title.length < TITLE_CUT_AT) return r.title;
  const heading = stripLeadingHtmlComments(r.summary ?? '').split('\n')[0]!.replace(/^\s*(?:#{1,6}|=)\s+/, '').trim();
  if (heading.startsWith(r.title) && heading.length <= DOC_TITLE_CAP) return heading;
  const base = heading.startsWith(r.title) ? heading.slice(0, DOC_TITLE_CAP - 3) : r.title;
  // A cut that lands exactly on a word end is whole already.
  const wholeAtCut = heading.startsWith(r.title) && /\s/.test(heading[base.length] ?? '');
  return `${(wholeAtCut ? base : base.replace(/\s*\S*$/, '')).replace(/[\s,;:]+$/, '')}...`;
}
const DOC_TITLE_CAP = 160;
function displayRuleTitle(r: ListedDecision): string {
  if (!isRuleRow(r)) return displayDocTitle(r);
  // Emphasis markers are for the source file; the generated file is read as plain text.
  const first = (r.summary ?? '').split('\n')[0]!.replace(/\*\*|__/g, '').trim();
  return first.length > RULE_TITLE_CAP ? `${first.slice(0, RULE_TITLE_CAP).trimEnd()}...` : first;
}

/**
 * A docs row that is a whole `##` section (its url ends in the section anchor) has the HEADING as its title. A heading is
 * not a rule: "Commands" and "Testing" told an agent nothing, and the file listed them under "Rules written in this repo"
 * (#721). The file now prints the heading only with the first line of prose under it ("Testing: Run `npm test` before
 * every push."), and leaves out a section with no prose (a code fence, a list of commands, a table), which stays in the
 * graph for `align ask`. A heading that states a rule ("Never commit secrets") is printed as written. A row without a
 * section anchor (an ADR, a whole file) is not a heading row and is never touched.
 */
// Only a heading that OPENS with an imperative states a rule: "Must-haves" and "Where things should live" do not.
const RULE_HEADING = /^(?:never|always|do not|don't|must not|must|only)(?=\s|$)/i;
const HEADING_ROW_CAP = 200;
const isHeadingRow = (r: ListedDecision): boolean => r.platform === 'docs' && !isRuleRow(r) && /#[^#/~]+$/.test(r.source_url ?? '');
function firstProseLine(title: string, summary: string): string | null {
  let fence: { ch: string; len: number } | null = null;
  let commented = false;
  let first = true;
  for (const raw of summary.replace(/\r\n?/g, '\n').split('\n')) {
    // A fence closes only with the same character at least as long as the one that opened it.
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence) {
      if (f && f[1]![0] === fence.ch && f[1]!.length >= fence.len && f[2]!.trim() === '') fence = null;
      continue;
    }
    if (f) { fence = { ch: f[1]![0]!, len: f[1]!.length }; continue; }
    // A comment that opens on one line and closes on a later one hides everything between.
    if (commented) { if (raw.includes('-->')) commented = false; continue; }
    if (/^\s*<!--/.test(raw)) { if (!raw.includes('-->')) commented = true; continue; }
    // The summary opens with the whole heading, which the stored title may hold only 80 characters of.
    // Only a line that IS the heading is skipped (a body-only summary may open with prose that starts with the same word);
    // a title cut at the graph's 80 characters is a prefix of the whole heading.
    if (first && raw.trim()) {
      first = false;
      const opening = raw.trim().replace(/^(?:#{1,6}|=)\s+/, '');
      if (opening === title || (title.length >= TITLE_CUT_AT && opening.startsWith(title))) continue;
    }
    const text = raw.trim().replace(/^(?:>\s*)+/, '').replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, '').replace(/\*\*|__/g, '').trim();
    // Code, commands, tables, headings, tags and bare links are not text; anything else with a letter or digit is.
    if (!text || text === title || /^[`$#|<[\]!]/.test(text) || /^\s{4}/.test(raw) || !/[\p{L}\p{N}]/u.test(text)) continue;
    return text.length > HEADING_ROW_CAP ? `${text.slice(0, HEADING_ROW_CAP).trimEnd()}...` : text;
  }
  return null;
}
/** The title the file prints for a heading row, or null when the section holds no text. */
function headingRowTitle(r: ListedDecision): { title: string; proof?: string } | null {
  // The same recovery as any docs title (displayDocTitle): comment header, `#` or AsciiDoc `=`, whole word on a cut.
  const heading = displayDocTitle(r);
  const line = firstProseLine(r.title, stripLeadingHtmlComments(r.summary ?? ''));
  if (line) return { title: `${heading}: ${line}`, proof: line };
  return RULE_HEADING.test(heading) ? { title: heading } : null;
}

/** Rule rows may take this share of the file, so commits, PRs and ADRs keep room in a repo with one long rule list. */
const RULE_SHARE_OF_CAP = 2 / 3;

/** Hidden from the file only (never from capture): a subject that names a package with strong evidence. */
const isFileBump = (r: ListedDecision): boolean => CODE_PLATFORMS.has(r.platform ?? '') && isDependencyBumpSubject(r.title.replace(FEAT_PREFIX, ''));

export function selectForFile(rows: ListedDecision[], limit: number): { decisions: ContextDecision[]; leftOut: number; selected: ListedDecision[] } {
  const overflow = rows.filter(isOverflowRow);
  const docs = rows.filter((r) => r.platform === 'docs' && !isOverflowRow(r));
  // A section imported whole by an older version, now imported as one row per rule: the whole-section row would print
  // beside its own rules. Hide it from the file (it stays in the graph). A rule that was REWORDED gets a new row and the
  // old wording stays too: known limit, the importer cannot tell a reword from a new rule.
  // A rule url is `<section anchor>~<rule key>`. A heading slug cannot hold `~`, so the parent is exact: a section named
  // "Core" is not the parent of "Core - x" rules, which a prefix match would have said.
  const parents = new Set(docs.filter(isRuleRow).map((r) => r.source_url ?? '').filter((u) => u.includes('~')).map((u) => u.slice(0, u.lastIndexOf('~'))));
  const stale = docs.filter((r) => !isRuleRow(r) && r.source_url && parents.has(r.source_url));
  const headingTitle = new Map<ListedDecision, { title: string; proof?: string } | null>(docs.filter(isHeadingRow).map((r) => [r, headingRowTitle(r)]));
  const rules = docs.filter((r) => !stale.includes(r) && headingTitle.get(r) !== null);
  // Merge repeats and hide reversals BEFORE the cap and the counts, so the cap keeps the newest decisions
  // (not the first N in graph order) and every number describes what the file shows.
  const sourceOf = new Map<ContextDecision, ListedDecision>();
  const choices = decisionShapedRows(rows).filter((r) => !isFileBump(r)).map((r) => {
    const reason = extractReason(r.title, r.summary ?? '') ?? statedBodyReason(r.title, r.summary, needsChoice(r.title)) ?? subjectReason(r.title);
    // The cut test reads the title as stored, prefix included: the graph cut those 80 characters, not the stripped ones.
    const d: ContextDecision = { ...contextDecisionOf({ ...r, title: wholeTitle(r.title, r.summary).replace(FEAT_PREFIX, '') }), kind: reason || !CODE_PLATFORMS.has(r.platform ?? '') ? 'decision' : 'change', ...(reason ? { reason } : {}) };
    sourceOf.set(d, r);
    return d;
  });
  // Newest first for the cap, and where dates tie or are missing, the graph's own order: the cap among undated rows
  // keeps what it always kept, instead of whichever sorts first by citation.
  const rank = (d: ContextDecision): number => decidedTime(d.decidedAt) ?? Number.NEGATIVE_INFINITY;
  const tier = (at: number): number => { const r = sourceOf.get(choices[at]!)!; return !CODE_PLATFORMS.has(r.platform ?? '') || bySubject(r) ? 0 : 1; };
  const hasReason = (d: ContextDecision & { reverses?: string }): boolean => !!d.reason || !!d.reverses;
  const tidied = tidyDecisions(choices)
    .map((t) => ({ t, at: choices.indexOf(t.orig!) }))
    // A stated reason first (a commit with none is a fact, listed apart and the first to be cut), then strength: a decision
    // the subject states outranks one only the body states, whatever their dates.
    .sort((a, b) => Number(!hasReason(a.t)) - Number(!hasReason(b.t)) || tier(a.at) - tier(b.at) || rank(b.t) - rank(a.t) || a.at - b.at)
    .map((x) => x.t);
  // Rules take up to two thirds of the file, and any slot the commits, PRs and ADRs do not use as well.
  const keptRules = rules.slice(0, Math.max(Math.floor(limit * RULE_SHARE_OF_CAP), limit - tidied.length));
  const keptChoices = tidied.slice(0, Math.max(0, limit - keptRules.length));
  const decisions = [
    // `selected` keeps the stored rows: the committed-file check reads their titles as the importer wrote them.
    ...keptRules.map((r) => ({ ...contextDecisionOf({ ...r, title: headingTitle.get(r)?.title ?? displayRuleTitle(r) }), kind: 'rule' as const })),
    ...keptChoices.map(({ orig: _orig, ...d }) => d),
  ];
  // What is not in the file because it is not an item at all (a dependency bump) or is folded into a listed one is not "left out".
  const bumps = rows.filter((r) => CODE_PLATFORMS.has(r.platform ?? '') && isDependencyBumpSubject(r.title.replace(FEAT_PREFIX, ''))).length;
  const folded = choices.length - tidied.length;
  return {
    decisions,
    leftOut: rows.length - bumps - folded - stale.length - overflow.length - decisions.length,
    // The source rows of what is written, so a caller can judge those and not the ones left out.
    // A heading row printed with prose is also listed with that prose as its title, so the committed-file check judges
    // the text the file prints and not only the heading it was stored under.
    selected: [...keptRules.flatMap((r) => { const proof = headingTitle.get(r)?.proof; return proof ? [r, { ...r, title: proof }] : [r]; }), ...keptChoices.map((t) => sourceOf.get(t.orig!)!)],
  };
}
