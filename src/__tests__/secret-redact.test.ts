import { describe, expect, it } from 'vitest';
import { redactSecrets, secretsIn } from '../lib/share/secret-scan.js';

// Fixtures are assembled from pieces so no literal credential shape sits in this file (the repo's
// secret scanner reads literals; it never reads a string built at run time). Never edit .gitleaks.toml.
const fx = (...parts: string[]): string => parts.join('');
const GH = fx('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const GH2 = fx('gh', 'p_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2');
const SK = fx('sk', '_live_', 'Ab12Cd34Ef56Gh78Ij90');
const PEM = fx('-----BEGIN ', 'RSA PRIVATE', ' KEY-----\nMIIEow', 'IBAAKCAQEA7x\n-----END ', 'RSA PRIVATE', ' KEY-----');
const PW = fx('Sup3r', 'S3cret', 'Passw0rd!');

describe('redactSecrets: replace each matched span with its placeholder, never keep the raw value', () => {
  it('a GitHub token becomes <GITHUB_TOKEN>', () => {
    const r = redactSecrets(`rotate ${GH} before Friday`);
    expect(r.text).toBe('rotate <GITHUB_TOKEN> before Friday');
    expect(r.count).toBe(1);
  });
  it('a Stripe key becomes <STRIPE_KEY>', () => {
    const r = redactSecrets(`billing uses ${SK}`);
    expect(r.text).toBe('billing uses <STRIPE_KEY>');
    expect(r.count).toBe(1);
  });
  it('a private key block becomes <PRIVATE_KEY>, body included', () => {
    const r = redactSecrets(`deploy key:\n${PEM}\nend`);
    expect(r.text).toBe('deploy key:\n<PRIVATE_KEY>\nend');
    expect(r.text).not.toContain('MIIEow');
  });
  it('counts every span: two tokens in one text are two', () => {
    const r = redactSecrets(`old ${GH} new ${GH2}`);
    expect(r.text).toBe('old <GITHUB_TOKEN> new <GITHUB_TOKEN>');
    expect(r.count).toBe(2);
  });
  it('counts across kinds: a token and a key are two', () => {
    expect(redactSecrets(`${GH} and ${SK}`).count).toBe(2);
  });

  it('keeps the captured prefix where the pattern has one: URL credentials keep the scheme and host', () => {
    const r = redactSecrets(fx('db is postgres://admin:', 'hunter2x@db.internal/app'));
    expect(r.text).toBe('db is postgres://<URL_CREDENTIALS>@db.internal/app');
    expect(r.count).toBe(1);
  });
  it('keeps the captured prefix: a password assignment keeps its label', () => {
    const r = redactSecrets(fx('pass', 'word: ', PW));
    expect(r.text).toBe(fx('pass', 'word: ', '<SECRET_VALUE>'));
    expect(r.text).not.toContain(PW);
  });

  it('a bare 40-character AWS secret is redacted only near the word "aws", as the server decides', () => {
    const key = fx('wJalrXUtnFEMI', 'K7MDENGbPxRfiCY', 'EXAMPLEKEY12');
    expect(key).toHaveLength(40);
    const near = redactSecrets(`aws creds ${key}`);
    expect(near.text).toBe('aws creds <AWS_SECRET_KEY>');
    expect(near.count).toBe(1);
    const far = redactSecrets(`checksum ${key}`);
    expect(far.text).toBe(`checksum ${key}`);
    expect(far.count).toBe(0);
  });

  it('leaves ordinary decision text untouched, count 0', () => {
    const text = 'We decided to rotate the private key every quarter. See PR #123 and https://github.com/a/b/pull/9.';
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
    expect(redactSecrets('')).toEqual({ text: '', count: 0 });
  });

  it('positive control: every fixture above is a secret to the share scanner too (one pattern list)', () => {
    for (const f of [GH, GH2, SK, PEM]) expect(secretsIn(f).length).toBeGreaterThan(0);
  });

  it('a redacted text has nothing left for the scanner to find (idempotent: placeholders are not secrets)', () => {
    const once = redactSecrets(`${GH} ${PEM} ${fx('pass', 'word: ', PW)}`);
    expect(secretsIn(once.text)).toEqual([]);
    expect(redactSecrets(once.text)).toEqual({ text: once.text, count: 0 });
  });
});

describe('no input shape makes redaction slow (a big import item can be 200 KB)', () => {
  const pemBegin = fx('-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----');
  const units = ['a', 'a-', 'a_', '_', 'to' + 'ken=', 'pass' + 'word=', '?to' + 'ken=', '&sig=', '://', 'a://', '@', ':', '\r\n', '<', '"', pemBegin.slice(0, 20), 'aws ', 'Ab1'];
  it.each(units)('200 KB of %j finishes well inside a second', (unit) => {
    const text = unit.repeat(Math.ceil(200_000 / unit.length));
    const t = performance.now();
    redactSecrets(text);
    expect(performance.now() - t).toBeLessThan(1000);
  });
  it('200 KB of realistic text with secrets scattered through it stays fast and finds them all', () => {
    const chunk = `Decided to use the new deploy flow. ${GH} was leaked in the old runbook. `;
    const n = Math.ceil(200_000 / chunk.length);
    const t = performance.now();
    const r = redactSecrets(chunk.repeat(n));
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.count).toBe(n);
  });
});
