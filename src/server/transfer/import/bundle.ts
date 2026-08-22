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
import { INCOMPLETE_MARKER } from '../incomplete';

/** Extensions that hold delimited rows. `.gz` may wrap any of them. */
const DELIMITED = new Set(['.csv', '.tsv']);

export interface BundleMember {
  /** Absolute path to the file. */
  path: string;
  /** Table it loads into. */
  table: string;
  /**
   * Schema the filename named, when it carried one. Only a fallback: an
   * explicit target schema on the request wins, because the user may be
   * restoring into a different one than they exported from.
   */
  schema?: string;
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

  // Checked before anything else: a directory a failed export marked incomplete
  // holds only some of the tables, and loading it would restore a partial
  // database as though it were whole (../incomplete.ts).
  if (entries.some((e) => e.isFile() && e.name === INCOMPLETE_MARKER)) {
    throw new DbError(
      `${dir} is marked incomplete: the export that wrote it did not finish, so ` +
        'some tables are missing. Re-run the export, or delete ' +
        `${INCOMPLETE_MARKER} to import it anyway.`,
      'INCOMPLETE_BUNDLE',
    );
  }

  const members: BundleMember[] = [];
  const seen = new Map<string, string>();
  const compressed: string[] = [];

  for (const entry of entries) {
    // A symlink to a CSV is a file for our purposes: readdir does not follow
    // links, so `isFile()` is false for one and the member vanished from the
    // import without a word. This module refuses rather than skips for a
    // gzipped member for exactly that reason — dropping a table from a
    // whole-database restore is the failure it exists to prevent.
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (isCompressedData(entry.name)) {
      compressed.push(entry.name);
      continue;
    }
    const parsed = tableNameFor(entry.name);
    if (parsed === null) continue;
    const { table, schema } = parsed;

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
    members.push({ path: path.join(dir, entry.name), table, ...(schema ? { schema } : {}) });
  }

  // Refused, not skipped. The CSV reader opens a plain `createReadStream` with
  // no gunzip stage (./csv.ts), so a `.csv.gz` here would have its gzip magic
  // bytes sniffed as a dialect and its deflate stream parsed as UTF-8 — mojibake
  // rows, or a CREATE TABLE built from binary column names. A directory export
  // with compression on writes exactly these names, so it is reachable straight
  // from our own output. Skipping them instead would silently drop tables from a
  // whole-database import, which is the failure this feature exists to prevent.
  if (compressed.length > 0) {
    throw new DbError(
      `Cannot import compressed files: ${compressed.sort().join(', ')}. ` +
        'A bundle import reads plain CSV/TSV — decompress the folder first, or ' +
        're-export it without gzip.',
      'COMPRESSED_BUNDLE',
    );
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

/** A compressed delimited file — `users.csv.gz`, `orders.tsv.zst`. */
function isCompressedData(filename: string): boolean {
  const lower = filename.toLowerCase();
  const wrapper = path.extname(lower);
  if (wrapper !== '.gz' && wrapper !== '.zst' && wrapper !== '.bz2') return false;
  return DELIMITED.has(path.extname(lower.slice(0, -wrapper.length)));
}

/**
 * `users.csv` is the table `users`; `public.users.csv` is `users` in `public`;
 * `a.md` is nothing.
 *
 * The qualified form is what a whole-database export writes whenever the engine
 * reports a schema — the source is labelled `public.users` and the stem keeps
 * the dot. Reading the stem whole produced a table literally called
 * "public.users", so the export/import round trip only worked on SQLite.
 *
 * The last dot separates, which is ambiguous for a table whose name genuinely
 * contains one. That case loses nothing important: the schema is a fallback the
 * request can override, and the alternative — never splitting — breaks the
 * common case on two of the three SQL engines.
 */
function tableNameFor(filename: string): { table: string; schema?: string } | null {
  const ext = path.extname(filename).toLowerCase();
  if (!DELIMITED.has(ext)) return null;
  const stem = filename.slice(0, -ext.length);
  if (stem === '') return null;

  const cut = stem.lastIndexOf('.');
  if (cut <= 0 || cut === stem.length - 1) return { table: stem };
  return { schema: stem.slice(0, cut), table: stem.slice(cut + 1) };
}

/**
 * What one member overrides on the job's params.
 *
 * Everything table-specific must be cleared here, not inherited: the wizard's
 * `keyColumns` name columns in ONE table, and a forced `csv` dialect cannot fit
 * both the `.csv` and `.tsv` members of the same bundle. Each file sniffs its
 * own dialect and derives its own mapping from its own header — which is what
 * makes fifty heterogeneous files loadable in a single action.
 */
export function bundleMemberOverrides(
  params: {
    target?: { schema?: string; table: string; createTable?: boolean };
    /** Accepted so a caller can pass the job params whole; dropped on purpose. */
    keyColumns?: string[];
    csv?: unknown;
  },
  member: BundleMember,
): {
  source: { kind: 'csv'; path: string };
  target: { schema?: string; table: string; createTable?: boolean };
  mapping: never[];
  keyColumns: undefined;
  csv: undefined;
} {
  return {
    source: { kind: 'csv', path: member.path },
    target: {
      ...params.target,
      table: member.table,
      // An explicit target schema wins: restoring into a different schema than
      // you exported from is a normal thing to want. The filename's schema is
      // the fallback, so a whole-database export lands back where it came from
      // when the user names no target.
      schema: params.target?.schema ?? member.schema,
    },
    mapping: [],
    keyColumns: undefined,
    csv: undefined,
  };
}
