import { describe, expect, it } from 'vitest';
import { redactSecrets, secretsIn } from '../lib/share/secret-scan.js';

// A public SSH key fingerprint (`SHA256:<43 base64 chars>`, or colon-hex MD5) is a hash of a PUBLIC key, printed by
// `ssh-keygen -l` and shown in commit signature notes. It has the `label:value` shape of the generic credentials rule
// and was replaced with <CREDENTIALS>, garbling decision text. Each "kept" case sits beside a "still redacted" one.
const fx = (...parts: string[]): string => parts.join('');
const B64_43 = 'nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8';
const B64_43_SLASH = 'nThbg6kX/pJWGl7E1IGOCsp+omTxdCARLviKw6E5SY8';
const MD5_FP = '3b:de:a4:0c:55:12:9f:6e:01:2a:7c:d4:88:e3:f1:b9';

const kept = (text: string): void => {
  const r = redactSecrets(text);
  expect(r.text).toBe(text);
  expect(r.count).toBe(0);
  expect(secretsIn(text)).toEqual([]);
};
const redacted = (text: string, raw: string): void => {
  const r = redactSecrets(text);
  expect(r.text).not.toContain(raw);
  expect(r.count).toBeGreaterThan(0);
  expect(secretsIn(text).length).toBeGreaterThan(0);
};

describe('public key fingerprints are not secrets', () => {
  it('keeps a SHA256 fingerprint in a commit message', () => {
    kept(`Signed with key SHA256:${B64_43} (ed25519)`);
    kept(`Good "git" signature with ED25519 key SHA256:${B64_43}`);
  });
  it('keeps one whose base64 holds / and +, which end the generic match early', () => {
    kept(`Signed with key SHA256:${B64_43_SLASH} today`);
  });
  it('keeps a lowercase label too', () => {
    kept(`key sha256:${B64_43}`);
  });
  // The MD5 cases are not evidence for the SHA256 fix: the generic pattern never matched them on base.
  it('keeps a legacy MD5 colon-hex fingerprint, with and without the MD5: prefix', () => {
    kept(`fingerprint ${MD5_FP}`);
    kept(`key MD5:${MD5_FP}`);
  });
  it('still redacts a credential with a 43-char base64 value under another label', () => {
    redacted(fx('pass', 'word:', B64_43), B64_43);
    redacted(fx('sec', 'ret:', B64_43), B64_43);
    redacted(fx('api', 'key:', B64_43), B64_43);
  });
  it('a padded (=) value is not an SSH fingerprint, so it is still redacted', () => {
    redacted(`key SHA256:${B64_43}=`, B64_43);
  });
  it('redacts the tail when the fingerprint runs on into more characters (_ - . or a leading word)', () => {
    const tail = 'Tz8qLm2Vx7Rk4Wd9Yb3N';
    for (const sep of ['_', '-', '.']) {
      const r = redactSecrets(`key SHA256:${B64_43}${sep}${tail} end`);
      expect(r.text, sep).not.toContain(tail);
      expect(r.count, sep).toBeGreaterThan(0);
    }
    redacted(`key-SHA256:${B64_43}`, B64_43);
  });
  it('keeps a fingerprint followed by sentence punctuation', () => {
    kept(`Signed with SHA256:${B64_43}.`);
    kept(`(SHA256:${B64_43}), then more`);
  });
  it('still redacts a SHA256-labelled value of the wrong length', () => {
    redacted(`SHA256:${B64_43}Zq9x`, `${B64_43}Zq9x`);
    redacted(`SHA256:${B64_43.slice(0, 20)}`, B64_43.slice(0, 20));
  });
  it('redacts a real token sitting next to a fingerprint, keeps the fingerprint', () => {
    const gh = fx('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
    const r = redactSecrets(`key SHA256:${B64_43} token ${gh}`);
    expect(r.text).toContain(`SHA256:${B64_43}`);
    expect(r.text).not.toContain(gh);
    expect(r.count).toBe(1);
  });
});
