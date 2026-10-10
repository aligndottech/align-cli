import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { secretsIn } from '../lib/share/secret-scan.js';

// Fixtures are assembled from pieces so no literal credential shape sits in this file (the repo's
// secret scanner reads literals; it never reads a string built at run time).
const fx = (...parts: string[]): string => parts.join('');
const PW = fx('Sup3r', 'S3cret', 'Passw0rd!');
const pemBegin = fx('-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----');
const pemEnd = fx('-----END ', 'OPENSSH PRIVATE', ' KEY-----');

describe('the vendored secret patterns carry the shapes the server added (align-stack 292e07017)', () => {
  it('claims a private-key block, with or without its end marker', () => {
    expect(secretsIn(`${pemBegin}\nb3BlbnNzaC1rZXk\n${pemEnd}`)).toContain('<PRIVATE_KEY>');
    expect(secretsIn(`${pemBegin}\nb3BlbnNzaC1rZXk`)).toContain('<PRIVATE_KEY>');
  });
  it('leaves a certificate and prose about a key alone', () => {
    expect(secretsIn(fx('-----BEGIN ', 'CERTIFICATE-----\nMIIB\n-----END ', 'CERTIFICATE-----'))).toEqual([]);
    expect(secretsIn('we should rotate the private key every quarter')).toEqual([]);
  });
  it('claims a password or secret assignment with a literal value, quoted or not', () => {
    expect(secretsIn(fx('pass', 'word: ', PW))).toContain('<SECRET_VALUE>');
    expect(secretsIn(fx('"db_pass', 'word": "', PW, '"'))).toContain('<SECRET_VALUE>');
  });
  it('leaves prose, requirements, references and versions alone', () => {
    expect(secretsIn('reset your password from the account page')).toEqual([]);
    expect(secretsIn(fx('pass', 'word: required'))).toEqual([]);
    expect(secretsIn(fx('to', 'ken = request.headers.get(x)'))).toEqual([]);
    expect(secretsIn(fx('sec', 'ret: v1.2.3-beta'))).toEqual([]);
    expect(secretsIn(fx('to', 'ken: ${TOKEN}'))).toEqual([]);
  });
  it('claims a secret URL parameter with a digit-bearing value, and not ?page=2', () => {
    expect(secretsIn(fx('https://example.com/cb?to', 'ken=a8Kd92jfLq0Zx7Pw'))).toContain('<URL_SECRET_PARAM>');
    expect(secretsIn('https://example.com/list?page=2')).toEqual([]);
    expect(secretsIn(fx('https://example.com/x?sec', 'ret=true'))).toEqual([]);
  });
  it('still claims the older shapes (a URL with credentials, positive control for the loader)', () => {
    expect(secretsIn(fx('postgres://user:', 'pass@host/db'))).toContain('<URL_CREDENTIALS>');
  });
});

describe('no input shape makes the scan slow (a decision can be 200 KB; the old patterns took seconds)', () => {
  const units = ['a', 'a-', 'a_', '_', 'to' + 'ken=', 'pass' + 'word=', '?to' + 'ken=', '&sig=', '://', 'a://', '@', ':', '\r\n', '<', '"', pemBegin.slice(0, 20)];
  it.each(units)('200 KB of %j finishes well inside a second', (unit) => {
    const text = unit.repeat(Math.ceil(200_000 / unit.length));
    const t = performance.now();
    secretsIn(text);
    expect(performance.now() - t).toBeLessThan(1000);
  });
  it('positive control: the table really holds runnable units', () => {
    expect(units.length).toBeGreaterThan(10);
    expect(units.every((u) => u.length > 0)).toBe(true);
  });
});

describe('the vendored file is the one align-stack ships', () => {
  it('matches the pinned sha256 (re-vendor from align-stack config/secret-patterns.json, then update this pin)', () => {
    const file = fileURLToPath(new URL('../lib/share/secret-patterns.json', import.meta.url));
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    expect(sha, 'the vendored secret-patterns.json drifted from the pinned align-stack copy: re-vendor it byte for byte').toBe(
      '417d9c71c2282d6735cab406f9d26dbac7698bd1341f17d01a04a88a61d548e4',
    );
  });
});
