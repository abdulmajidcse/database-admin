/**
 * Foreign-key navigation (docs/roadmap.md M10).
 *
 * The canonical model has carried `foreignKeys` since M1 and nothing consumed
 * them for navigation. This turns them into the two moves people actually make
 * in a grid: follow a key to the row it points at, and find the rows pointing
 * back.
 *
 * Pure — it decides *where to go*, and returns filters rather than SQL. The
 * caller opens a table tab with them, and `sql/filters.ts` turns them into a
 * parameterized WHERE, so a cell value never reaches SQL text (§9).
 */

import type { SchemaModel, TableModel } from '@/lib/schema-model';
import type { ColumnFilter } from '@/server/db/types';
import { cellToText, type Cell } from '@/lib/wire';

/** Somewhere the grid can send you, and the filter that gets you there. */
export interface FkDestination {
  /** Shown in the menu. */
  label: string;
  schema?: string;
  table: string;
  filters: ColumnFilter[];
}

/**
 * Values are matched as text because that is what the filter layer binds. A
 * NULL key has nothing to point at, so a row holding one produces no
 * destination rather than a filter that matches everything.
 */
function filtersFor(columns: string[], values: Cell[]): ColumnFilter[] | null {
  const out: ColumnFilter[] = [];
  for (let i = 0; i < columns.length; i++) {
    const cell = values[i];
    if (cell === null || cell === undefined) return null;
    const text = cellToText(cell, 'base64');
    if (text === null) return null;
    out.push({ column: columns[i], op: 'eq', value: text });
  }
  return out.length > 0 ? out : null;
}

/**
 * Following a key outward: the row's values for a foreign key's local columns
 * identify exactly one row in the referenced table.
 *
 * Every foreign key covering `column` is offered, not just the first — a column
 * can participate in more than one, and picking one silently would be a guess.
 */
export function outgoingFor(
  table: TableModel,
  column: string,
  row: Cell[],
  columnNames: string[],
): FkDestination[] {
  const out: FkDestination[] = [];
  for (const fk of table.foreignKeys) {
    if (!fk.columns.includes(column)) continue;
    const values = fk.columns.map((c) => row[columnNames.indexOf(c)]);
    if (fk.columns.some((c) => columnNames.indexOf(c) === -1)) continue;
    const filters = filtersFor(fk.refColumns, values);
    if (!filters) continue;
    out.push({
      label: `${fk.refTable} (${fk.refColumns.join(', ')})`,
      schema: fk.refSchema,
      table: fk.refTable,
      filters,
    });
  }
  return out;
}

/**
 * Looking inward: every foreign key anywhere in the model that points at this
 * table, turned into a filter on the referencing table.
 *
 * This is the more useful of the two in practice — "what references this
 * customer" is the question you cannot answer without writing SQL today — and
 * it is only possible because the model holds every table, not just this one.
 */
export function incomingFor(
  model: SchemaModel,
  table: TableModel,
  row: Cell[],
  columnNames: string[],
): FkDestination[] {
  const out: FkDestination[] = [];
  for (const ns of model.namespaces) {
    for (const other of ns.tables) {
      for (const fk of other.foreignKeys) {
        if (fk.refTable !== table.name) continue;
        // A same-named table in another schema is a different table.
        if (fk.refSchema !== undefined && table.schema !== undefined && fk.refSchema !== table.schema) {
          continue;
        }
        if (fk.refColumns.some((c) => columnNames.indexOf(c) === -1)) continue;
        const values = fk.refColumns.map((c) => row[columnNames.indexOf(c)]);
        const filters = filtersFor(fk.columns, values);
        if (!filters) continue;
        out.push({
          label: `${other.name} (${fk.columns.join(', ')})`,
          schema: other.schema,
          table: other.name,
          filters,
        });
      }
    }
  }
  return out;
}
