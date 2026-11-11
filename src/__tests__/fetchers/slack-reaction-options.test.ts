import { beforeEach, describe, expect, it, vi } from 'vitest';

// The wrapper's job: hand the reaction options to connector-core's SlackFetcher.
// What the options select is core's own suite's business.
const seen: Array<Record<string, unknown>> = [];
vi.mock('@aligndottech/connector-core', () => ({
  SlackFetcher: class {
    async fetch(opts: Record<string, unknown>) {
      seen.push(opts);
      return [];
    }
  },
}));

import { fetchSlackItems } from '../../lib/fetchers/slack.js';

describe('fetchSlackItems reaction options', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it('passes captureEmojis and reactionsFromAnyone through', async () => {
    await fetchSlackItems({ token: 't', captureEmojis: ['white_check_mark'], reactionsFromAnyone: true });
    expect(seen[0]).toMatchObject({ captureEmojis: ['white_check_mark'], reactionsFromAnyone: true });
  });

  it('leaves both unset by default so core applies its own defaults', async () => {
    await fetchSlackItems({ token: 't' });
    expect(seen[0]).not.toHaveProperty('captureEmojis');
    expect(seen[0]).not.toHaveProperty('reactionsFromAnyone');
  });
});
