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

import { bundleMembers } from './bundle';

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

  it('strips a gzip suffix so users.csv.gz still targets "users"', async () => {
    const dir = await dirWith(['users.csv.gz']);
    expect((await bundleMembers(dir)).map((m) => m.table)).toEqual(['users']);
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
