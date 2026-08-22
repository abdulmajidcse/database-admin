/**
 * The export dialog's destination logic (PLAN §7.1).
 *
 * Pulled out of the component because it decides what artifact the user
 * receives, and every way of getting it wrong is silent: a .zip when a .csv was
 * asked for, a directory named `mydb.sql`, a one-table export written as a
 * folder. None of those fail loudly at the point of the mistake.
 */

import { describe, expect, it } from 'vitest';

import { exportDestination, destinationProblems, splitsPerTable } from './export-plan';

const base = { scope: 'database' as const, format: 'csv' as const, toFile: false, path: '', perTable: true };

describe('splitsPerTable', () => {
  it('splits a whole database exported as CSV', () => {
    expect(splitsPerTable({ scope: 'database', format: 'csv', perTable: true })).toBe(true);
  });

  it('splits a whole database as CSV even if the box was somehow cleared', () => {
    // A combined CSV of many tables is not a readable file at all, so this is
    // not the user's choice to make.
    expect(splitsPerTable({ scope: 'database', format: 'csv', perTable: false })).toBe(true);
  });

  it('leaves the choice alone for a format that holds every table', () => {
    expect(splitsPerTable({ scope: 'database', format: 'sql', perTable: false })).toBe(false);
    expect(splitsPerTable({ scope: 'database', format: 'sql', perTable: true })).toBe(true);
  });

  it('never splits a single-table scope, whatever the box says', () => {
    // The checkbox is only rendered for a database/server scope, so switching
    // back to a table leaves `perTable` on with no control to clear it. Honouring
    // it there hands back a .zip for a one-table CSV export.
    expect(splitsPerTable({ scope: 'table', format: 'csv', perTable: true })).toBe(false);
    expect(splitsPerTable({ scope: 'query', format: 'csv', perTable: true })).toBe(false);
  });
});

describe('exportDestination', () => {
  it('asks for a zip download when a database is split', () => {
    expect(exportDestination(base)).toEqual({ kind: 'download', archive: true });
  });

  it('asks for a plain download for a single table', () => {
    expect(exportDestination({ ...base, scope: 'table' })).toEqual({ kind: 'download' });
  });

  it('asks for a directory when a split export goes to the server', () => {
    expect(exportDestination({ ...base, toFile: true, path: 'dump' })).toEqual({
      kind: 'directory',
      path: 'dump',
    });
  });

  it('asks for a file when a combined export goes to the server', () => {
    expect(exportDestination({ ...base, format: 'sql', perTable: false, toFile: true, path: 'db.sql' })).toEqual({
      kind: 'file',
      path: 'db.sql',
    });
  });
});

describe('destinationProblems', () => {
  it('rejects a directory destination that names a file', () => {
    // Reached by picking `mydb.sql` while the format is SQL, then switching to
    // CSV: the destination silently becomes a directory but the box keeps the
    // filename, and the engine would create a *directory* called mydb.sql.
    expect(destinationProblems({ ...base, toFile: true, path: '/data/exports/mydb.sql' })).toEqual([
      expect.stringMatching(/folder/i),
    ]);
  });

  it('accepts a directory destination that names a folder', () => {
    expect(destinationProblems({ ...base, toFile: true, path: '/data/exports/mydb' })).toEqual([]);
  });

  it('says nothing about a download, which has no path at all', () => {
    expect(destinationProblems({ ...base, path: '/data/exports/mydb.sql' })).toEqual([]);
  });

  it('leaves a combined export free to name a file', () => {
    expect(
      destinationProblems({ ...base, format: 'sql', perTable: false, toFile: true, path: 'db.sql' }),
    ).toEqual([]);
  });
});
