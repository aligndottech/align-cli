import { describe, expect, it } from 'vitest';
import { judgeWithSecretCheck, scanDiff, SECRET_PRECHECK_ID, secretHitsInDiff } from '../lib/secret-precheck.js';
import { lastCheckFor } from '../lib/curation/last-check.js';

// Every fixture that looks like a credential is built at runtime, never written as a literal.
const GH = `ghp_${'x'.repeat(36)}`;
const AKIA = (tail: string) => `AKIA${tail}`;
const RANDOM_PW = ['q7Zr', 'M2xK', 'v9Tn', 'B4wL', 'p8Yc'].join('');
const AWS40 = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzzzzzzzzz'.slice(0, 40);
const B64_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC'.repeat(1);

const header = (file: string) => `diff --git a/${file} b/${file}\nindex 111..222 100644\n--- a/${file}\n+++ b/${file}\n`;
const hunk = (start: number, rows: string[]) => `@@ -${start},1 +${start},${rows.length} @@\n${rows.join('\n')}\n`;
const diffOf = (file: string, rows: string[], start = 1) => header(file) + hunk(start, rows);
const kinds = (d: string) => secretHitsInDiff(d).map((h) => h.kind);

describe('diff parsing', () => {
  it('catches an added line whose content starts with "++ " (it is a "+++ " row inside a hunk)', () => {
    const hits = secretHitsInDiff(diffOf('a.txt', [`+++ ${GH}`]));
    expect(hits).toEqual([{ file: 'a.txt', line: 1, kind: 'GitHub token' }]);
  });
  it('an added "++ foo" line does not rename the file or shift later line numbers', () => {
    const hits = secretHitsInDiff(diffOf('a.txt', ['+++ foo', '+ok', `+${GH}`]));
    expect(hits).toEqual([{ file: 'a.txt', line: 3, kind: 'GitHub token' }]);
  });
  it('numbers a second hunk from its own header, and context rows count', () => {
    const d = `${header('a.txt')}${hunk(1, ['+one'])}@@ -40,2 +50,3 @@\n ctx\n-gone\n+${GH}\n+two\n`;
    expect(secretHitsInDiff(d)).toEqual([{ file: 'a.txt', line: 51, kind: 'GitHub token' }]);
  });
  it('reports the NEW name of a rename', () => {
    const d = `diff --git a/old.env b/new.env\nsimilarity index 90%\nrename from old.env\nrename to new.env\n--- a/old.env\n+++ b/new.env\n@@ -1 +1,2 @@\n x\n+${GH}\n`;
    expect(secretHitsInDiff(d)).toEqual([{ file: 'new.env', line: 2, kind: 'GitHub token' }]);
  });
  it('a combined (merge) hunk reports the right file and never line 0', () => {
    const d = `diff --cc m.env\nindex 1,2..3\n--- a/m.env\n+++ b/m.env\n@@@ -1,2 -1,2 +1,3 @@@\n  base\n++${GH}\n  tail\n`;
    const hits = secretHitsInDiff(d);
    expect(hits).toEqual([{ file: 'm.env', line: 2, kind: 'GitHub token' }]);
  });
});

describe('placeholders and documented examples are not secrets', () => {
  it('URL credentials: placeholders clean, a random password flags', () => {
    for (const url of ['postgres://user:password@localhost/db', 'postgres://user:${PASS}@host/db', 'postgres://u:<password>@h/db', 'postgres://u:changeme@h/db', 'postgres://u:xxxxxxxx@h/db', 'postgres://u:Example@h/db']) {
      expect(kinds(diffOf('a.env', [`+URL=${url}`])), url).toEqual([]);
    }
    expect(kinds(diffOf('a.env', [`+URL=postgres://app:${RANDOM_PW}@db.internal/prod`]))).toEqual(['password inside a URL']);
  });
  it('OpenAI-style keys: placeholders clean, a real-shaped key flags', () => {
    expect(kinds(diffOf('a.md', ['+export KEY=sk-your-key-goes-here-1234567890abcdef']))).toEqual([]);
    expect(kinds(diffOf('a.md', [`+export KEY=sk-proj-${'x'.repeat(30)}1`]))).toEqual([]);
    expect(kinds(diffOf('a.md', [`+KEY=sk-${'Ab3dE6gH9jK2mN5pQ8sT'}${'1vW4yZ7cF0hJ3kLn'}`]))).toEqual(['OpenAI-style API key']);
  });
  it('the documented AWS example key is clean, a real-shaped one flags', () => {
    expect(kinds(diffOf('a.md', [`+id = ${AKIA('IOSFODNN7EXAMPLE')}`]))).toEqual([]);
    expect(kinds(diffOf('a.md', [`+id = ${AKIA('IOSFODNN7ABCDEFG')}`]))).toEqual(['AWS access key']);
  });
  it('a private key header alone is clean; with a body line it flags', () => {
    const head = `-----BEGIN ${'RSA '}PRIVATE KEY-----`;
    expect(kinds(diffOf('doc.md', [`+${head}`, '+(example)']))).toEqual([]);
    expect(kinds(diffOf('k.pem', [`+${head}`, `+${B64_LINE}`]))).toEqual(['private key']);
  });
  it('the allow marker works on the same line and on the line above, and only there', () => {
    expect(kinds(diffOf('a.txt', [`+${GH} # align:allow-secret`]))).toEqual([]);
    expect(kinds(diffOf('a.txt', ['+# align:allow-secret', `+${GH}`]))).toEqual([]);
    expect(kinds(diffOf('a.txt', ['+# align:allow-secret', '+gap', `+${GH}`]))).toEqual(['GitHub token']);
    expect(kinds(diffOf('a.txt', [`+${GH}`]))).toEqual(['GitHub token']);
  });
});

describe('bare AWS secret needs a label on the same line', () => {
  it('"// aws <40 chars>" no longer flags, "aws_secret_access_key = <40 chars>" does', () => {
    expect(kinds(diffOf('a.js', [`+// aws ${AWS40}`]))).toEqual([]);
    expect(kinds(diffOf('a.js', [`+aws_secret_access_key = ${AWS40}`]))).toEqual(['AWS secret key']);
  });
  it('an unlabelled bare 40-char string next to a secret-named variable on the same line flags', () => {
    expect(kinds(diffOf('a.js', [`+const AWS_SECRET = x('${AWS40}')`]))).toEqual(['AWS secret key']);
  });
});

describe('what reaches the output', () => {
  const ALIGNED = { status: 'aligned' as const, confidence: 0.9, relevant_decisions: [], conflicts: [], message: 'ok' };
  it('raw provider error text is not copied into notes', async () => {
    const err = new Error(`401 for key ${GH} at https://x`);
    const r = await judgeWithSecretCheck(() => Promise.reject(err), diffOf('a.txt', [`+${GH}`]));
    const all = JSON.stringify(r);
    expect(all).not.toContain(GH);
    expect(all).not.toContain('401');
    expect(r.notes?.join(' ')).toContain('unavailable');
  });
  it('a file path holding a token-shaped string is redacted in the reason and message', async () => {
    const r = await judgeWithSecretCheck(() => Promise.resolve(ALIGNED), diffOf(`dir/${GH}.txt`, [`+${GH}`]));
    expect(JSON.stringify(r)).not.toContain(GH);
    expect(r.conflicts?.[0]?.reason).toContain('dir/');
  });
  it('the pseudo decision id never reaches last-check', async () => {
    const r = await judgeWithSecretCheck(() => Promise.resolve(ALIGNED), diffOf('a.txt', [`+${GH}`]));
    expect(r.conflicts?.[0]?.decision_id).toBe(SECRET_PRECHECK_ID);
    const entry = lastCheckFor('', { ...r, conflicts: [...(r.conflicts ?? []), { decision_id: 'real-1' }] });
    expect(entry.decision_ids).toEqual(['real-1']);
  });
});

describe('second review: one-line JSON key, marker anchoring, placeholders, adjacency, speed', () => {
  const BODY = `${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'}${'BKcwggSjAgEAAoIBAQC'}`;
  it('a one-line JSON service-account key is flagged (header then a literal \\n, a base64 run, or the END line)', () => {
    const head = `-----BEGIN ${'PRIVATE KEY'}-----`;
    expect(kinds(diffOf('sa.json', [`+{"private_key": "${head}\\n${BODY}\\n-----END PRIVATE KEY-----\\n"}`]))).toEqual(['private key']);
    expect(kinds(diffOf('sa.json', [`+k = "${head}${BODY}"`]))).toEqual(['private key']);
    expect(kinds(diffOf('sa.json', [`+k = "${head} x -----END PRIVATE KEY-----"`]))).toEqual(['private key']);
    expect(kinds(diffOf('doc.md', [`+Starts with ${head} and is a header.`]))).toEqual([]);
  });
  it('the marker is a whole token', () => {
    expect(kinds(diffOf('a.txt', [`+${GH} //xalign:allow-secretly`]))).toEqual(['GitHub token']);
    expect(kinds(diffOf('a.txt', [`+${GH} align:allow-secret-not`]))).toEqual(['GitHub token']);
    expect(kinds(diffOf('a.txt', [`+${GH} //align:allow-secret`]))).toEqual([]);
  });
  it('a marker on a CONTEXT row, or across a removed row, does not suppress', () => {
    const ctx = `${header('a.txt')}@@ -1,2 +1,2 @@\n # align:allow-secret\n+${GH}\n`;
    expect(kinds(ctx)).toEqual(['GitHub token']);
    const removed = `${header('a.txt')}@@ -1,3 +1,2 @@\n+# align:allow-secret\n-old\n+${GH}\n`;
    expect(kinds(removed)).toEqual(['GitHub token']);
    expect(kinds(diffOf('a.txt', ['+# align:allow-secret', `+${GH}`, `+${GH}`]))).toEqual(['GitHub token']);
  });
  it('an allowed secret is reported as a note, never silently', () => {
    const r = scanDiff(diffOf('a.txt', [`+${GH} # align:allow-secret`]));
    expect(r.hits).toEqual([]);
    expect(r.allowed).toEqual([{ file: 'a.txt', line: 1, kind: 'GitHub token' }]);
  });
  it('the note rides on the judge result', async () => {
    const ALIGNED = { status: 'aligned' as const, confidence: 0.9, relevant_decisions: [], conflicts: [], message: 'ok' };
    const r = await judgeWithSecretCheck(() => Promise.resolve(ALIGNED), diffOf('a.txt', [`+${GH} # align:allow-secret`]));
    expect(r.status).toBe('aligned');
    expect(r.notes?.join(' ')).toContain('1 secret(s) allowed by align:allow-secret (a.txt:1)');
  });
  it('the note also rides on a conflicting result when another secret is not allowed', async () => {
    const ALIGNED = { status: 'aligned' as const, confidence: 0.9, relevant_decisions: [], conflicts: [], message: 'ok' };
    const r = await judgeWithSecretCheck(() => Promise.resolve(ALIGNED), diffOf('a.txt', [`+${GH} # align:allow-secret`, '+gap', `+${GH}`]));
    expect(r.status).toBe('conflicting');
    expect(r.notes?.join(' ')).toContain('allowed by align:allow-secret');
  });
  it('more URL placeholders: password equal to the user, {word}, ALL-CAPS word; a random one still flags', () => {
    for (const url of ['postgres://postgres:postgres@h/db', 'x://app:app@h', 'x://anonymous:anonymous@h', 'x://u:{password}@h', 'x://u:TOKEN@h', 'x://u:PASSWORD@h']) {
      expect(kinds(diffOf('a.env', [`+U=${url}`])), url).toEqual([]);
    }
    expect(kinds(diffOf('a.env', [`+U=x://app:${RANDOM_PW}@h`]))).toEqual(['password inside a URL']);
  });
  it('documented examples: Stripe test key and the AWS doc secret ending EXAMPLEKEY are clean', () => {
    expect(kinds(diffOf('a.md', [`+k = ${['sk_test_', '4eC39HqLyjWDarjtT1zdp7dc'].join('')}`]))).toEqual([]);
    expect(kinds(diffOf('a.md', [`+aws_secret_access_key = ${'wJalrXUtnFEMI/K7MDENG/bPxRfiCY'}${'EXAMPLEKEY'}`]))).toEqual([]);
    expect(kinds(diffOf('a.md', [`+k = ${['sk_test_', 'Zq9xLm2Vx7Rk4Wd9Yb3Nab12'].join('')}`]))).toEqual(['Stripe key']);
  });
  it('a header in docs plus an unrelated LATER sha-looking row does not flag; an adjacent body does, past Proc-Type', () => {
    const head = `-----BEGIN ${'RSA '}PRIVATE KEY-----`;
    const sha = 'a'.repeat(40);
    expect(kinds(diffOf('doc.md', [`+${head}`, '+prose', '+more prose', '+even more', `+${sha}`]))).toEqual([]);
    const ctxGap = `${header('doc.md')}@@ -1,2 +1,3 @@\n+${head}\n ctx\n+${sha}\n`;
    expect(kinds(ctxGap)).toEqual([]);
    expect(kinds(diffOf('k.pem', [`+${head}`, '+Proc-Type: 4,ENCRYPTED', '+DEK-Info: AES-128-CBC,AB', '+', `+${BODY}`]))).toEqual(['private key']);
  });
  it('20k header rows scan in well under a second', () => {
    const head = `-----BEGIN ${'RSA '}PRIVATE KEY-----`;
    const rows = Array.from({ length: 20000 }, () => `+${head}`);
    const t = Date.now();
    secretHitsInDiff(diffOf('big.md', rows));
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
