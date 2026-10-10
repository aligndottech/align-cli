import type { CAPTURE_SOURCES } from './capture-sources.js';

/**
 * ALI-829, widened by L3: how far back and how many items each connector reads when nobody
 * says otherwise.
 *
 * ONE writer for every reader: `align setup`, `align connect <connector>`, `align connect
 * --since` and the MCP tool `align_backfill`. They disagreed for nine of eleven connectors
 * before ALI-829 (measured 2026-09-02) - `align import slack` fetched 50 where setup had
 * fetched 250 - so re-importing to get more got less, and nothing anywhere said so. A literal
 * in each command is the same two-writers defect as a type and a CHECK constraint spelling
 * one fact twice (code-style.md). import-defaults.test.ts holds every command and every setup
 * source to this table.
 */
export type SourceId = keyof typeof CAPTURE_SOURCES;

/** Every connector reads the last six months unless told otherwise (`--since`). */
export const SYNC_WINDOW_DEFAULT_DAYS = 180;

/**
 * Single writer (ALI-829). Ceilings stop a runaway first import; they are not targets.
 * Measured: P0, 2026-10-10, align-cli 739796c, research 2026-10-10-p0-capture-measurements.md.
 * PROVISIONAL = P0 could not measure it (token dead or source not connected); re-measure on first
 * real connect and replace with a measured number.
 */
export const SYNC_CEILINGS = {
  github: 3_000,     // items-only pass: 30 search calls at 30/min = about 1 min. P0: 314 in 180 days (personal token).
  slack: 2_000,      // threads; the binding limit is the 8-min time budget (3 s/channel), not this.
  jira: 2_000,       // PROVISIONAL: 20 calls at 100/page.
  linear: 2_000,     // PROVISIONAL: 20 pages; within 2,500 req/h (API key).
  gitlab: 2_000,     // PROVISIONAL: 20 calls at 100/page.
  confluence: 2_000, // PROVISIONAL: 8 calls at 250/page per space set.
  notion: 1_000,     // PROVISIONAL: 2+ calls per page at about 3 req/s; 1,000 pages is about 11 min, so the time budget binds.
  teams: 1_000,      // PROVISIONAL: token dead in P0.
  zoom: 200,         // PROVISIONAL: one transcript download per meeting.
  git: 5_000,        // scan bound for `git log`; the window narrows it (`from`), so it rarely binds.
  docs: 500,         // repo ADRs and doc sections; not a windowed read.
  sessions: 250,     // review candidates per run; not a windowed read.
} as const satisfies Record<SourceId, number>;

/** The SDK's own Slack budget (`SLACK_TIME_BUDGET_MS`), applied to every windowed source: the
 *  journey-2 promise is that the full window finishes within 8 minutes, or says what it cut. */
export const SYNC_TIME_BUDGET_MS = 8 * 60_000;

/** Core requests per sync run spent on GitHub discussion; 4% of 15,000/h (P0). */
export const GITHUB_DISCUSSION_BUDGET = 600;
