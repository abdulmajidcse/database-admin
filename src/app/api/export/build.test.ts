/**
 * The export request parser (PLAN §7.1 scope levels, §7.2 path confinement).
 *
 * The destination is the part of the contract that decides whether a database
 * export arrives as one file or one file per table, so the kinds it accepts —
 * and the paths it refuses — are worth pinning down.
 */

import { describe, expect, it } from 'vitest';

import { parseExportRequest } from './build';

const base = {
  connectionId: 'c1',
  format: 'csv',
  source: { kind: 'table', table: 'users' },
};

describe('parseExportRequest destinations', () => {
  it('accepts a single-file download', () => {
    const req = parseExportRequest({ ...base, destination: { kind: 'download' } });
    expect(req.destination).toEqual({ kind: 'download' });
  });

  it('accepts a zip download for one file per table', () => {
    const req = parseExportRequest({
      ...base,
      destination: { kind: 'download', archive: true },
    });
    expect(req.destination).toEqual({ kind: 'download', archive: true });
  });

  it('accepts a directory destination', () => {
    const req = parseExportRequest({ ...base, destination: { kind: 'directory', path: 'dump' } });
    expect(req.destination).toEqual({ kind: 'directory', path: 'dump' });
  });

  it('refuses a directory that escapes the export root', () => {
    expect(() =>
      parseExportRequest({ ...base, destination: { kind: 'directory', path: '../../etc' } }),
    ).toThrow(/must stay inside/i);
  });

  it('refuses a directory with no path', () => {
    expect(() => parseExportRequest({ ...base, destination: { kind: 'directory' } })).toThrow(
      /destination path/i,
    );
  });

  it('refuses an unknown destination kind', () => {
    expect(() => parseExportRequest({ ...base, destination: { kind: 'ftp', path: 'x' } })).toThrow(
      /destination.kind/i,
    );
  });
});
