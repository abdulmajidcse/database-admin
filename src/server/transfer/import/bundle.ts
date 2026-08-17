/**
 * Bundle imports: a directory of delimited files loaded as many tables
 * (PLAN §7.1 — the import half of the "Schema / database" scope).
 *
 * This is the mirror of the directory export. That side writes `users.csv`,
 * `orders.csv`, … one per table; this side reads the same directory back and
 * loads each file into the table its name implies. A single CSV can only ever
 * describe one table, so a set of them is the only honest way to move fifty
 * tables through a format that carries one header per file.
 *
 * A downloaded .zip has to be unpacked into the import root first: reading zip
 * members would mean a zip *reader* dependency, and the server-side transfer
 * paths are directory-based on both sides already.
 *
 * Server-side only: no React, no Next (§11).
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { DbError } from '../../db/types';

/** Extensions that hold delimited rows. `.gz` may wrap any of them. */
const DELIMITED = new Set(['.csv', '.tsv']);

export interface BundleMember {
  /** Absolute path to the file. */
  path: string;
  /** Table it loads into — the file's name with its extensions removed. */
  table: string;
}

/**
 * The files in `dir` that hold table data, in a stable order, one per table.
 *
 * Sorted so a rerun replays in the same sequence: with foreign keys in play the
 * order decides which loads succeed, and a directory listing is not ordered by
 * itself. Subdirectories are skipped rather than walked — a nested directory in
 * an export root is somebody else's export, not part of this one.
 */
export async function bundleMembers(dir: string): Promise<BundleMember[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  const members: BundleMember[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const table = tableNameFor(entry.name);
    if (table === null) continue;

    const previous = seen.get(table);
    if (previous !== undefined) {
      // Loading both would append one file onto the other under a single name,
      // which is never deliberate — and with `truncate` on, the second would
      // quietly discard the first.
      throw new DbError(
        `"${previous}" and "${entry.name}" would both load into the table "${table}". ` +
          'Rename one, or move it out of the directory.',
        'BUNDLE_CONFLICT',
      );
    }
    seen.set(table, entry.name);
    members.push({ path: path.join(dir, entry.name), table });
  }

  if (members.length === 0) {
    throw new DbError(
      `No CSV or TSV files in ${dir}. A bundle import loads one file per table, ` +
        'so point it at a directory an export wrote.',
      'EMPTY_BUNDLE',
    );
  }

  members.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
  return members;
}

/** `users.csv` and `users.csv.gz` both mean the table `users`; `a.md` means nothing. */
function tableNameFor(filename: string): string | null {
  let stem = filename;
  if (path.extname(stem).toLowerCase() === '.gz') stem = stem.slice(0, -3);
  const ext = path.extname(stem).toLowerCase();
  if (!DELIMITED.has(ext)) return null;
  const table = stem.slice(0, -ext.length);
  return table === '' ? null : table;
}
