import { describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const succeeded: string[] = [];
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn((t: string) => { succeeded.push(t); }),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  })),
}));
vi.spyOn(console, 'log').mockImplementation(() => undefined);

import type { PersonalImportItem } from '../lib/personal-import.js';
import { runPersonalImport } from '../lib/personal-import.js';
import type { createGatewayClient } from '../lib/gateway-client.js';

/**
 * ALI-770. `align setup --local` already imports from git, so `align import git` afterwards
 * is a natural next move - and it said "Imported 2 decisions" while the graph stayed at 2.
 * A tester read that as importing twice, which is precisely what it looks like.
 */
function clientReturning(snapshots: unknown[]): ReturnType<typeof createGatewayClient> {
  return {
    ingestBatch: vi.fn().mockResolvedValue({ snapshots }),
  } as unknown as ReturnType<typeof createGatewayClient>;
}

const items: PersonalImportItem[] = [
  { raw_text: 'one', source_url: 'git://commit/1', platform: 'git' },
  { raw_text: 'two', source_url: 'git://commit/2', platform: 'git' },
];
const opts = { label: 'git history', approve: true, appUrl: 'https://app.align.tech', local: true };

describe('import reporting: new vs already known', () => {
  it('says nothing was new when every decision was already in the graph', async () => {
    succeeded.length = 0;
    await runPersonalImport(items, clientReturning([{ id: 'a', created: false }, { id: 'b', created: false }]), opts);
    expect(succeeded.join(' ')).toMatch(/0 new/);
    expect(succeeded.join(' ')).toMatch(/2 already in your graph/);
  });

  it('reports the split when some were new and some were not', async () => {
    succeeded.length = 0;
    await runPersonalImport(items, clientReturning([{ id: 'a', created: true }, { id: 'b', created: false }]), opts);
    expect(succeeded.join(' ')).toMatch(/1 new/);
    expect(succeeded.join(' ')).toMatch(/1 already in your graph/);
  });

  // A genuinely first import should not be cluttered with "(2 new, 0 already known)" - the
  // breakdown exists to explain a re-import, and saying it every time makes it noise that
  // stops being read.
  it('keeps the plain wording when everything was new', async () => {
    succeeded.length = 0;
    await runPersonalImport(items, clientReturning([{ id: 'a', created: true }, { id: 'b', created: true }]), opts);
    expect(succeeded.join(' ')).toMatch(/Imported 2 decisions from git history/);
    expect(succeeded.join(' ')).not.toMatch(/already in your graph/);
  });

  // The cloud gateway shares this function and does not report created/updated, so the
  // absence of the flag must leave the existing message exactly as it was.
  it('leaves the message unchanged when the server does not report it', async () => {
    succeeded.length = 0;
    await runPersonalImport(items, clientReturning([{ id: 'a' }, { id: 'b' }]), opts);
    expect(succeeded.join(' ')).toMatch(/Imported 2 decisions from git history/);
    expect(succeeded.join(' ')).not.toMatch(/already in your graph|new/);
  });
});
