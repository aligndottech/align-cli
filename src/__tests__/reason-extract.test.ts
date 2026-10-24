/**
 * extractReason pulls the STATED reason out of a commit body, deterministically.
 * A wrong "reason" is worse than none, so every shape that is not a reason must give null.
 * Fixtures are real commit-body shapes, including what the git importer embeds
 * (formatCommitAsText: Author/Date/Files changed/URL).
 */
import { describe, expect, it } from 'vitest';
import { extractReason } from '../lib/reason-extract.js';
import { formatCommitAsText } from '../lib/git.js';

const commit = (subject: string, body: string) => ({
  sha: 'abc1234abc1234abc1234abc1234abc1234abc12', subject, body,
  author: 'Ada Lovelace', date: '2024-05-01T10:00:00Z', filesChanged: ['lib/avoid-prevent-because', 'test/x'],
});
const full = (subject: string, body: string) =>
  formatCommitAsText(commit(subject, body), 'https://github.com/o/r/commit/abc1234abc1234abc1234abc1234abc1234abc12');

describe('stated reasons', () => {
  it('keeps a because-sentence verbatim', () => {
    expect(extractReason('fix: parser', 'The old parser buffered the whole body because it predates streams.'))
      .toBe('The old parser buffered the whole body because it predates streams.');
  });
  it('keeps a so-that sentence', () => {
    expect(extractReason('feat: use Map', 'Use a Map so that lookups stay constant time.'))
      .toBe('Use a Map so that lookups stay constant time.');
  });
  it('keeps a to-avoid sentence and a to-prevent sentence', () => {
    expect(extractReason('x', 'Copy the buffer to avoid mutating the caller input.')).toBe('Copy the buffer to avoid mutating the caller input.');
    expect(extractReason('x', 'Lock the file to prevent two writers racing each other.')).toBe('Lock the file to prevent two writers racing each other.');
  });
  it('keeps a due-to and an instead-of sentence', () => {
    expect(extractReason('x', 'Dropped the retry loop due to unbounded memory growth in long runs.')).toContain('due to unbounded memory growth');
    expect(extractReason('x', 'Use the native URL class instead of the hand rolled splitter, which broke on IPv6 hosts.')).toContain('instead of the hand rolled splitter');
  });
  it('change-describing words alone are not a reason: instead of, no longer, previously, replaces', () => {
    expect(extractReason('x', 'Use the native URL class instead of the hand rolled splitter here.')).toBeNull();
    expect(extractReason('x', 'The log no longer emits a redundant level change event per request.')).toBeNull();
    expect(extractReason('x', 'It was previously stored in a map and now lives in a plain object.')).toBeNull();
    expect(extractReason('x', 'The new options object replaces the older positional arguments entirely.')).toBeNull();
  });
  it('the same words next to a named problem are a reason: previously + crash, no longer + leak', () => {
    expect(extractReason('x', 'Previously the worker would crash when the queue was empty.')).toContain('would crash');
    expect(extractReason('x', 'Sockets are no longer left open, which was a leak under load.')).toContain('leak');
  });
  it('a BREAKING CHANGE footer describes the change, it is not a reason', () => {
    expect(extractReason('x', 'BREAKING CHANGE: define option no longer calls JSON.stringify on string values.')).toBeNull();
  });
  it('"since" as a date or version is not a cause', () => {
    expect(extractReason('x', 'This function has been deprecated since node 16 in the docs.')).toBeNull();
    expect(extractReason('x', 'The frozen path has used the cache since pnpm/pnpm#14861 landed.')).toBeNull();
    expect(extractReason('x', 'It was a stable option since the first release of the package.')).toBeNull();
  });
  it('"since" before a clause is a cause, with a noun or a pronoun as its subject', () => {
    expect(extractReason('x', 'The tool runs with the toolchain set, since Cargo finds subcommands in the bin dir.')).toContain('since Cargo finds');
    expect(extractReason('x', 'Remove the plugin since it is no longer maintained by anyone.')).toContain('since it is');
  });
  it('a Reason or Why label counts as a marker and the label is dropped', () => {
    expect(extractReason('x', 'Reason: the cache grew without bound under load.')).toBe('the cache grew without bound under load.');
    expect(extractReason('x', '**Why:** callbacks hide errors from the async stack trace.')).toBe('callbacks hide errors from the async stack trace.');
  });
  it('"since" as a cause counts, "since v1.2" as a version does not', () => {
    expect(extractReason('x', 'Since the lock was global, writers starved under load.')).toContain('writers starved');
    expect(extractReason('x', 'Available since v1.2.0 of the router package.')).toBeNull();
  });
});

describe('ranking and shape', () => {
  it('returns at most 2 sentences, the strongest two, in body order', () => {
    const body = [
      'Previously the worker would crash when the queue was empty.',
      'We switched because the old API leaked sockets under heavy load.',
      'It also helps in order to keep the surface area small for users.',
    ].join(' ');
    const out = extractReason('x', body)!;
    expect(out).toBe('We switched because the old API leaked sockets under heavy load. It also helps in order to keep the surface area small for users.');
  });
  it('with four equally strong sentences it keeps the first two', () => {
    const body = ['One was done because reason alpha applies.', 'Two was done because reason bravo applies.', 'Three was done because reason charlie applies.', 'Four was done because reason delta applies.'].join(' ');
    expect(extractReason('x', body)).toBe('One was done because reason alpha applies. Two was done because reason bravo applies.');
  });
  it('caps each sentence near 180 chars at a word boundary', () => {
    const body = `We changed it because ${'reallylongword '.repeat(30)}end.`;
    const out = extractReason('x', body)!;
    expect(out.length).toBeLessThanOrEqual(183);
    expect(out.endsWith('...')).toBe(true);
    expect(out).not.toMatch(/reallylongwor\.\.\.$/);
  });
  it('a sentence longer than the cap whose marker is past the cut is dropped, not shown as a fragment', () => {
    const lead = 'The configuration loader reads every file in the project directory and then merges them in order';
    expect(extractReason('x', `${lead} ${'with some more words about it '.repeat(3)}, because the cache grew without bound under load.`)).toBeNull();
  });
  it('a long sentence whose marker is inside the cap is kept and cut at a word', () => {
    const out = extractReason('x', `We did it because the cache grew ${'and grew '.repeat(40)}forever.`)!;
    expect(out.startsWith('We did it because the cache grew')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
  });
  it("a long sentence with no commas and a late marker is dropped too", () => {
    expect(extractReason('x', `${'word '.repeat(60)}because x.`)).toBeNull();
  });
  it('a labelled reason longer than the cap is cut, not dropped', () => {
    const out = extractReason('x', `Reason: ${'the cache grew '.repeat(30)}because forever.`)!;
    expect(out.startsWith('the cache grew')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
  });
  it('a quoted line is read without its quote marker', () => {
    expect(extractReason('x', '> We removed it because it was slow on every request.')).toBe('We removed it because it was slow on every request.');
  });
  it('joins hard-wrapped lines of one paragraph', () => {
    expect(extractReason('x', 'We removed it because\nit was slow on every\nrequest we measured.'))
      .toBe('We removed it because it was slow on every request we measured.');
  });
  it('handles CRLF line endings with no stray carriage returns', () => {
    const out = extractReason('x', 'We removed it because\r\nit was slow on every\r\nrequest we measured.\r\n\r\nSigned-off-by: A <a@b.c>\r\n')!;
    expect(out).toBe('We removed it because it was slow on every request we measured.');
    expect(out).not.toContain('\r');
  });
  it('CRLF in a whole importer summary still strips the metadata block', () => {
    const crlf = full('fix: parser', 'We removed it because the old one leaked.').replace(/\n/g, '\r\n');
    expect(extractReason('fix: parser', crlf)).toBe('We removed it because the old one leaked.');
  });
  it('a very long single line is bounded and still finds an early reason', () => {
    const body = `We did this because the old path leaked sockets. ${'Filler words. '.repeat(20000)}`;
    const t0 = Date.now();
    const out = extractReason('x', body)!;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(out).toBe('We did this because the old path leaked sockets.');
  });
  it('reads only the head of a body: a reason past the cap is not found', () => {
    expect(extractReason('x', `${'Filler words. '.repeat(600)}We did this because of a leak.`)).toBeNull();
    expect(extractReason('x', `We did this because of a leak. ${'Filler words. '.repeat(600)}`)).toBe('We did this because of a leak.');
  });
  it('is deterministic', () => {
    const body = 'We did it because it was slow. Also to avoid a crash on empty input.';
    expect(extractReason('t', body)).toBe(extractReason('t', body));
  });
});

describe('markup is stripped, never quoted', () => {
  it('strips emphasis, code ticks and link syntax', () => {
    expect(extractReason('x', 'We need this because `foo` is [deprecated](https://x.test/z) in **v3**.'))
      .toBe('We need this because foo is deprecated in v3.');
  });
  it('removes bare URLs and leaves no gap before punctuation', () => {
    const out = extractReason('x', 'We moved because the limit was hit, see https://example.com/very/long/path/that/goes/on/forever for details.')!;
    expect(out).toBe('We moved because the limit was hit, see for details.');
  });
  it('a reason whose object WAS a URL is dropped, not printed with a hole in it', () => {
    expect(extractReason('x', 'this was not working because of https://github.com/o/r/pull/1#discussion_r2 and https://github.com/o/r/pull/3')).toBeNull();
    expect(extractReason('x', 'We reverted due to https://example.com/incident-4 and the rollback.')).toBeNull();
  });
  it('strips real HTML tags but keeps their text', () => {
    expect(extractReason('x', 'We dropped <b>it</b> because the <a href="https://x.test">parser</a> was slow.')).toBe('We dropped it because the parser was slow.');
  });
  it('a space before a dotted name is kept: .env, .npmrc, .bind(x)', () => {
    expect(extractReason('x', 'We read the .env file because the .npmrc layer is ignored by call .bind(reply) here.'))
      .toBe('We read the .env file because the .npmrc layer is ignored by call .bind(reply) here.');
  });
  it('placeholder text in angle brackets is not HTML and survives', () => {
    expect(extractReason('x', 'Run with <path> set because the default dir is read only.')).toBe('Run with <path> set because the default dir is read only.');
  });
  it('drops HTML comments, alone or around a real sentence', () => {
    expect(extractReason('x', '<!-- because this is a template hint -->')).toBeNull();
    expect(extractReason('x', '<!-- template\nbecause hint -->\nWe dropped it because it was unsafe to keep.')).toBe('We dropped it because it was unsafe to keep.');
  });
  it('ignores fenced code', () => {
    expect(extractReason('x', '```js\n// because we need to avoid the slow path here\nrun();\n```')).toBeNull();
    expect(extractReason('x', 'Before.\n\n~~~\nbecause we need to avoid the slow path here\n~~~')).toBeNull();
  });
});

describe('what is NOT a reason gives null', () => {
  it('empty, whitespace and undefined bodies', () => {
    expect(extractReason('x', '')).toBeNull();
    expect(extractReason('x', '  \n\n ')).toBeNull();
    expect(extractReason('x', undefined)).toBeNull();
  });
  it('a body that is only trailers', () => {
    expect(extractReason('x', 'Co-authored-by: Ann <ann@x.test>\nSigned-off-by: Bob <bob@x.test>\nReviewed-by: Cy <cy@x.test>')).toBeNull();
  });
  it('trailers are removed next to a real reason', () => {
    expect(extractReason('x', 'We did it because it was slow.\n\nCo-authored-by: Ann <ann@x.test>\nSigned-off-by: because to avoid <b@x.test>'))
      .toBe('We did it because it was slow.');
  });
  it('Fixes / Closes / Refs lines are not reasons', () => {
    expect(extractReason('x', 'Fixes #12')).toBeNull();
    expect(extractReason('x', 'Closes #13\nRefs: owner/repo#14\nFixes https://github.com/o/r/issues/15')).toBeNull();
  });
  it('a Fixes line is cut out of the paragraph it sits in, not glued onto the reason', () => {
    expect(extractReason('x', 'Fixes #12, #13, #14, #15, #16, #17, #18, #19, #20, #21, #22, #23, #24\nWe dropped it because it was slow on big bodies.')).toBe('We dropped it because it was slow on big bodies.');
    expect(extractReason('x', 'We dropped it because it was slow on big bodies.\nCloses owner/repo#7')).toBe('We dropped it because it was slow on big bodies.');
  });
  it('a Fixes line carrying a real sentence is kept', () => {
    expect(extractReason('x', 'Fixes a crash because the cache was never cleared.')).toBe('Fixes a crash because the cache was never cleared.');
  });
  it('dependabot bump with release notes', () => {
    const body = [
      'Bumps [find-my-way](https://github.com/delvedor/find-my-way) from 8.0.0 to 8.1.0.',
      '<details>',
      '<summary>Release notes</summary>',
      '<p><em>Sourced from <a href="https://github.com/delvedor/find-my-way/releases">find-my-way\'s releases</a>.</em></p>',
      '<blockquote>',
      '<h2>v8.1.0</h2>',
      '<ul><li>fix: avoid crash because of empty param by <a href="https://github.com/u">@u</a> in #1</li></ul>',
      '</blockquote>',
      '</details>',
    ].join('\n');
    expect(extractReason('chore(deps): bump find-my-way from 8.0.0 to 8.1.0', body)).toBeNull();
  });
  it('a bump body is null even when its prose has a marker and no heading', () => {
    expect(extractReason('x', 'Bumps [x](https://github.com/o/x) from 1.0.0 to 1.1.0.\nNotes from upstream: it avoids crashes because the parser was rewritten internally.')).toBeNull();
    expect(extractReason('x', 'This PR contains the following updates:\n\nUpdates were needed because the old version had a crash in the resolver.')).toBeNull();
  });
  it('bot and merge-commit sentences are not reasons', () => {
    expect(extractReason('x', 'Dependabot will resolve this because it keeps the branch rebased on main.')).toBeNull();
    expect(extractReason('x', 'Merge pull request #5 from a/b because of the new flow overall.')).toBeNull();
  });
  it('a bare keyword or tiny fragment is not a statement', () => {
    expect(extractReason('x', 'Because slow.')).toBeNull();
    expect(extractReason('x', 'Reason: slow.')).toBeNull();
    expect(extractReason('x', 'To avoid crashes.')).toBeNull();
  });
  it('a hash-led changelog line is not a reason, a hash-looking word is', () => {
    expect(extractReason('x', 'abcdef1 fix: avoid the crash because of a bad parse in the lexer')).toBeNull();
    expect(extractReason('x', 'effaced entries were kept because the audit needs them later.')).toBe('effaced entries were kept because the audit needs them later.');
  });
  it('renovate style table', () => {
    expect(extractReason('Update dependency x to v2', 'This PR contains the following updates:\n\n| Package | Change |\n|---|---|\n| x | `1.0.0` -> `2.0.0` |')).toBeNull();
  });
  it('a release notes / changelog dump is cut at its heading', () => {
    const body = "Release 5.1.0\n\n## What's Changed\n* fix: prevent crash because x by @a in #1\n* feat: to avoid y by @b in #2";
    expect(extractReason('chore: release 5.1.0', body)).toBeNull();
    expect(extractReason('x', 'We did it because it was slow.\n\n## Changelog\n- avoid z because of w')).toBe('We did it because it was slow.');
  });
  it('squash-merge bullets of plain subjects', () => {
    expect(extractReason('feat: logger (#9)', '* feat(logger): use pino.BaseLogger as main interface\n* fix: handle edge\n* chore: bump deps')).toBeNull();
  });
  it('a squash bullet with only a medium marker is not kept', () => {
    expect(extractReason('x', '* fix(router): use the native URL instead of the splitter, which broke on IPv6')).toBeNull();
  });
  it('any list item of a squash is a sub-commit title: a medium marker is not enough', () => {
    expect(extractReason('x', '* Hooks: throw on incorrect async function\n\n* Log a warn instead of throwing an error\n\n* Updated test')).toBeNull();
    expect(extractReason('x', '- Return early on empty input rather than crash in the parser')).toBeNull();
  });
  it('a conventional-commit subject line in a plain paragraph is a title too', () => {
    expect(extractReason('x', 'fix(router): use the native URL instead of the splitter, which broke on IPv6.')).toBeNull();
    expect(extractReason('x', 'fix(router): decode params so that encoded slashes survive intact.')).toBe('decode params so that encoded slashes survive intact.');
  });
  it('a squash bullet with a strong marker is kept', () => {
    expect(extractReason('feat: router (#9)', '* fix(router): do not decode params so that encoded slashes survive\n* chore: bump deps'))
      .toBe('do not decode params so that encoded slashes survive');
  });
  it('a body that restates the title in other words', () => {
    expect(extractReason('Remove the legacy parser because it is deprecated and slow', 'The legacy parser is removed because it is deprecated and slow.')).toBeNull();
  });
  it('a body that repeats the title', () => {
    expect(extractReason('remove parser because it is deprecated', 'Remove parser because it is deprecated.')).toBeNull();
    expect(extractReason('fix: avoid crash because header missing', 'fix: avoid crash because header missing')).toBeNull();
  });
  it('a body repeating a title the importer cut at 80 characters', () => {
    expect(extractReason('fix: added a check to prevent creation of secondary server when extern',
      'added a check to prevent creation of secondary server when external server is passed to serverfactory #4725')).toBeNull();
  });
  it('a markdown table', () => {
    expect(extractReason('x', '| Before | After |\n|---|---|\n| slow because x | fast to avoid y |')).toBeNull();
  });
  it('headings and bare keywords', () => {
    expect(extractReason('x', '## Performance\n\n## Security')).toBeNull();
    expect(extractReason('x', 'Performance improvements.')).toBeNull();
  });
  it('mostly non-English text with an English marker word in it', () => {
    expect(extractReason('x', '删除了旧的解析器，因为它太慢了，这个改动是为了避免崩溃 because it is slow on every request we measured.')).toBeNull();
    expect(extractReason('x', '古いパーサーを削除しました、遅すぎるため、クラッシュを避けるために because slow on every request we measured.')).toBeNull();
  });
  it('non-English text', () => {
    expect(extractReason('x', 'Wir haben das entfernt, weil es zu langsam war.\n\n因为这个很慢，所以删除。')).toBeNull();
  });
});

describe('the importer metadata (formatCommitAsText) never leaks', () => {
  it('reason comes from the body, not from Author/Date/Files/URL', () => {
    const text = full('fix: parser', 'We removed it because the old one leaked.');
    expect(extractReason('fix: parser', text)).toBe('We removed it because the old one leaked.');
  });
  it('a commit with no body yields null even though file names contain marker words', () => {
    const text = full('fix: parser', '');
    expect(extractReason('fix: parser', text)).toBeNull();
  });
  it('a title echoed on the line above the body is not glued to it', () => {
    expect(extractReason('fix: drop the legacy parser from the request pipeline entirely now', 'fix: drop the legacy parser from the request pipeline entirely now\nWe dropped it because it was slow.')).toBe('We dropped it because it was slow.');
    expect(extractReason('feat: add a cache', full('feat: add a cache', 'It avoids repeat reads, which is needed because disks are slow.'))).toBe('It avoids repeat reads, which is needed because disks are slow.');
  });
  it('a body that is only a title echo plus metadata is null', () => {
    expect(extractReason('fix: parser', full('fix: parser', 'fix: parser'))).toBeNull();
  });
});

describe('wrong-polarity and look-alike inputs found in review give null', () => {
  it('negated reasons', () => {
    expect(extractReason('x', 'This is not because of the cache. We changed the key format for fun.')).toBeNull();
    expect(extractReason('x', 'We did it, but not because the old one was slow on big inputs.')).toBeNull();
    expect(extractReason('x', "It isn't just because of speed that the old one went away today.")).toBeNull();
  });
  it('questions', () => {
    expect(extractReason('x', 'Is this broken because of the proxy? We should look at the retry logic later.')).toBeNull();
    expect(extractReason('x', 'Why not use the native one? Maybe because it is slower than the other one.')).toBe('Maybe because it is slower than the other one.');
  });
  it('a marker inside quotation marks is someone else\'s claim', () => {
    expect(extractReason('x', 'The reporter wrote "it crashes because the cache is stale" but we could not reproduce that issue.')).toBeNull();
  });
  it('release-please entries and version headings are another change\'s text', () => {
    expect(extractReason('chore(main): release 1.2.0', '## 1.2.0\n\n### Bug Fixes\n\n* fix crash because the parser was incorrect (#12)')).toBeNull();
    expect(extractReason('x', 'Notes.\n\n### Bug Fixes\n\n* fix crash because the parser was incorrect (#12)')).toBeNull();
    expect(extractReason('x', '## [1.2.0](https://x.test/compare)\n\nWe fixed it because the parser was incorrect today.')).toBeNull();
  });
  it('merge branch subjects', () => {
    expect(extractReason("Merge branch 'x' into main", "Merge branch 'fix-bug-because-of-race' into main")).toBeNull();
  });
  it('short unpunctuated lines are not fused into one sentence', () => {
    expect(extractReason('x', 'Add the billing feature flag to settings\nFix crash in login screen because token was null\nUpdate docs for the flag'))
      .toBe('Fix crash in login screen because token was null');
  });
  it('abbreviations do not split a sentence', () => {
    expect(extractReason('x', 'The old code did not work because of Mr. Jones bug in the Node release. It crashed.')).toBe('The old code did not work because of Mr. Jones bug in the Node release.');
  });
  it('a label with a placeholder or pointer is not a reason, and Problem is not a label', () => {
    expect(extractReason('x', 'Reason: n/a for this one, just a trivial change really.')).toBeNull();
    expect(extractReason('x', 'Why: see #123 for the longer discussion of why this change happened.')).toBeNull();
    expect(extractReason('x', 'Problem: the foo module is in the wrong place and nothing else here.')).toBeNull();
  });
  it('a marker word inside a file name is not a marker', () => {
    expect(extractReason('x', 'Rename because.ts and so_that.md into the shared utils folder for clarity.')).toBeNull();
  });
});

describe('PR template checklists', () => {
  it('never reads a ticked or unticked task-list item as a reason', () => {
    const body = [
      '## Checklist',
      '- [ ] I added tests because the old suite missed the regression',
      '- [x] I updated the docs so that users find the new flag',
    ].join('\n');
    expect(extractReason('feat: flag', body)).toBeNull();
    expect(extractReason('feat: flag', '* [X] Ran the benchmarks to avoid a perf regression in the router')).toBeNull();
  });
  it('still reads the because-sentence that sits next to a checklist', () => {
    const body = 'The router rebuilt its table on every call because the cache key ignored the prefix.\n\n- [ ] tests added\n- [x] docs updated';
    expect(extractReason('fix: router cache', body)).toBe('The router rebuilt its table on every call because the cache key ignored the prefix.');
  });
});
