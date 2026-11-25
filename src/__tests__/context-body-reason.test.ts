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
