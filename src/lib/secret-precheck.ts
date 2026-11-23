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
import { secretsIn } from './share/secret-scan.js';
import type { AlignmentResult } from './gateway-client.js';

export interface SecretHit { file: string; line: number; kind: string }

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

/** The kinds of provider secret on one line, each once. */
function kindsIn(line: string): string[] {
  const kinds = secretsIn(line).flatMap((p) => (KIND_BY_PLACEHOLDER[p] ? [KIND_BY_PLACEHOLDER[p]] : []));
  if (PRIVATE_KEY_HEADER.test(line)) kinds.push('private key');
  return kinds;
}

/** Secret shapes on the ADDED lines of a unified diff. A line the change removes is not a finding. */
export function secretHitsInDiff(diff: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let file = '';
  let line = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) { file = row.slice(4).replace(/^b\//, '').replace(/\t.*$/, ''); continue; }
    if (row.startsWith('--- ') || row.startsWith('diff --git')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (row.startsWith('+')) {
      for (const kind of kindsIn(row.slice(1))) hits.push({ file, line, kind });
      line += 1;
    } else if (row.startsWith(' ')) line += 1;
  }
  return hits;
}

const MAX_NAMED = 3;

function conflictFor(h: SecretHit): NonNullable<AlignmentResult['conflicts']>[number] {
  return {
    decision_id: 'align:secret-precheck',
    title: `A ${h.kind} is being added`,
    summary: 'Detected from the shape of the added text, not from a decision in your graph. The value is not shown.',
    reason: `${h.file} line ${h.line} adds what looks like a ${h.kind}. Remove it and rotate it if it was ever real; committing a credential is never aligned.`,
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
  const judgeNote = llm === null ? [`The decision-graph judge did not run (${llmError instanceof Error ? llmError.message : String(llmError)}). The secret check above needed no judge.`] : [];
  const where = hits.slice(0, MAX_NAMED).map((h) => `${h.file}:${h.line}`).join(', ');
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
