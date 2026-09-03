/**
 * ALI-827: how each connector is named in the capture report, and what one of its items
 * IS. One writer for two readers - `align setup` (buildSources) and every
 * `align import <x>` - so one command cannot say "PRs and issues" while another says
 * "items" for the same connector (code-style.md, two writers of one fact). A count with no noun is
 * a number nobody can check, which is why the noun is a required half of every entry.
 *
 * Keyed by connector id, the same id `src/commands/import/<id>.ts` carries; a parity
 * test holds the two sets equal.
 */
export const CAPTURE_SOURCES = {
  git: { label: 'Git', unit: 'commits' },
  docs: { label: 'Repo docs', unit: 'ADRs and sections' },
  github: { label: 'GitHub', unit: 'PRs and issues' },
  jira: { label: 'Jira', unit: 'issues' },
  confluence: { label: 'Confluence', unit: 'pages' },
  slack: { label: 'Slack', unit: 'threads' },
  teams: { label: 'Microsoft Teams', unit: 'messages' },
  zoom: { label: 'Zoom', unit: 'recordings' },
  gitlab: { label: 'GitLab', unit: 'merge requests' },
  linear: { label: 'Linear', unit: 'issues' },
  notion: { label: 'Notion', unit: 'pages' },
  sessions: { label: 'Agent sessions', unit: 'decisions' },
} as const satisfies Record<string, { label: string; unit: string }>;
