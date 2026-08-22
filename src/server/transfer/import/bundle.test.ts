/**
 * Bundle imports — a directory of delimited files loaded as many tables
 * (PLAN §7.1, the import half of the "Schema / database" scope).
 *
 * The directory export writes `users.csv`, `orders.csv`, … and this reads that
 * shape back. Everything interesting happens before a single row is loaded:
 * which files count, what each one is called once it becomes a table, and what
 * happens when two files want the same name.
 */

import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { bundleMemberOverrides, bundleMembers } from './bundle';

/** Build a directory holding `names`, each with a trivial CSV body. */
async function dirWith(names: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dbadmin-bundle-'));
  for (const name of names) {
    await writeFile(path.join(dir, name), 'id,name\n1,x\n');
  }
  return dir;
}

describe('bundleMembers', () => {
  it('turns each delimited file into a target table named after it', async () => {
    const dir = await dirWith(['users.csv', 'orders.csv']);
    const members = await bundleMembers(dir);

    expect(members.map((m) => m.table)).toEqual(['orders', 'users']);
    expect(members.map((m) => path.basename(m.path))).toEqual(['orders.csv', 'users.csv']);
  });

  it('is ordered, so a rerun loads the same tables in the same sequence', async () => {
    const dir = await dirWith(['b.csv', 'a.csv', 'c.csv']);
    expect((await bundleMembers(dir)).map((m) => m.table)).toEqual(['a', 'b', 'c']);
  });

  it('accepts tsv alongside csv', async () => {
    const dir = await dirWith(['users.csv', 'orders.tsv']);
    expect((await bundleMembers(dir)).map((m) => m.table)).toEqual(['orders', 'users']);
  });

  it('ignores files that are not delimited data', async () => {
    // A directory export leaves these behind; loading a README as a table is
    // never what was meant.
    const dir = await dirWith(['users.csv', 'README.md', 'notes.txt', 'dump.sql']);
    expect((await bundleMembers(dir)).map((m) => m.table)).toEqual(['users']);
  });

  it('ignores subdirectories rather than descending into them', async () => {
    const dir = await dirWith(['users.csv']);
    await mkdir(path.join(dir, 'nested'));
    await writeFile(path.join(dir, 'nested', 'deep.csv'), 'id\n1\n');
    expect((await bundleMembers(dir)).map((m) => m.table)).toEqual(['users']);
  });

  it('refuses a gzipped member rather than parsing deflate bytes as text', async () => {
    // The CSV reader has no gunzip stage (import/csv.ts opens a bare
    // createReadStream), so accepting users.csv.gz would sniff a dialect from
    // gzip magic bytes and load mojibake — or, with createTable on, CREATE TABLE
    // from binary column names. A directory export with compression on writes
    // exactly these names, so this is reachable from our own output.
    const dir = await dirWith(['users.csv.gz']);
    await expect(bundleMembers(dir)).rejects.toThrow(/gzip|compress/i);
  });

  it('refuses the whole bundle when only some members are gzipped', async () => {
    // Skipping them instead would silently omit tables from a "whole database"
    // import, which is the failure this feature exists to prevent.
    const dir = await dirWith(['users.csv', 'orders.csv.gz']);
    await expect(bundleMembers(dir)).rejects.toThrow(/orders\.csv\.gz/);
  });

  it('refuses a directory with nothing to load', async () => {
    const dir = await dirWith(['README.md']);
    await expect(bundleMembers(dir)).rejects.toThrow(/no csv/i);
  });

  it('refuses two files that would load into the same table', async () => {
    // users.csv and users.tsv both mean "users"; loading both would silently
    // append one onto the other, which no one asks for on purpose.
    const dir = await dirWith(['users.csv', 'users.tsv']);
    await expect(bundleMembers(dir)).rejects.toThrow(/users/i);
  });
});

describe('bundleMemberOverrides', () => {
  const member = { path: '/data/exports/db/orders.csv', table: 'orders' };

  it('points the member at its own file and table', () => {
    const o = bundleMemberOverrides({ target: { schema: 'public', table: '', createTable: true } }, member);
    expect(o.source).toEqual({ kind: 'csv', path: '/data/exports/db/orders.csv' });
    expect(o.target).toEqual({ schema: 'public', table: 'orders', createTable: true });
  });

  it('clears the mapping so each file derives one from its own header', () => {
    // A single mapping could only ever fit one file in a heterogeneous bundle.
    expect(bundleMemberOverrides({ target: { table: '' } }, member).mapping).toEqual([]);
  });

  it('drops key columns, which name one table and not the rest', () => {
    // Reachable today: the wizard shows "Key columns" for every source kind, so
    // an upsert bundle would use `email` as the conflict key for all 50 tables.
    const o = bundleMemberOverrides({ target: { table: '' }, keyColumns: ['email'] }, member);
    expect(o.keyColumns).toBeUndefined();
  });

  it('drops a forced CSV dialect, which cannot fit both .csv and .tsv members', () => {
    const o = bundleMemberOverrides({ target: { table: '' }, csv: { delimiter: ',' } }, member);
    expect(o.csv).toBeUndefined();
  });
});

describe('bundleMembers and incomplete exports', () => {
  it('refuses a directory a failed export marked incomplete', async () => {
    // Restoring half a database as though it were whole is the failure this
    // whole feature exists to prevent.
    const dir = await mkdtemp(path.join(tmpdir(), 'dbadmin-bundle-'));
    await writeFile(path.join(dir, 'users.csv'), 'id\n1\n');
    await writeFile(path.join(dir, '.dbadmin-incomplete'), 'did not finish\n');
    await expect(bundleMembers(dir)).rejects.toThrow(/did not finish|incomplete/i);
  });
});
