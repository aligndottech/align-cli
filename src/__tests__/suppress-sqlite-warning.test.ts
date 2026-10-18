import { describe, expect, it, vi } from 'vitest';
import { installSqliteWarningFilter } from '../lib/suppress-sqlite-warning.js';

/**
 * ALI-1779: Node 22.16 prints "ExperimentalWarning: SQLite is an experimental feature" on
 * every command because the local graph uses node:sqlite. Only that one warning is dropped.
 */
function fakeProcess() {
  const seen: unknown[][] = [];
  const proc = { emitWarning: ((...a: unknown[]) => { seen.push(a); }) as (...a: unknown[]) => void };
  return { proc, seen };
}
const SQLITE = 'SQLite is an experimental feature and might change at any time';

describe('installSqliteWarningFilter', () => {
  it.each([
    ['string + type argument', [SQLITE, 'ExperimentalWarning']],
    ['string + options object', [SQLITE, { type: 'ExperimentalWarning' }]],
    ['an Error named ExperimentalWarning', [Object.assign(new Error(SQLITE), { name: 'ExperimentalWarning' })]],
  ])('drops the SQLite experimental warning: %s', (_n, args) => {
    const { proc, seen } = fakeProcess();
    installSqliteWarningFilter(proc as never);
    (proc.emitWarning as (...a: unknown[]) => void)(...args);
    expect(seen).toHaveLength(0);
  });

  it.each([
    ['another experimental feature', ['Type Stripping is an experimental feature', 'ExperimentalWarning']],
    ['a deprecation that mentions SQLite', ['SQLite call is deprecated', 'DeprecationWarning']],
    ['an Error that is not experimental', [Object.assign(new Error(SQLITE), { name: 'Warning' })]],
  ])('passes through %s untouched', (_n, args) => {
    const { proc, seen } = fakeProcess();
    installSqliteWarningFilter(proc as never);
    (proc.emitWarning as (...a: unknown[]) => void)(...args);
    expect(seen).toEqual([args]);
  });

  it('forwards with the original receiver', () => {
    const fn = vi.fn(function (this: unknown) { return this; });
    const proc = { emitWarning: fn };
    installSqliteWarningFilter(proc as never);
    (proc.emitWarning as (...a: unknown[]) => void)('x', 'Warning');
    expect(fn.mock.contexts[0]).toBe(proc);
  });
});
