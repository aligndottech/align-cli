/**
 * A deterministic secret-shape pre-check on the diff `align check` is about to judge.
 *
 * The judge only sees decisions retrieval hands it, and a rule such as "never commit a real secret" is usually one
 * sentence inside a large principles decision, so it can score too low to be retrieved and the diff comes back
 * "aligned". A credential shape has one right answer and needs no model, so it is computed here from the added
 * lines, beside the judge, and folded into the result like a co-change rule is.
 *
 * Only well-known PROVIDER token shapes count (the vendored secret-patterns list, narrowed to those). The generic
 * `label:value`, `password=`, `api_key=` and bearer patterns stay out: they are right for redacting stored text and
 * too loose to block a commit on. The match is never returned, only its kind, file and line.
 */
import { AWS_BARE_SECRET, redactSecrets, secretMatches } from './share/secret-scan.js';
import type { AlignmentResult } from './gateway-client.js';

export interface SecretHit { file: string; line: number; kind: string }

/** The pseudo decision a finding is filed under. It is not a decision: last-check, `align mark` and --resolve must skip it. */
export const SECRET_PRECHECK_ID = 'align:secret-precheck';

/** Put this in a line, or on the line above, to say a secret-shaped value there is deliberate (a test fixture, a doc). */
export const ALLOW_MARKER = 'align:allow-secret';

const KIND_BY_PLACEHOLDER: Record<string, string> = {
  '<AWS_ACCESS_KEY>': 'AWS access key',
  '<AWS_SECRET_KEY>': 'AWS secret key',
  '<GITHUB_TOKEN>': 'GitHub token',
  '<GITLAB_TOKEN>': 'GitLab token',
  '<OPENAI_KEY>': 'OpenAI-style API key',
  '<ANTHROPIC_KEY>': 'Anthropic API key',
  '<STRIPE_KEY>': 'Stripe key',
  '<GOOGLE_API_KEY>': 'Google API key',
  '<SLACK_TOKEN>': 'Slack token',
  '<LINEAR_KEY>': 'Linear API key',
  '<URL_CREDENTIALS>': 'password inside a URL',
};
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----/;
const KEY_BODY_LINE = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const AWS_SECRET_LABEL = /aws_secret_access_key|secret_access_key|aws_secret/i;

const PLACEHOLDER_PASSWORDS = new Set(['password', 'pass', 'passwd', 'pwd', 'secret', 'changeme', 'example', 'user', 'username', 'test', 'admin', 'root', 'redacted', 'yourpassword', 'your_password', 'xxx']);
const repeatedChar = (v: string): boolean => v.length > 0 && v.split('').every((c) => c === v[0]);

function urlPasswordIsPlaceholder(match: string): boolean {
  const afterScheme = match.slice(match.indexOf('//') + 2).replace(/@$/, '');
  const pw = afterScheme.slice(afterScheme.indexOf(':') + 1);
  return /^\$/.test(pw) || /^<.*>$/.test(pw) || /^\{\{/.test(pw) || /^%.*%$/.test(pw) || PLACEHOLDER_PASSWORDS.has(pw.toLowerCase()) || repeatedChar(pw.toLowerCase().replace(/[^a-z0-9]/g, '')) && pw.length > 0;
}
function openAiBodyIsPlaceholder(match: string): boolean {
  const body = match.slice(3);
  return /your|here|example|test|dummy|placeholder/i.test(body) || /(.)\1{7,}/.test(body);
}

/** The kinds of provider secret on one line, each once. A private key header is judged by the caller (it needs its body). */
function kindsIn(line: string): string[] {
  const kinds = new Set<string>();
  for (const { placeholder, match } of secretMatches(line)) {
    const kind = KIND_BY_PLACEHOLDER[placeholder];
    if (!kind) continue;
    if (placeholder === '<URL_CREDENTIALS>' && urlPasswordIsPlaceholder(match)) continue;
    if (placeholder === '<OPENAI_KEY>' && openAiBodyIsPlaceholder(match)) continue;
    if (placeholder === '<AWS_ACCESS_KEY>' && /EXAMPLE$/i.test(match)) continue;
    kinds.add(kind);
  }
  if (AWS_SECRET_LABEL.test(line)) {
    AWS_BARE_SECRET.lastIndex = 0;
    if (AWS_BARE_SECRET.test(line)) kinds.add('AWS secret key');
  }
  return [...kinds];
}

interface Row { file: string; line: number; text: string; prev: string }

/**
 * The ADDED rows of a unified or combined diff, with file and new-file line number. A "+++ " is a file header only
 * between a "diff" line and its first "@@": inside a hunk every row is content, so an added line that itself starts
 * with "++ " is read as an added line. Removed rows are never returned.
 */
function addedRows(diff: string): Row[] {
  const rows: Row[] = [];
  let file = '';
  let inHunk = false;
  let width = 1;
  let line = 0;
  let prev = '';
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git') || row.startsWith('diff --cc') || row.startsWith('diff --combined')) { inHunk = false; continue; }
    if (!inHunk) {
      if (row.startsWith('+++ ')) {
        const name = row.slice(4).replace(/\t.*$/, '').replace(/^"(.*)"$/, '$1');
        file = name === '/dev/null' ? file : name.replace(/^b\//, '');
        continue;
      }
      const h = /^(@@+) .*?\+(\d+)(?:,\d+)? @@/.exec(row);
      if (h) { inHunk = true; width = (h[1] as string).length - 1; line = Number(h[2]); prev = ''; }
      continue;
    }
    const h = /^(@@+) .*?\+(\d+)(?:,\d+)? @@/.exec(row);
    if (h) { width = (h[1] as string).length - 1; line = Number(h[2]); prev = ''; continue; }
    if (row.startsWith('\\')) continue;
    const prefix = row.slice(0, width);
    if (prefix.includes('-')) continue;
    const text = row.slice(width);
    if (prefix.includes('+')) rows.push({ file, line, text, prev });
    line += 1;
    prev = text;
  }
  return rows;
}

/** Secret shapes on the ADDED lines of a diff. A line the change removes is not a finding. */
export function secretHitsInDiff(diff: string): SecretHit[] {
  const rows = addedRows(diff);
  const hits: SecretHit[] = [];
  rows.forEach((r, i) => {
    if (r.text.includes(ALLOW_MARKER) || r.prev.includes(ALLOW_MARKER)) return;
    for (const kind of kindsIn(r.text)) hits.push({ file: r.file, line: r.line, kind });
    if (PRIVATE_KEY_HEADER.test(r.text) && rows.slice(i + 1).some((n) => n.file === r.file && KEY_BODY_LINE.test(n.text.trim()))) {
      hits.push({ file: r.file, line: r.line, kind: 'private key' });
    }
  });
  return hits;
}

const MAX_NAMED = 3;

/** A path can itself hold a token-shaped string, and the reason is printed and sent to CI. */
const shownPath = (file: string): string => redactSecrets(file).text;

function conflictFor(h: SecretHit): NonNullable<AlignmentResult['conflicts']>[number] {
  return {
    decision_id: SECRET_PRECHECK_ID,
    title: `A ${h.kind} is being added`,
    summary: 'Detected from the shape of the added text, not from a decision in your graph. The value is not shown.',
    reason: `${shownPath(h.file)} line ${h.line} adds what looks like a ${h.kind}. Remove it and rotate it if it was ever real; committing a credential is never aligned.`,
    severity: 'critical',
  };
}

/**
 * Fold secret hits into the judge's answer. `llm` is null when the judge threw. Critical, like a co-change
 * violation: one right answer, no confidence to discount, and it outranks `unknown`.
 */
export function mergeSecretHits(llm: AlignmentResult | null, llmError: unknown, hits: SecretHit[]): AlignmentResult {
  const found = hits.map(conflictFor);
  const { reason: _r, reason_class: _c, ...kept } = llm ?? { relevant_decisions: [] as AlignmentResult['relevant_decisions'] };
  const judgeNote = llm === null ? [`The decision-graph judge was unavailable (${llmError instanceof Error ? llmError.constructor.name : typeof llmError}). The secret check above needed no judge.`] : [];
  const where = hits.slice(0, MAX_NAMED).map((h) => `${shownPath(h.file)}:${h.line}`).join(', ');
  return {
    ...kept,
    status: 'conflicting',
    confidence: 1,
    conflicts: [...found, ...(llm?.conflicts ?? [])],
    notes: [...(llm?.notes ?? []), ...judgeNote],
    message: `This change adds ${hits.length} secret(s) (${where}${hits.length > MAX_NAMED ? ' and more' : ''}).`,
  };
}

/** Run the judge, then fold in secret hits. With none, the judge's answer or failure passes through untouched. */
export async function judgeWithSecretCheck(judge: () => Promise<AlignmentResult>, diff: string): Promise<AlignmentResult> {
  const hits = secretHitsInDiff(diff);
  if (hits.length === 0) return judge();
  try {
    return mergeSecretHits(await judge(), null, hits);
  } catch (err) {
    return mergeSecretHits(null, err, hits);
  }
}
