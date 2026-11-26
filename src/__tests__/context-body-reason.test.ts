/**
 * A commit is judged as a decision from its subject AND its body, in any language. Reported 24-25 Nov 2026: on a Spanish
 * repo, 7 of 13 commits holding a gotcha's reason were fix/docs, 5 were feat whose subject says what changed, so the
 * English-word subject gate dropped all of them; on yegor256/takes the file listed 14 titles and no reason.
 *
 * Test List:
 * 1. a fix/docs/scoped commit whose body is prose in Spanish is kept, and its reason is printed (two commits)
 * 2. a feat whose subject says what changed is kept when its body gives the reason (Spanish and English)
 * 3. an English fix whose body states why (a causal clause, or a choice) is kept; one that only describes the bug is not
 * 4. a body with nothing beyond the subject (a trailer, "Fixes #N", an echo, a merge line) keeps nothing
 * 5. the existing filters hold with a long body: dependency bump, revert, test/ci/chore
 * 6. the reason is printed under the decision in the file, in the author's words
 */
import { describe, expect, it } from 'vitest';
import { decisionShapedRows, selectForFile } from '../lib/context-from-graph.js';
import { renderDecisionsFile } from '../lib/decisions-context.js';

const META = '\n\nAuthor: Ada\n\nDate: 2026-11-01T10:00:00+01:00\n\nURL: git://commit/';
let n = 0;
// The stored row, as the git importer writes it: the whole subject, a blank line, the body, then Author/Date/URL.
const commit = (subject: string, body = '') => {
  n += 1;
  return { title: subject.slice(0, 80), platform: 'git', summary: `${subject}${body ? `\n\n${body}` : ''}${META}${n}`, source_url: `https://github.com/o/r/commit/${n}` };
};
const titles = (rows: Array<{ title: string; platform?: string }>) => decisionShapedRows(rows as never[]).map((r) => r.title);

describe('a body in Spanish states the reason', () => {
  it.each([
    ['fix(auth): corregir el refresco del token', 'El token se refrescaba dos veces porque el cliente móvil reintenta sin esperar y eso bloqueaba las sesiones.'],
    ['docs(gotchas): escalar 3 gotchas de SPEC-67', 'Se promueven a la lista fija para que el agente los vea en cada sesión, ya que repetía el mismo error cada semana.'],
  ])('keeps %s', (subject, body) => {
    expect(titles([commit(subject, body)])).toEqual([subject]);
  });

  it('a feat whose subject says what changed is kept when the body gives the reason', () => {
    const subject = 'feat: añadir caché de sesiones';
    expect(titles([commit(subject, 'Guardamos la sesión en memoria durante cinco minutos para no ir a la base de datos en cada petición del panel.')])).toEqual([subject]);
  });
});

describe('English bodies need the reason to be stated, not just present', () => {
  it('keeps an English feat whose subject says what changed when the body says why', () => {
    const subject = 'feat: add session cache';
    expect(titles([commit(subject, 'We keep the session in memory for five minutes because the dashboard polls every second.')])).toEqual([subject]);
  });

  it('keeps an English fix whose body states a choice', () => {
    const subject = 'fix(parser): reject empty names';
    expect(titles([commit(subject, 'We return 400 instead of 500 because clients retry on a 500 and flood the server.')])).toEqual([subject]);
  });

  it('leaves out an English fix whose body only describes the bug', () => {
    expect(titles([commit('fix(parser): handle empty header list', 'The parser threw a NullPointerException when the header list was empty and the request had no body at all.')])).toEqual([]);
  });
});

describe('a body that adds nothing keeps nothing', () => {
  it.each([
    ['fix: corregir el refresco del token', 'Fixes #123'],
    ['docs(gotchas): escalar gotchas', 'Signed-off-by: Ada <ada@x.dev>\nCo-authored-by: Bo <bo@x.dev>'],
    ['fix(auth): corregir el refresco del token', 'fix(auth): corregir el refresco del token'],
    ['fix: corregir el refresco del token', ''],
    ['fix: corregir el refresco del token', 'Merge pull request #12 from a/b'],
    ['fix: replace File.new* into new cactoos primitives', 'Relates: #894\n\nBy Arsen Galiev, Innopolis University student (a.galiev@innopolis.university), COOP course 2025.'],
    ['fix: corregir el refresco del token', 'Merge PR #1621: fix: corregir el refresco del token'],
  ])('drops %s with body %j', (subject, body) => {
    expect(titles([commit(subject, body)])).toEqual([]);
  });
});

describe('an issue-number prefix does not hide a bump or a fix', () => {
  const body = 'We moved the lints package forward because the new release is the only one that the build can resolve today.';
  it.each([
    '#10073: bump lints from 0.5.0 to 0.6.0 (eo#10074)',
    'chore(#10073): bump lints from 0.5.0 to 0.6.0',
    'bug(#10058): bump the parser from 1.2 to 1.3',
  ])('drops %s', (subject) => {
    expect(titles([commit(subject, body)])).toEqual([]);
  });

  it.each([
    ['#10066: name every scope filler x', 'We name the filler because the old name collided with the closed-object test and broke the dealpha pass.'],
    ['bug(#10058): name the argument of T message', 'The message printed the wrong argument because the lookup used the position and not the name of the parameter.'],
    ['fix(#9858): preserve long tuple diagnostic', 'The diagnostic was cut so that users saw only the first element of the tuple and never the rest of it.'],
  ])('leaves out the cause-only fix %s', (subject, b) => {
    expect(titles([commit(subject, b)])).toEqual([]);
  });

  it.each([
    ['#10066: stop rewriting closed objects', 'We rewrite them lazily rather than eagerly because the eager pass doubled the compile time on large programs.'],
    ['fix(#9858): keep the tuple diagnostic whole', 'We decided to print every element, since a partial list hides the failing one from the reader of the log.'],
  ])('keeps the fix %s whose body states a choice', (subject, b) => {
    expect(titles([commit(subject, b)])).toEqual([subject]);
  });
});

describe('a fix is not a choice because its code says "instead of"', () => {
  it('leaves out a squashed fix whose sub-commit prose swaps one call for another', () => {
    const subject = '#10064: name the voids of every tuple callback (#10065)';
    const body = '* #10064: name eq of every data object\n\ntuple.eq takes b like the eq of bytes and number, printf asks the bytes datum for as-bool instead of arg, so dealpha names them.';
    expect(titles([commit(subject, body)])).toEqual([]);
  });

  it('prints the sentence that holds the choice, not a neighbour', () => {
    const subject = 'fix(#9858): keep the tuple diagnostic whole';
    const body = 'The old text was cut at the first element. We decided to print every element, since a partial list hides the failing one.';
    expect(selectForFile([commit(subject, body)], 30).decisions[0]!.reason).toMatch(/^We decided to print every element/);
  });

  it('never prints a session trailer as the reason', () => {
    const body = 'Claude-Session: https://claude.ai/code/session_01KxxhHGabeLVtGno9KWZJ4D\n\nSe cambia la tubería porque el equipo decidió dejar de usar la versión anterior que nadie mantiene.';
    const reason = selectForFile([commit('Use pipes instead of sockets', body)], 30).decisions[0]!.reason;
    expect(reason).toMatch(/^Se cambia la tubería/);
  });
});

describe('the file ranks a stated reason first, then subject-word decisions, then recency', () => {
  it('lists a newer body-stated choice before an older subject-word decision that gives no reason', () => {
    const old = { ...commit('Use https instead of http for the maven repository'), decided_at: '2020-01-01T00:00:00Z' };
    const fresh = { ...commit('feat: add session cache', 'We keep the session in memory for five minutes because the dashboard polls every second.'), decided_at: '2026-11-01T00:00:00Z' };
    const { decisions } = selectForFile([fresh, old] as never[], 30);
    expect(decisions.map((d) => d.title)).toEqual(['add session cache', 'Use https instead of http for the maven repository']);
  });
});

describe('merge commits, English reverts and Chinese', () => {
  it.each([
    ['Merge pull request #1 from a/b', 'We must always prefer the cache because the database is slow under load for us.'],
    ['Merge branch main into feature', 'We must always prefer the cache because the database is slow under load for us.'],
    ['revert: use the cache', 'We must always prefer the cache because the database is slow under load for us.'],
  ])('drops %s', (subject, body) => {
    expect(titles([commit(subject, body)])).toEqual([]);
  });

  it('keeps a Chinese body: no spaces between words, so characters are counted', () => {
    const subject = 'fix: 修复会话刷新';
    expect(titles([commit(subject, '因为客户端会重复发送请求，所以我们改为在服务端去重，避免会话被锁定。')])).toEqual([subject]);
  });
});

describe('the existing filters hold when a body is present', () => {
  const body = 'Se cambia porque el equipo decidió dejar de usar la versión anterior ya que nadie la mantiene desde hace años.';
  it.each([
    'Bump lodash from 4.17.20 to 4.17.21',
    'chore(deps): update dependency vite to v6.0.1',
    'Revert "fix(auth): corregir el refresco del token"',
    'test: ampliar la cobertura de TkMeasured',
    'ci: cachear las dependencias del pipeline',
    'chore: limpiar el directorio de scripts',
  ])('still drops %s', (subject) => {
    expect(titles([commit(subject, body)])).toEqual([]);
  });

  it('still drops a dependency bump whose body is release notes', () => {
    expect(titles([commit('Update lodash to 4.17.21', 'Bumps lodash from 4.17.20 to 4.17.21.\nRelease notes\nSourced from lodash releases.\nThis fixes several issues in the object helpers.')])).toEqual([]);
  });

  it('drops a plain-subject commit whose body is a dependency release note', () => {
    expect(titles([commit('Modernise the XML stack', 'Bumps xml-apis from 1.4.01 to 1.4.02.\nThe release notes say callers must now pass a charset to every parser they build.')])).toEqual([]);
  });

  it('keeps a subject-only decision and a chat row as before', () => {
    const chat = { title: 'We pick Postgres', platform: 'slack' };
    expect(titles([commit('Use https instead of http for the maven repository'), chat])).toEqual(['Use https instead of http for the maven repository', 'We pick Postgres']);
  });
});

describe('the file prints the stated reason under the decision', () => {
  it('prints the author\'s own words for a Spanish body, and a causal clause for an English one', () => {
    const es = commit('docs(gotchas): escalar 3 gotchas de SPEC-67', 'Se promueven a la lista fija para que el agente los vea en cada sesión, ya que repetía el mismo error.');
    const en = commit('feat: add session cache', 'We keep the session in memory for five minutes because the dashboard polls every second.');
    const { decisions } = selectForFile([es, en], 30);
    expect(decisions.map((d) => d.reason)).toEqual([
      expect.stringContaining('Se promueven a la lista fija'),
      expect.stringContaining('because the dashboard polls every second'),
    ]);
    const file = renderDecisionsFile(decisions, { leftOut: 0 });
    expect(file).toMatch(/\n {2}Why: Se promueven a la lista fija/);
    expect(file).toMatch(/\n {2}Why: .*because the dashboard polls/);
  });

  it('caps a long Spanish reason at a word boundary', () => {
    const body = `${'Se promueve a la lista fija porque el agente repetía el mismo error cada semana en distintas sesiones y proyectos '.repeat(4)}`;
    const reason = selectForFile([commit('docs: escalar gotchas del proyecto', body)], 30).decisions[0]!.reason!;
    expect(reason.length).toBeLessThanOrEqual(183);
    expect(reason.endsWith('...')).toBe(true);
  });
});

describe('review round: what counts as an echo, a word, a block, a merge', () => {
  it('keeps a Chinese explanation under a Chinese subject (the echo test must not erase non-ASCII)', () => {
    const subject = '修复刷新';
    expect(titles([commit(subject, '因为客户端会重复发送请求，所以我们改为在服务端去重，避免会话被锁定。')])).toEqual([subject]);
  });

  it('counts a Chinese bullet by character, so it is prose', () => {
    const subject = 'fix: 修复会话刷新';
    expect(titles([commit(subject, '- 因为客户端会重复发送请求，所以我们改为在服务端去重，避免会话被锁定。')])).toEqual([subject]);
  });

  it('keeps an explanation that contains the subject words', () => {
    const subject = 'Cache sessions';
    expect(titles([commit(subject, 'We decided to cache sessions because the database cannot handle repeated requests.')])).toEqual([subject]);
  });

  it('keeps a body whose first line states the choice and starts with the title', () => {
    const row = { title: 'Add cache', platform: 'git', summary: 'Add cache rather than querying the database on each request of the dashboard.', source_url: 'https://github.com/o/r/commit/99' };
    expect(titles([row])).toEqual(['Add cache']);
  });

  it('still drops a body that only repeats the subject', () => {
    expect(titles([commit('Add cache for the session store', 'Add cache for the session store')])).toEqual([]);
  });

  it('does not take a fenced block or an HTML comment for prose', () => {
    const fenced = '```\nWe must always prefer the cache for the current session.\n```';
    const hidden = '<!-- We must always prefer the cache for the current session. -->';
    expect(titles([commit('feat: tune the session store', fenced), commit('feat: tune the session store again', hidden)])).toEqual([]);
  });

  it('keeps prose that sits outside a fenced block', () => {
    const subject = 'Tune the session store';
    expect(titles([commit(subject, '```\ncode here\n```\n\nWe decided to keep sessions in memory because the dashboard polls every second.')])).toEqual([subject]);
  });

  it('drops a merge commit even when its subject holds a decision word', () => {
    expect(titles([commit("Merge branch 'policy' into main")])).toEqual([]);
  });
});
