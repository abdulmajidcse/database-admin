'use client';

/**
 * Pending grid edits (PLAN §6 "Grid editing").
 *
 * The grid never writes as you type. Every edit lands here first, as a diff
 * against the rows the server handed us, and only "Apply" turns that diff into
 * a `Changeset` for /api/changeset/preview + /api/changeset/apply.
 *
 * Two rules this module exists to enforce:
 *
 *  1. A row is addressed by its ORIGINAL key values, never the edited ones —
 *     otherwise editing a primary key would build a WHERE clause matching the
 *     row you just invented instead of the row on disk.
 *  2. Typed text becomes a *wire* `Cell` (src/lib/wire.ts), not a JS value.
 *     A BIGINT edited to 9007199254740993 must travel as {$t:'bigint'} or the
 *     round trip through a JS number silently corrupts it — the whole reason
 *     the tagged envelope exists (§6 "Type fidelity").
 */

import * as React from 'react';
import type { ChangeOp, Changeset, ColumnMeta, ResultSet, RowKey } from '../../lib/results';
import { base64ToBytes, isTagged, type Cell, type CellTag, type Row } from '../../lib/wire';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface PendingInsert {
  id: string;
  /**
   * Column *index* → value. Columns the user never touched are absent, so the
   * INSERT omits them and the server default / sequence applies.
   */
  values: Record<number, Cell>;
}

export interface EditState {
  /** row index → column index → new value. */
  updates: Record<number, Record<number, Cell>>;
  /** Row indices struck through, pending DELETE. */
  deletes: Record<number, true>;
  inserts: PendingInsert[];
}

export const EMPTY_EDIT_STATE: EditState = { updates: {}, deletes: {}, inserts: [] };

export type EditAction =
  | { type: 'set-cell'; row: number; col: number; value: Cell; original: Cell }
  | { type: 'revert-cell'; row: number; col: number }
  | { type: 'revert-row'; row: number }
  | { type: 'set-insert-cell'; id: string; col: number; value: Cell }
  | { type: 'add-insert'; id: string }
  | { type: 'remove-insert'; id: string }
  | { type: 'set-deleted'; rows: number[]; deleted: boolean }
  | { type: 'reset' };

let insertSeq = 0;

export function newInsertId(): string {
  insertSeq += 1;
  return `new-${insertSeq}`;
}

export function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case 'set-cell': {
      const row = { ...(state.updates[action.row] ?? {}) };
      // Typing a value back to what it was is not an edit — dropping it keeps
      // the changeset (and the dirty-cell highlight) honest.
      if (cellsEqual(action.value, action.original)) delete row[action.col];
      else row[action.col] = action.value;
      const updates = { ...state.updates };
      if (Object.keys(row).length === 0) delete updates[action.row];
      else updates[action.row] = row;
      return { ...state, updates };
    }

    case 'revert-cell': {
      const row = state.updates[action.row];
      if (!row || !(action.col in row)) return state;
      const next = { ...row };
      delete next[action.col];
      const updates = { ...state.updates };
      if (Object.keys(next).length === 0) delete updates[action.row];
      else updates[action.row] = next;
      return { ...state, updates };
    }

    case 'revert-row': {
      const updates = { ...state.updates };
      delete updates[action.row];
      const deletes = { ...state.deletes };
      delete deletes[action.row];
      return { ...state, updates, deletes };
    }

    case 'set-insert-cell': {
      const inserts = state.inserts.map((ins) =>
        ins.id === action.id ? { ...ins, values: { ...ins.values, [action.col]: action.value } } : ins,
      );
      return { ...state, inserts };
    }

    case 'add-insert':
      return { ...state, inserts: [...state.inserts, { id: action.id, values: {} }] };

    case 'remove-insert':
      return { ...state, inserts: state.inserts.filter((ins) => ins.id !== action.id) };

    case 'set-deleted': {
      const deletes = { ...state.deletes };
      for (const r of action.rows) {
        if (action.deleted) deletes[r] = true;
        else delete deletes[r];
      }
      return { ...state, deletes };
    }

    case 'reset':
      return EMPTY_EDIT_STATE;
  }
}

export function useEditState(): [EditState, React.Dispatch<EditAction>] {
  return React.useReducer(editReducer, EMPTY_EDIT_STATE);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The edited value for a cell, or `undefined` when it is untouched. */
export function editedValue(state: EditState, row: number, col: number): Cell | undefined {
  const r = state.updates[row];
  if (!r) return undefined;
  return col in r ? r[col] : undefined;
}

export function isRowDeleted(state: EditState, row: number): boolean {
  return state.deletes[row] === true;
}

export function pendingCounts(state: EditState): { updates: number; inserts: number; deletes: number; total: number } {
  const updates = Object.keys(state.updates).length;
  const deletes = Object.keys(state.deletes).length;
  const inserts = state.inserts.length;
  return { updates, inserts, deletes, total: updates + inserts + deletes };
}

export function hasPendingEdits(state: EditState): boolean {
  return pendingCounts(state).total > 0;
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  if (a === null || b === null) return a === b;
  if (isTagged(a) || isTagged(b)) {
    if (!isTagged(a) || !isTagged(b)) return false;
    return a.$t === b.$t && a.v === b.v && (a.of ?? '') === (b.of ?? '');
  }
  return a === b;
}

// ---------------------------------------------------------------------------
// Editability (PLAN §6: "require a detectable unique key … the UI says why")
// ---------------------------------------------------------------------------

export interface Editability {
  editable: boolean;
  /** Shown in the toolbar whenever `editable` is false. Never undefined then. */
  reason?: string;
  schema?: string;
  table?: string;
  keyColumns: string[];
  /** Position of each key column inside `result.columns`. */
  keyIndexes: number[];
}

/**
 * `readOnly` is the caller's veto (a connection flagged read-only in §8.5, or a
 * pane that simply does not want editing) and wins over a perfectly good
 * `editTarget`.
 */
export function editabilityOf(
  result: ResultSet,
  override?: { readOnly?: boolean; reason?: string },
): Editability {
  const none = (reason: string): Editability => ({ editable: false, reason, keyColumns: [], keyIndexes: [] });

  if (override?.readOnly) return none(override.reason ?? 'This connection is read-only.');

  const target = result.editTarget;
  if (!target) {
    return none(
      result.readOnlyReason ??
        'This result is not a simple single-table select, so there is no row to write back to.',
    );
  }
  if (target.keyColumns.length === 0) {
    return none(
      result.readOnlyReason ??
        `${target.table} has no primary key or unique index, so a row cannot be addressed unambiguously.`,
    );
  }

  const keyIndexes: number[] = [];
  for (const name of target.keyColumns) {
    const idx = result.columns.findIndex((c) => c.name === name);
    if (idx === -1) {
      return none(`The result does not include the key column "${name}", so rows cannot be addressed.`);
    }
    keyIndexes.push(idx);
  }

  return {
    editable: true,
    schema: target.schema,
    table: target.table,
    keyColumns: [...target.keyColumns],
    keyIndexes,
  };
}

// ---------------------------------------------------------------------------
// Text ⇄ Cell
// ---------------------------------------------------------------------------

export class CellParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CellParseError';
  }
}

/** What the inline editor starts with. NULL opens empty; the null flag is separate. */
export function cellToEditText(cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  if (typeof cell === 'number') return String(cell);
  if (typeof cell === 'string') return cell;
  // Binary is edited as base64 — the same lossless text the wire carries.
  return cell.v;
}

const INTEGER_TEXT = /^[-+]?\d+$/;
const NUMBER_TEXT = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', 'off', '0']);

/** Base tag for a column type, for values the driver would have tagged on read. */
function tagForBase(base: ColumnMeta['base']): CellTag | null {
  switch (base) {
    case 'bigint':
      return 'bigint';
    case 'decimal':
    case 'money':
      return 'decimal';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'timestamp':
      return 'timestamp';
    case 'interval':
      return 'interval';
    case 'json':
      return 'json';
    case 'uuid':
      return 'uuid';
    case 'array':
      return 'array';
    case 'bit':
      return 'bit';
    case 'binary':
      return 'bytes';
    case 'geometry':
      return 'geo';
    case 'objectid':
      return 'objectid';
    default:
      return null;
  }
}

function assertBase64(text: string): string {
  const trimmed = text.replace(/\s+/g, '');
  if (!BASE64_TEXT.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new CellParseError('Binary cells are edited as base64; that text is not valid base64.');
  }
  try {
    base64ToBytes(trimmed);
  } catch {
    throw new CellParseError('Binary cells are edited as base64; that text is not valid base64.');
  }
  return trimmed;
}

/**
 * Turn what the user typed into a wire `Cell`.
 *
 * `previous` matters more than the column type: a cell that arrived tagged
 * `timestamptz` goes back tagged `timestamptz`, because the connector chose
 * that tag knowing the real column type, and `ColumnMeta.base` collapses both
 * timestamp flavours into one family.
 *
 * PLAN §6 / SQLite trap 2: for a `dynamicType` column the type comes from the
 * TEXT THE USER TYPED, not from the column, because the next row down may well
 * hold something else entirely.
 */
export function parseCellInput(text: string, column: ColumnMeta, previous: Cell | undefined): Cell {
  if (previous !== undefined && previous !== null && isTagged(previous)) {
    if (previous.$t === 'unsupported') {
      throw new CellParseError(
        'This value was not decoded losslessly, so writing it back would corrupt it.',
      );
    }
    if (previous.$t === 'bytes') return { $t: 'bytes', v: assertBase64(text) };
    return previous.of === undefined
      ? { $t: previous.$t, v: text }
      : { $t: previous.$t, v: text, of: previous.of };
  }

  if (column.dynamicType) {
    const t = text.trim();
    if (t !== '' && INTEGER_TEXT.test(t) && Number.isSafeInteger(Number(t))) return Number(t);
    if (t !== '' && NUMBER_TEXT.test(t)) return Number(t);
    return text;
  }

  switch (column.base) {
    case 'boolean': {
      const t = text.trim().toLowerCase();
      if (TRUE_WORDS.has(t)) return true;
      if (FALSE_WORDS.has(t)) return false;
      throw new CellParseError(`"${text}" is not a boolean — use true or false.`);
    }

    case 'integer':
    case 'float': {
      const t = text.trim();
      if (!NUMBER_TEXT.test(t)) throw new CellParseError(`"${text}" is not a number.`);
      const n = Number(t);
      if (!Number.isFinite(n)) throw new CellParseError(`"${text}" is not a finite number.`);
      // An integer beyond 2^53 must not become a float; hand it over as the
      // lossless text and let the engine's input function take it (§6).
      if (column.base === 'integer' && !Number.isSafeInteger(n)) return { $t: 'bigint', v: t };
      return n;
    }

    default: {
      const t = tagForBase(column.base);
      if (t === 'bytes') return { $t: 'bytes', v: assertBase64(text) };
      if (t) return { $t: t, v: t === 'bigint' || t === 'decimal' ? text.trim() : text };
      return text;
    }
  }
}

// ---------------------------------------------------------------------------
// Changeset assembly
// ---------------------------------------------------------------------------

export interface ChangesetDraft {
  changeset: Changeset | null;
  /** Why there is nothing to send, or what would be dropped. */
  problems: string[];
  counts: { updates: number; inserts: number; deletes: number };
}

/**
 * Statement order is deliberate: UPDATEs first (they still reference rows that
 * exist), then INSERTs, then DELETEs last so nothing updates a row that an
 * earlier statement already removed. Rows marked for deletion drop their cell
 * edits entirely — an UPDATE followed by a DELETE of the same row is pure noise
 * in the preview pane.
 */
export function buildChangeset(
  state: EditState,
  columns: ColumnMeta[],
  rows: Row[],
  ed: Editability,
): ChangesetDraft {
  const counts = { updates: 0, inserts: 0, deletes: 0 };
  if (!ed.editable || !ed.table) {
    return { changeset: null, problems: [ed.reason ?? 'This result is read-only.'], counts };
  }

  const problems: string[] = [];
  const changes: ChangeOp[] = [];

  const keyOf = (rowIndex: number): RowKey | null => {
    const row = rows[rowIndex];
    if (!row) return null;
    const key: RowKey = {};
    for (let i = 0; i < ed.keyIndexes.length; i++) {
      // The ORIGINAL row, never the edited one: this has to address the row as
      // it exists on the server.
      key[ed.keyColumns[i]] = row[ed.keyIndexes[i]];
    }
    return key;
  };

  for (const rowKey of Object.keys(state.updates)) {
    const rowIndex = Number(rowKey);
    if (state.deletes[rowIndex]) continue;
    const edits = state.updates[rowIndex];
    const key = keyOf(rowIndex);
    if (!key) {
      problems.push(`Row ${rowIndex + 1} is no longer loaded, so its edit was dropped.`);
      continue;
    }
    const values: Record<string, Cell> = {};
    for (const colKey of Object.keys(edits)) {
      const colIndex = Number(colKey);
      const col = columns[colIndex];
      if (!col) continue;
      values[col.name] = edits[colIndex];
    }
    if (Object.keys(values).length === 0) continue;
    changes.push({ op: 'update', key, values });
    counts.updates += 1;
  }

  for (const ins of state.inserts) {
    const values: Record<string, Cell> = {};
    for (const colKey of Object.keys(ins.values)) {
      const colIndex = Number(colKey);
      const col = columns[colIndex];
      if (!col) continue;
      values[col.name] = ins.values[colIndex];
    }
    if (Object.keys(values).length === 0) {
      problems.push('An added row has no values yet and was skipped.');
      continue;
    }
    changes.push({ op: 'insert', values });
    counts.inserts += 1;
  }

  for (const rowKey of Object.keys(state.deletes)) {
    const rowIndex = Number(rowKey);
    const key = keyOf(rowIndex);
    if (!key) {
      problems.push(`Row ${rowIndex + 1} is no longer loaded, so its deletion was dropped.`);
      continue;
    }
    changes.push({ op: 'delete', key });
    counts.deletes += 1;
  }

  if (changes.length === 0) {
    if (problems.length === 0) problems.push('There is nothing to apply.');
    return { changeset: null, problems, counts };
  }

  return {
    changeset: { schema: ed.schema, table: ed.table, keyColumns: ed.keyColumns, changes },
    problems,
    counts,
  };
}
