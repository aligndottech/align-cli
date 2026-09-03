/**
 * ALI-829: how many items each connector fetches when nobody says otherwise.
 *
 * ONE writer for two readers: `align setup` and `align import <connector>`. They disagreed
 * for nine of eleven connectors (measured 2026-09-02) - `align import slack` fetched 50
 * where setup had fetched 250 - so re-importing to get more got less, and nothing anywhere
 * said so. A literal in each command is the same two-writers defect as a type and a CHECK
 * constraint spelling one fact twice (code-style.md). import-defaults.test.ts holds every
 * command and every setup source to this table.
 *
 * Zoom is 50 in both readers now, and on connector-core 0.6.0 the fetcher can actually
 * reach 50 (it paginates); on 0.5.0 that 50 was inert, because the call returned at most 30.
 */
export const IMPORT_LIMITS = {
  git: 500,
  docs: 500,
  github: 250,
  jira: 250,
  confluence: 250,
  slack: 250,
  teams: 250,
  zoom: 50,
  gitlab: 250,
  linear: 250,
  notion: 250,
  sessions: 250,
} as const satisfies Record<string, number>;

/** Slack's look-back window, the same number in both readers for the same reason. */
export const SLACK_DAYS_BACK = 90;
