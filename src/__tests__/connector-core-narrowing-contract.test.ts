import fs from 'node:fs';
import path from 'node:path';
import { buildJiraJql } from '@aligndottech/connector-core';
import { describe, expect, it } from 'vitest';

/**
 * A narrowed scope is a consent boundary: the person chose one board, or one Linear project. An older connector-core
 * accepts the option and silently ignores it, which would read the whole project or team. These fail on any installed
 * connector-core that does not narrow, so the pin in package.json is what keeps the boundary.
 *
 * Linear has no exported query builder to call, and its fetcher talks to the network through undici (which a test here
 * cannot intercept), so its half is the installed version: 0.14.0 is the first that sends `projects` (align-connector-sdk#56).
 */
describe('the installed connector-core narrows', () => {
  it('Jira: a jql option is ANDed inside the project', () => {
    expect(buildJiraJql({ projects: ['AC'], jql: 'labels = pay' } as Parameters<typeof buildJiraJql>[0])).toBe('project in (AC) AND (labels = pay) ORDER BY updated DESC');
  });

  it('Linear: the installed version is one that sends projects (0.14.0 or later)', () => {
    // The package is ESM-only and does not export its package.json, so it is read from the installed folder (vitest runs at the repo root).
    const { version } = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'node_modules', '@aligndottech', 'connector-core', 'package.json'), 'utf8')) as { version: string };
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    const [major, minor] = version.split('.').map(Number) as [number, number];
    expect(major > 0 || minor >= 14).toBe(true);
  });
});
