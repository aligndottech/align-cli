import { describe, expect, it } from 'vitest';
import { redactSecrets, secretsIn } from '../lib/share/secret-scan.js';

// A build fingerprint (git SHA, sha256 build hash) written as `label:hex` has the shape of the generic
// `label:value` credentials rule and was redacted. Every "passes through" case below sits next to a "still redacted"
// case on the other side of the same boundary. Fixtures that look like credentials are built by concatenation.
const fx = (...parts: string[]): string => parts.join('');
const SHA7 = '3f9c2a1';
const SHA12 = '3f9c2a1e7b4d';
const SHA40 = '3f9c2a1e'.repeat(5);
const SHA64 = 'a1b2c3d4e5f60718'.repeat(4);
const SHA64_UPPER = SHA64.toUpperCase();
const GH = fx('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');

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

describe('a hex identifier under a build-ish label is kept; the same hex under any other label is not', () => {
  it('build: kept, user: redacted', () => {
    kept(`build:${SHA40}`);
    redacted(`admin:${SHA40}`, SHA40);
  });
  it('fingerprint: kept (sha256 length), password: redacted', () => {
    kept(`fingerprint:${SHA64}`);
    redacted(fx('pass', 'word:', SHA64), SHA64);
  });
  it('commit: kept, api key label redacted', () => {
    kept(`commit:${SHA40}`);
    redacted(`apikey:${SHA40}`, SHA40);
  });
  it('sha: and checksum: kept (short and long forms), secret: redacted', () => {
    kept(`sha:${SHA12}`);
    kept(`checksum:${SHA64}`);
    redacted(`secret:${SHA12}`, SHA12);
  });
  it('compound and upper-case labels are kept (BUILD_ID, commit_hash), a label that only ends in a safe-looking word is not', () => {
    kept(`BUILD_ID:${SHA40}`);
    kept(`commit_hash:${SHA40}`);
    redacted(`buildtoken:${SHA40}`, SHA40);
    redacted(`hashtoken:${SHA40}`, SHA40);
  });
  it('upper-case hex is still hex', () => {
    kept(`fingerprint:${SHA64_UPPER}`);
  });
  it('a non-hex value under a build label is still redacted (the label alone clears nothing)', () => {
    const v = fx('Sup3r', 'S3cret', 'Passw0rd');
    redacted(`build:${v}`, v);
    redacted(`checksum:${SHA12}-${v}`, v);
  });
  it('length boundary: 40 and 64 kept, 41 and 63 and 65 hex characters redacted', () => {
    kept(`build:${SHA40}`);
    kept(`build:${SHA64}`);
    for (const n of [41, 63, 65]) {
      const v = SHA64.repeat(2).slice(0, n);
      redacted(`build:${v}`, v);
    }
  });
  it('shortest accepted: 8 hex characters kept, and a 7-character value never reached the rule either way', () => {
    kept(`sha:${SHA40.slice(0, 8)}`);
    kept(`sha:${SHA7}`);
  });
  it('a build hash and a real secret in one text: the hash survives, the secret goes, count is 1', () => {
    const r = redactSecrets(`build:${SHA40} rotated ${GH}`);
    expect(r.text).toBe(`build:${SHA40} rotated <GITHUB_TOKEN>`);
    expect(r.count).toBe(1);
    expect(secretsIn(`build:${SHA40} rotated ${GH}`)).toEqual(['<GITHUB_TOKEN>']);
  });
  it('a build hash earlier in the text does not hide a credential-shaped label:value later in it', () => {
    const t = `build:${SHA40} then admin:${SHA12}`;
    expect(redactSecrets(t).text).toBe(`build:${SHA40} then <CREDENTIALS>`);
    expect(secretsIn(t)).toEqual(['<CREDENTIALS>']);
  });
});

describe('the spaced and = forms a user reported, and the neighbours that must still redact', () => {
  it('build: / fingerprint= / build_id= / a commit message pass through untouched', () => {
    kept(`build: ${SHA40}`);
    kept(`fingerprint=${SHA64}`);
    kept(`BUILD_ID=${SHA40}`);
    kept(`bump build fingerprint to ${SHA40}`);
    kept(SHA40);
    kept(SHA64);
  });
  it('the same hex under password / secret / token / api_key labels is still redacted, in every separator form', () => {
    redacted(fx('pass', 'word=', SHA40), SHA40);
    redacted(fx('pass', 'word: ', SHA40), SHA40);
    redacted(`secret: ${SHA64}`, SHA64);
    redacted(`token: ${SHA40}`, SHA40);
    redacted(`PASSWORD=${SHA40}`, SHA40);
    redacted(`api_key=${SHA40}`, SHA40);
  });
});

describe('real credential shapes are unchanged', () => {
  const cases: Array<[string, string]> = [
    ['github token', GH],
    ['aws access key', fx('AK', 'IA', 'IOSFODNN7EXAMPLE')],
    ['slack token', fx('xo', 'xb-', '1234567890-', '1234567890123-', 'AbCdEfGhIjKlMnOpQrStUvWx')],
    ['jwt', fx('ey', 'JhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'abcdefghij1234567890')],
    ['generic api key', fx('api', '_key=', 'Ab12Cd34Ef56Gh78Ij90Kl12')],
    ['label:value credentials', fx('admin:', 'S3cretP4ssw0rd')],
  ];
  for (const [name, raw] of cases) {
    it(`${name} is still redacted`, () => {
      redacted(`see ${raw} here`, raw);
    });
  }
});

describe('an identifier word at the END of the label does not launder a credential word before it', () => {
  const MD5 = SHA64.slice(0, 32);
  it('password_hash / token-hash / api_key_commit / secret.sha / auth_digest are still redacted', () => {
    redacted(fx('pass', 'word_hash:', MD5), MD5);
    redacted(`token-hash:${SHA40}`, SHA40);
    redacted(`api_key_commit:${SHA40}`, SHA40);
    redacted(`secret.sha:${SHA40}`, SHA40);
    redacted(`auth_digest:${SHA64}`, SHA64);
    redacted(`private_key_rev:${SHA40}`, SHA40);
    redacted(`credential_checksum:${SHA40}`, SHA40);
  });
  it('identifier prefixes with no credential word are still kept', () => {
    kept(`git_sha:${SHA40}`);
    kept(`image_digest:${SHA64}`);
    kept(`release.build_id:${SHA40}`);
  });
});

// Shane Wall's strings: a digest named for its hash algorithm is not a credential whatever its length, and the
// label alone clears nothing. Each kept case sits beside a still-redacted case across the same boundary.
describe('an algorithm-prefixed hex digest is kept, at any length', () => {
  it('fnv1a64: kept, admin: with the same hex redacted', () => {
    kept('fnv1a64:c279bbc77948a8c5');
    redacted('admin:c279bbc77948a8c5', 'c279bbc77948a8c5');
  });
  it('sha256: short form kept, secret: with the same hex redacted', () => {
    kept('sha256:9f86d081884c7d65');
    redacted('secret:9f86d081884c7d65', '9f86d081884c7d65');
  });
  it('every named algorithm is kept', () => {
    for (const a of ['sha1', 'sha256', 'sha512', 'md5', 'fnv1a32', 'fnv1a64', 'blake2b', 'blake3', 'crc32', 'xxh64', 'xxh3', 'murmur3']) kept(`${a}:c279bbc77948a8c5`);
  });
  it('the sentence from the trial keeps its fingerprint', () => {
    kept('Every lab brief records the source fingerprint fnv1a64:c279bbc77948a8c5 so a stale build is caught.');
  });
  it('a hash name followed by a non-hex value is still redacted', () => {
    const v = fx('Sup3r', 'S3cret', 'Passw0rd');
    redacted(`fnv1a64:${v}`, v);
  });
  it('admin:hunter22x is still redacted', () => {
    redacted('admin:hunter22x', 'hunter22x');
  });
  it('a credential word before the algorithm name is not exempt', () => {
    redacted('password_sha256:c279bbc77948a8c5', 'c279bbc77948a8c5');
  });
});

