import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildFixtures, serializeFixtures } from './helpers/share-plaintext-fixtures.js';

/**
 * ALI-1540 cross-repo contract: the sealed plaintext this CLI produces, committed as a fixture the gateway and the approve
 * page vendor and test against. This test regenerates it from the real code and compares byte for byte, so the plaintext shape
 * cannot change without the fixture (and so the other two repos' pinned copies) being updated on purpose.
 * Update: UPDATE_SHARE_FIXTURES=1 npx vitest run src/__tests__/share-plaintext-fixtures.test.ts
 */
const FILE = path.join(__dirname, 'fixtures', 'share-plaintext-fixtures.json');

describe('share plaintext contract fixtures', () => {
  it('match the committed copy byte for byte', () => {
    const now = serializeFixtures(buildFixtures());
    if (process.env['UPDATE_SHARE_FIXTURES'] === '1') fs.writeFileSync(FILE, now);
    expect(fs.readFileSync(FILE, 'utf8')).toBe(now);
  });
  it('are the four named cases, each internally consistent (hash is over the exact string, fields are the real union)', () => {
    const fx = buildFixtures();
    expect(fx.map((f) => f.name)).toEqual(['minimal-share', 'rich-share', 'confirm-team-text', 'ten-item-share']);
    for (const f of fx) {
      expect(createHash('sha256').update(f.plaintext_json, 'utf8').digest('hex')).toBe(f.plaintext_sha256);
      expect(JSON.parse(f.plaintext_json).decisions.length).toBeGreaterThan(0);
    }
    expect(JSON.parse(fx[3]!.plaintext_json).decisions).toHaveLength(10);
    const rich = JSON.parse(fx[1]!.plaintext_json);
    expect(rich.decisions[0].judgements.map((j: { kind: string }) => j.kind).sort()).toEqual(['note', 'ratify']);
    expect(rich.display[0].left_local).toHaveLength(2);
    const confirm = JSON.parse(fx[2]!.plaintext_json);
    expect(confirm.confirm).toEqual({ decision_id: '00000000-0000-4000-8000-000000000500', team_text_hash: 'team-text-hash-1' });
    expect(confirm.decisions[0].judgements[0].confirm_team_text_hash).toBe('team-text-hash-1');
  });
});
