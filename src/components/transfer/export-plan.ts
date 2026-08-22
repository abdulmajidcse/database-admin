/**
 * What artifact an export produces (PLAN §7.1 scope levels).
 *
 * Deliberately not inside the dialog component. Every one of these decisions is
 * silent when it goes wrong — the user gets a .zip instead of a .csv, or a
 * directory named `mydb.sql`, and nothing complains until they open it — so the
 * rules live somewhere they can be tested directly rather than being re-derived
 * from whatever the component's state happens to hold at submit time.
 *
 * Client-safe: types only, no server imports.
 */

import type { ExportFormat, ExportRequest } from '@/lib/api-types';

export type ScopeKind = ExportRequest['source']['kind'];

/** A database or server scope fans out into one source per table. */
export function coversManyTables(scope: ScopeKind): boolean {
  return scope === 'database' || scope === 'server';
}

/**
 * Formats carrying exactly one table per file. SQL concatenates into one script
 * and XLSX opens a sheet per table, so they are absent here.
 */
export function holdsOneTable(format: ExportFormat): boolean {
  return format === 'csv' || format === 'tsv' || format === 'json';
}

/** True when a combined file would not be a readable artifact at all. */
export function mustSplit(scope: ScopeKind, format: ExportFormat): boolean {
  return coversManyTables(scope) && holdsOneTable(format);
}

/**
 * Whether this export writes one file per table.
 *
 * `perTable` is the user's choice, but it is only *meaningful* for a scope that
 * has many tables. The checkbox is rendered only for a database or server scope,
 * so switching back to a single table leaves the flag set with no control on
 * screen to clear it — and honouring it there hands back a .zip containing one
 * CSV to someone who asked for a CSV. Deriving the answer from the scope as well
 * as the flag makes that unreachable regardless of what the component's state
 * does.
 */
export function splitsPerTable(state: {
  scope: ScopeKind;
  format: ExportFormat;
  perTable: boolean;
}): boolean {
  if (!coversManyTables(state.scope)) return false;
  return state.perTable || mustSplit(state.scope, state.format);
}

export interface ExportPlanState {
  scope: ScopeKind;
  format: ExportFormat;
  toFile: boolean;
  path: string;
  perTable: boolean;
  /** Needed here because gzip and a per-table split cannot be combined. */
  gzip?: boolean;
}

export function exportDestination(state: ExportPlanState): ExportRequest['destination'] {
  const split = splitsPerTable(state);
  if (state.toFile) return { kind: split ? 'directory' : 'file', path: state.path };
  return split ? { kind: 'download', archive: true } : { kind: 'download' };
}

/** Extensions that name a data file, so cannot be the folder tables are written into. */
const DATA_FILE = /\.(csv|tsv|json|ndjson|sql|dump|xlsx|md|markdown|html|zip|gz|zst)$/i;

/**
 * A path left over from a different destination shape.
 *
 * The suggested filename is only refreshed while the user has not edited the
 * box, so picking `mydb.sql` and *then* switching the format to CSV turns the
 * destination into a directory while the filename stays. The engine would take
 * that literally and create a directory called `mydb.sql`, or fail with a raw
 * ENOTDIR against an existing file.
 */
export function destinationProblems(state: ExportPlanState): string[] {
  if (!state.toFile) return [];
  const path = state.path.trim();
  if (path === '') return [];
  if (splitsPerTable(state) && DATA_FILE.test(path)) {
    return [
      `One file per table needs a folder to write them into, but "${path}" names a file. ` +
        'Pick a folder, or turn the split off.',
    ];
  }
  return [];
}
