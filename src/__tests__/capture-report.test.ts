import { describe, expect, it } from 'vitest';
import { createCaptureCollector, renderCaptureReport } from '../lib/capture-report.js';

/**
 * ALI-827: the capture report - what each import fetched, and what it could not reach.
 * Test List R1-R5 from thoughts/shared/plans/2026-09-02-local-capture-depth-slices-1-2.md
 * (align-stack). Two examples per rule so a naive first pass has to generalise.
 */
describe('renderCaptureReport', () => {
  // R1a
  it('names each source and what it fetched, with the unit noun', () => {
    const out = renderCaptureReport([{ label: 'Slack', unit: 'threads', fetched: 3, skips: [] }]);
    expect(out).toContain('Capture report');
    expect(out).toContain('Slack: 3 threads');
  });

  // R1b
  it('orders by fetched count then label, never by the order imports finished', () => {
    // setup.ts imports several connectors concurrently, so arrival order is a race. Two
    // runs of the same import must print the same report or the number is not quotable.
    const sources = [
      { label: 'Slack', unit: 'threads', fetched: 3, skips: [] },
      { label: 'Jira', unit: 'issues', fetched: 182, skips: [] },
      { label: 'Git', unit: 'commits', fetched: 3, skips: [] },
    ];
    const forward = renderCaptureReport(sources);
    const reversed = renderCaptureReport([...sources].reverse());
    expect(forward).toBe(reversed);
    expect(forward.indexOf('Jira')).toBeLessThan(forward.indexOf('Git'));
    // Tie on the count: label ascending, by code unit, so the tie-break is the same on
    // every machine (latent-vs-deterministic.md: never localeCompare).
    expect(forward.indexOf('Git')).toBeLessThan(forward.indexOf('Slack'));
  });

  // R2a
  it('prints each skip once, indented under its source', () => {
    const out = renderCaptureReport([{
      label: 'Git', unit: 'commits', fetched: 3,
      skips: [{ count: 2, detail: 'commits stated no reason beyond the subject' }],
    }]);
    const lines = out.split('\n');
    const sourceIdx = lines.findIndex((l) => l.includes('Git: 3 commits'));
    const skipLines = lines.filter((l) => l.includes('2 commits stated no reason beyond the subject'));
    expect(skipLines).toHaveLength(1);
    expect(lines.indexOf(skipLines[0])).toBe(sourceIdx + 1);
    // Deeper indent than the source line it explains.
    const indent = (l: string) => l.length - l.trimStart().length;
    expect(indent(skipLines[0])).toBeGreaterThan(indent(lines[sourceIdx]));
  });

  // R2b
  it('prints no skip line at all for a source with nothing skipped', () => {
    const out = renderCaptureReport([{ label: 'Git', unit: 'commits', fetched: 8, skips: [] }]);
    expect(out.split('\n')).toEqual(['  Capture report', '    Git: 8 commits']);
  });

  // R3a
  it('says "of up to N requested" when fewer came back than were asked for', () => {
    const out = renderCaptureReport([{ label: 'Zoom', unit: 'recordings', fetched: 30, requested: 50, skips: [] }]);
    expect(out).toContain('Zoom: 30 recordings of up to 50 requested');
  });

  // R3b
  it('omits the clause when the request was met, or nothing was requested', () => {
    // A full result is not a shortfall. The positive assertion first: a negative alone is
    // satisfied by an empty render (tdd.md, "a negative assertion needs a positive control").
    const met = renderCaptureReport([{ label: 'Zoom', unit: 'recordings', fetched: 30, requested: 30, skips: [] }]);
    expect(met).toContain('Zoom: 30 recordings');
    expect(met).not.toContain('up to');
    // No cap asked for means there is nothing to fall short of.
    const uncapped = renderCaptureReport([{ label: 'Zoom', unit: 'recordings', fetched: 30, skips: [] }]);
    expect(uncapped).toContain('Zoom: 30 recordings');
    expect(uncapped).not.toContain('up to');
  });

  // R4a
  it('still gives a source that fetched nothing its own line', () => {
    // That zero IS the answer to "why is Slack thin"; dropping it would hide the one
    // number the user was about to ask about.
    const out = renderCaptureReport([
      { label: 'Slack', unit: 'threads', fetched: 0, requested: 250, skips: [] },
      { label: 'Jira', unit: 'issues', fetched: 5, skips: [] },
    ]);
    expect(out).toContain('Slack: 0 threads of up to 250 requested');
  });

  // R5a
  it('renders the empty string when there are no sources', () => {
    // Never a bare header over nothing.
    expect(renderCaptureReport([])).toBe('');
  });
});

describe('createCaptureCollector', () => {
  // R5b
  it('accumulates sources and renders the same text every time it is asked', () => {
    const collector = createCaptureCollector();
    collector.add({ label: 'Slack', unit: 'threads', fetched: 3, skips: [] });
    collector.add({ label: 'Jira', unit: 'issues', fetched: 182, skips: [] });
    const first = collector.render();
    const second = collector.render();
    // Positive control before the equality: '' === '' would pass against a collector
    // that stored nothing.
    expect(first).toContain('Jira: 182 issues');
    expect(first).toBe(second);
    expect(first).toBe(renderCaptureReport([
      { label: 'Jira', unit: 'issues', fetched: 182, skips: [] },
      { label: 'Slack', unit: 'threads', fetched: 3, skips: [] },
    ]));
  });

  it('renders nothing before anything is added, and includes a source added late', () => {
    const collector = createCaptureCollector();
    expect(collector.render()).toBe('');
    collector.add({ label: 'Git', unit: 'commits', fetched: 1, skips: [] });
    expect(collector.render()).toContain('Git: 1 commits');
  });
});
