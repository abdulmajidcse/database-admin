'use client';

/**
 * The results grid (PLAN §6).
 *
 * Rows AND columns are virtualized with @tanstack/react-virtual — the plan's
 * documented fallback for Glide Data Grid, which has no React 19 build. A wide
 * result (200 columns of a catalog view) is as common as a tall one, so both
 * axes matter; only the visible window is ever in the DOM.
 *
 * Layout, because it is not obvious from the JSX alone: one scroll container
 * drives both virtualizers. Inside it, the header is `position: sticky; top: 0`
 * and spans the full virtual width, so horizontal scrolling moves it for free.
 * Rows are absolutely positioned with `top` (never `transform` — a transformed
 * ancestor would break the sticky row-number gutter), and the gutter is the one
 * in-flow child of each row with `position: sticky; left: 0`.
 *
 * Paging never loads everything (§6 "Big results"): the result carries
 * `truncated` + `cursorId` and "Fetch more" advances the server-side cursor via
 * POST /api/query/more. Offset paging (the table tab) comes in through `paging`.
 *
 * Editing is off unless `ResultSet.editTarget` is set; when it is not, the
 * toolbar states `readOnlyReason` so the user knows why the grid will not let
 * them type.
 */

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  CircleSlash2,
  Clipboard,
  KeyRound,
  ListX,
  Lock,
  Maximize2,
  PanelRight,
  Play,
  Plus,
  Rows3,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api-client';
import type { FetchMoreResponse } from '../../lib/api-types';
import type { ColumnMeta, ResultSet } from '../../lib/results';
import { cellToText, type Cell, type Row } from '../../lib/wire';
import { renderInsertRows, renderUpdateRow } from '../../server/db/sql/dml';
import { useConnections } from '../shell/connection-sidebar';
import { useSchema } from '../../hooks/use-schema';
import { useWorkspaceStore } from '../../state/workspace-store';
import { findTable } from '../../lib/schema-model';
import { incomingFor, outgoingFor, type FkDestination } from './fk-navigation';
import { Badge, Button, EmptyState, Separator, Spinner, Toolbar, cn } from '../ui/primitives';
import { CellEditor, GridCell, alignsRight } from './cell';
import { CellViewer } from './cell-viewer';
import { ChangesetDialog } from './changeset-dialog';
import { RowDetail } from './row-detail';
import {
  CellParseError,
  buildChangeset,
  cellToEditText,
  editabilityOf,
  editedValue,
  isRowDeleted,
  newInsertId,
  parseCellInput,
  pendingCounts,
  useEditState,
} from './edit-state';

const ROW_H = 22;
const HEADER_H = 26;
const MIN_COL_W = 56;
const MAX_AUTOFIT_W = 480;
/** Rows pulled per "Fetch more"; the server clamps to its own adaptive size. */
const FETCH_MORE_COUNT = 500;
/** Sampled when auto-fitting a column — measuring 100k rows is not free. */
const AUTOFIT_SAMPLE = 300;

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export interface GridPaging {
  offset: number;
  pageSize: number;
  total?: number;
  estimated?: boolean;
  loading?: boolean;
  onOffsetChange: (offset: number) => void;
}

export interface DataGridProps {
  result: ResultSet;
  connectionId: string;
  className?: string;
  /** Rendered between the toolbar and the grid — the table tab drops <FilterBar/> here. */
  filterBar?: React.ReactNode;
  /** Extra toolbar controls (export, refresh…), right-aligned. */
  toolbarExtra?: React.ReactNode;
  /** Server-side sort. Providing `onSortChange` makes the headers clickable. */
  sort?: SortSpec[];
  onSortChange?: (sort: SortSpec[]) => void;
  /** Offset paging. Without it the grid uses the result's cursor. */
  paging?: GridPaging;
  /** Veto editing even when the result declares an edit target. */
  readOnly?: boolean;
  readOnlyReason?: string;
  /** Applied row count, after a changeset committed. Refetch here. */
  onApplied?: (applied: number) => void;
}

interface Point {
  /** Visual row: existing rows first, then pending inserts. */
  r: number;
  /** Position in the (reorderable) column order, not the data index. */
  c: number;
}

interface CellRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

function rangeOf(sel: { a: Point; f: Point }): CellRange {
  return {
    r0: Math.min(sel.a.r, sel.f.r),
    r1: Math.max(sel.a.r, sel.f.r),
    c0: Math.min(sel.a.c, sel.f.c),
    c1: Math.max(sel.a.c, sel.f.c),
  };
}

function columnSignature(columns: ColumnMeta[]): string {
  return columns.map((c) => `${c.name}\u0000${c.typeName}`).join('\u0001');
}

const WIDE_BASES = new Set<ColumnMeta['base']>(['text', 'json', 'array', 'xml', 'document', 'geometry']);

function defaultWidth(col: ColumnMeta): number {
  const header = col.name.length * 7 + 44;
  if (col.base === 'boolean') return Math.max(72, Math.min(header, 110));
  if (col.base === 'uuid') return 280;
  if (col.base === 'timestamp' || col.base === 'date' || col.base === 'time') return Math.max(header, 170);
  if (WIDE_BASES.has(col.base)) return 260;
  return Math.max(90, Math.min(header, 220));
}

/** Excel/DataGrip-compatible TSV: quote anything that would break the shape. */
/** Clipboard formats the grid can produce (docs/roadmap.md M10). */
export type CopyFormat = 'tsv' | 'tsv-header' | 'csv' | 'json' | 'markdown' | 'insert' | 'update';

const COPY_ITEMS: { format: CopyFormat; label: string }[] = [
  { format: 'tsv-header', label: 'Copy with header' },
  { format: 'csv', label: 'Copy as CSV' },
  { format: 'json', label: 'Copy as JSON' },
  { format: 'markdown', label: 'Copy as Markdown' },
  { format: 'insert', label: 'Copy as INSERT' },
  { format: 'update', label: 'Copy as UPDATE' },
];

/** RFC 4180: quote when the value carries a delimiter, quote or newline. */
function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.split('"').join('""')}"` : value;
}

function tsvEscape(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.split('"').join('""')}"` : value;
}

const numberFmt = new Intl.NumberFormat();

// ---------------------------------------------------------------------------
// Cursor lifetime. A cursor holds a pooled connection open, so it is released
// when the grid goes away — deferred, because React StrictMode mounts every
// component twice in development and a straight close would kill the cursor of
// the instance that survives.
// ---------------------------------------------------------------------------

const pendingCursorClose = new Map<string, ReturnType<typeof setTimeout>>();

function keepCursor(connectionId: string, cursorId: string): void {
  const key = `${connectionId}|${cursorId}`;
  const timer = pendingCursorClose.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingCursorClose.delete(key);
  }
}

function releaseCursor(connectionId: string, cursorId: string): void {
  const key = `${connectionId}|${cursorId}`;
  keepCursor(connectionId, cursorId);
  pendingCursorClose.set(
    key,
    setTimeout(() => {
      pendingCursorClose.delete(key);
      void api.del('/api/query/more', { connectionId, cursorId }).catch(() => {
        // The cursor may already be gone with its connection; nothing to do.
      });
    }, 1000),
  );
}

// ---------------------------------------------------------------------------

export function DataGrid({
  result,
  connectionId,
  className,
  filterBar,
  toolbarExtra,
  sort,
  onSortChange,
  paging,
  readOnly,
  readOnlyReason,
  onApplied,
}: DataGridProps) {
  const columns = result.columns;
  // Resolved from the connection rather than passed in: two of the three call
  // sites have no engine to hand, and one of them is Mongo, which has no SQL
  // dialect at all. Undefined disables the SQL copy formats rather than
  // guessing a quoting style.
  const connections = useConnections();
  const engine = connections.data?.connections.find((c) => c.id === connectionId)?.engine;
  // Foreign keys come from the introspected model, which is cached — this adds
  // no round trip to opening a grid.
  const schema = useSchema(connectionId, { enabled: true });

  const [edit, dispatch] = useEditState();
  const [extraRows, setExtraRows] = React.useState<Row[]>([]);
  const [cursor, setCursor] = React.useState<{ id?: string; truncated: boolean }>({
    id: result.cursorId,
    truncated: result.truncated,
  });
  const [fetching, setFetching] = React.useState(false);
  const [sel, setSel] = React.useState<{ a: Point; f: Point } | null>(null);
  const [editingAt, setEditingAt] = React.useState<Point | null>(null);
  /** Set when typing a printable key opened the editor: that character IS the edit. */
  const [editSeed, setEditSeed] = React.useState<string | null>(null);
  const [viewerAt, setViewerAt] = React.useState<Point | null>(null);
  const [copyMenuOpen, setCopyMenuOpen] = React.useState(false);
  const [ctx, setCtx] = React.useState<{ x: number; y: number; point: Point } | null>(null);
  const [detailRow, setDetailRow] = React.useState<number | null>(null);
  const [changesetOpen, setChangesetOpen] = React.useState(false);
  const [widths, setWidths] = React.useState<Record<string, number>>(() => initialWidths(columns));
  const [order, setOrder] = React.useState<number[]>(() => columns.map((_, i) => i));
  const [colSig, setColSig] = React.useState(() => columnSignature(columns));
  const [dragOver, setDragOver] = React.useState<number | null>(null);
  const [resizing, setResizing] = React.useState(false);

  // A new ResultSet is a new grid: drop appended rows, selection and — most
  // importantly — pending edits, which belong to rows that no longer exist.
  // Keyed structurally rather than by identity, so a parent that rebuilds the
  // props object on every render does not silently throw the user's edits away.
  const resultKey = `${result.statement}\u0000${result.columns.length}\u0000${result.rows.length}\u0000${result.durationMs}\u0000${result.cursorId ?? ''}\u0000${result.editTarget?.table ?? ''}`;
  const [seenResult, setSeenResult] = React.useState(resultKey);
  if (seenResult !== resultKey) {
    setSeenResult(resultKey);
    setExtraRows([]);
    setCursor({ id: result.cursorId, truncated: result.truncated });
    setSel(null);
    setEditingAt(null);
    setViewerAt(null);
    setDetailRow(null);
    dispatch({ type: 'reset' });
    const sig = columnSignature(result.columns);
    if (sig !== colSig) {
      // Same columns (a re-read of the same table) keeps the user's widths and
      // column order; a different shape starts fresh.
      setColSig(sig);
      setWidths(initialWidths(result.columns));
      setOrder(result.columns.map((_, i) => i));
    }
  }

  const rows = React.useMemo(
    () => (extraRows.length === 0 ? result.rows : [...result.rows, ...extraRows]),
    [result.rows, extraRows],
  );

  const editability = React.useMemo(
    () => editabilityOf(result, { readOnly, reason: readOnlyReason }),
    [result, readOnly, readOnlyReason],
  );
  const editable = editability.editable;

  const visualRowCount = rows.length + edit.inserts.length;
  const rowOffset = paging?.offset ?? 0;

  // --- values ---------------------------------------------------------------

  const originalAt = React.useCallback(
    (vr: number, dataCol: number): Cell | undefined => (vr < rows.length ? rows[vr][dataCol] : undefined),
    [rows],
  );

  const valueAt = React.useCallback(
    (vr: number, dataCol: number): Cell => {
      if (vr >= rows.length) {
        const ins = edit.inserts[vr - rows.length];
        const v = ins ? ins.values[dataCol] : undefined;
        return v === undefined ? null : v;
      }
      const e = editedValue(edit, vr, dataCol);
      return e === undefined ? rows[vr][dataCol] : e;
    },
    [rows, edit],
  );

  const isDirtyAt = React.useCallback(
    (vr: number, dataCol: number): boolean => {
      if (vr >= rows.length) {
        const ins = edit.inserts[vr - rows.length];
        return !!ins && dataCol in ins.values;
      }
      return editedValue(edit, vr, dataCol) !== undefined;
    },
    [rows.length, edit],
  );

  // --- virtualizers ---------------------------------------------------------

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const widthsRef = React.useRef(widths);
  widthsRef.current = widths;
  const orderRef = React.useRef(order);
  orderRef.current = order;

  const gutterW = Math.max(46, 20 + String(rowOffset + visualRowCount).length * 8);

  const widthOf = React.useCallback(
    (dataCol: number) => widthsRef.current[widthKey(dataCol, columns)] ?? 140,
    [columns],
  );

  const rowVirtualizer = useVirtualizer({
    count: visualRowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 16,
  });

  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widthOf(orderRef.current[i]),
    overscan: 3,
    // The row-number gutter is pinned over the first columns; reserving its
    // width here keeps every `start` offset already correct.
    paddingStart: gutterW,
  });

  /**
   * Exact left offset per visual column. The virtualizer computes the same
   * numbers for the columns it decided to render, but the inline editor may sit
   * on a column that just left the window mid-scroll, and it must not jump.
   */
  const colOffsets = React.useMemo(() => {
    const offs = new Array<number>(order.length + 1);
    let acc = gutterW;
    for (let i = 0; i < order.length; i++) {
      offs[i] = acc;
      acc += widthOf(order[i]);
    }
    offs[order.length] = acc;
    return offs;
    // `widths` is read through a ref inside widthOf, so it has to be a dep here.
  }, [order, widths, widthOf, gutterW]);

  const widthSig = colOffsets[order.length];
  React.useEffect(() => {
    // Column sizes come from `estimateSize`, so a resize needs the cached
    // measurements thrown away before the new width takes effect.
    colVirtualizer.measure();
  }, [widthSig, gutterW, colVirtualizer]);

  const totalWidth = colVirtualizer.getTotalSize();
  const totalHeight = rowVirtualizer.getTotalSize();

  // --- selection ------------------------------------------------------------

  const clampPoint = React.useCallback(
    (p: Point): Point => ({
      r: Math.max(0, Math.min(p.r, visualRowCount - 1)),
      c: Math.max(0, Math.min(p.c, order.length - 1)),
    }),
    [visualRowCount, order.length],
  );

  const select = React.useCallback(
    (p: Point, extend: boolean) => {
      const next = clampPoint(p);
      setSel((cur) => (extend && cur ? { a: cur.a, f: next } : { a: next, f: next }));
    },
    [clampPoint],
  );

  const focusPoint = sel?.f ?? null;

  const revealPoint = React.useCallback(
    (p: Point) => {
      rowVirtualizer.scrollToIndex(p.r, { align: 'auto' });
      colVirtualizer.scrollToIndex(p.c, { align: 'auto' });
    },
    [rowVirtualizer, colVirtualizer],
  );

  // --- editing --------------------------------------------------------------

  const commitEdit = React.useCallback(
    (vr: number, vc: number, text: string | null) => {
      if (!editable) return;
      const dataCol = order[vc];
      const col = columns[dataCol];
      if (!col) return;
      let value: Cell;
      try {
        value = text === null ? null : parseCellInput(text, col, originalAt(vr, dataCol));
      } catch (err) {
        toast.error(err instanceof CellParseError ? err.message : `Could not use that value for ${col.name}.`);
        return;
      }
      if (vr >= rows.length) {
        const ins = edit.inserts[vr - rows.length];
        if (!ins) return;
        dispatch({ type: 'set-insert-cell', id: ins.id, col: dataCol, value });
      } else {
        dispatch({ type: 'set-cell', row: vr, col: dataCol, value, original: rows[vr][dataCol] });
      }
    },
    [editable, order, columns, originalAt, rows, edit.inserts, dispatch],
  );

  const setSelectionNull = React.useCallback(() => {
    if (!editable || !sel) return;
    const rg = rangeOf(sel);
    for (let r = rg.r0; r <= rg.r1; r++) {
      for (let c = rg.c0; c <= rg.c1; c++) commitEdit(r, c, null);
    }
  }, [editable, sel, commitEdit]);

  const toggleDeleteSelection = React.useCallback(() => {
    if (!editable || !sel) return;
    const rg = rangeOf(sel);
    const targets: number[] = [];
    for (let r = rg.r0; r <= rg.r1 && r < rows.length; r++) targets.push(r);
    if (targets.length === 0) return;
    const allDeleted = targets.every((r) => isRowDeleted(edit, r));
    dispatch({ type: 'set-deleted', rows: targets, deleted: !allDeleted });
  }, [editable, sel, rows.length, edit, dispatch]);

  const addRow = React.useCallback(() => {
    if (!editable) return;
    const id = newInsertId();
    dispatch({ type: 'add-insert', id });
    const r = visualRowCount;
    setSel({ a: { r, c: 0 }, f: { r, c: 0 } });
    // The virtualizer needs the new count before it can scroll to it.
    window.setTimeout(() => rowVirtualizer.scrollToIndex(r, { align: 'end' }), 0);
  }, [editable, dispatch, visualRowCount, rowVirtualizer]);

  const draft = React.useMemo(
    () => buildChangeset(edit, columns, rows, editability),
    [edit, columns, rows, editability],
  );
  const counts = pendingCounts(edit);

  // --- clipboard ------------------------------------------------------------

  /**
   * Copy the selection (docs/roadmap.md M10). Every format reads the same
   * lossless cell text (§6): a BIGINT copies as its digits, not as the float
   * they would round to.
   *
   * INSERT and UPDATE need to know which table the rows came from, so they are
   * offered only when the result declares an `editTarget` — the same signal
   * that decides whether the grid is editable at all.
   */
  const copyAs = React.useCallback(
    (format: CopyFormat) => {
      if (!sel) return;
      const rg = rangeOf(sel);
      const names: string[] = [];
      for (let c = rg.c0; c <= rg.c1; c++) names.push(columns[order[c]]?.name ?? '');

      const cellsOf = (r: number): Cell[] => {
        const out: Cell[] = [];
        for (let c = rg.c0; c <= rg.c1; c++) out.push(valueAt(r, order[c]));
        return out;
      };
      const textOf = (cell: Cell): string => {
        const t = cellToText(cell, 'base64');
        return t === null ? '' : t;
      };

      let payload: string;
      try {
        if (format === 'insert' || format === 'update') {
          const target = result.editTarget;
          if (!target) throw new Error('These rows are not from a single table.');
          if (!engine) throw new Error('This connection has no SQL dialect.');
          const rowsOut: Row[] = [];
          for (let r = rg.r0; r <= rg.r1; r++) rowsOut.push(cellsOf(r));
          payload =
            format === 'insert'
              ? renderInsertRows({ schema: target.schema, table: target.table }, names, rowsOut, engine)
              : rowsOut
                  .map((row) =>
                    renderUpdateRow(
                      { schema: target.schema, table: target.table },
                      names,
                      row,
                      // Only key columns actually inside the selection can key
                      // the statement; anything else is not in `row`.
                      target.keyColumns.filter((k) => names.includes(k)),
                      engine,
                    ),
                  )
                  .join('\n');
        } else if (format === 'json') {
          const objects: Record<string, string | null>[] = [];
          for (let r = rg.r0; r <= rg.r1; r++) {
            const cells = cellsOf(r);
            const o: Record<string, string | null> = {};
            names.forEach((n, i) => {
              o[n] = cells[i] === null ? null : textOf(cells[i]);
            });
            objects.push(o);
          }
          payload = JSON.stringify(objects, null, 2);
        } else if (format === 'markdown') {
          const lines = [`| ${names.join(' | ')} |`, `| ${names.map(() => '---').join(' | ')} |`];
          for (let r = rg.r0; r <= rg.r1; r++) {
            // A pipe inside a value would end the cell early.
            lines.push(`| ${cellsOf(r).map((c) => textOf(c).replace(/\|/g, '\\|')).join(' | ')} |`);
          }
          payload = lines.join('\n');
        } else {
          const sep = format === 'csv' ? ',' : '\t';
          const esc = format === 'csv' ? csvEscape : tsvEscape;
          const lines: string[] = [];
          if (format === 'csv' || format === 'tsv-header') lines.push(names.map(esc).join(sep));
          for (let r = rg.r0; r <= rg.r1; r++) {
            lines.push(cellsOf(r).map((c) => esc(textOf(c))).join(sep));
          }
          payload = lines.join('\n');
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not build that format.');
        return;
      }

      void navigator.clipboard
        .writeText(payload)
        .then(() => toast.success(`Copied ${rg.r1 - rg.r0 + 1} × ${rg.c1 - rg.c0 + 1} cells`))
        .catch(() => toast.error('The browser refused clipboard access.'));
    },
    [sel, columns, order, valueAt, result.editTarget, engine],
  );

  /**
   * Where the right-clicked cell can take you (docs/roadmap.md M10). Both
   * directions are computed from the cached model, so the menu knows before it
   * opens whether there is anywhere to go.
   */
  const destinations = React.useMemo<{ out: FkDestination[]; in: FkDestination[] }>(() => {
    const none = { out: [], in: [] };
    const target = result.editTarget;
    const model = schema.model;
    if (!ctx || !target || !model) return none;
    const table = findTable(model, target.schema, target.table);
    if (!table) return none;
    const names = columns.map((c) => c.name);
    const rowCells = names.map((_n, i) => valueAt(ctx.point.r, i));
    const column = columns[order[ctx.point.c]]?.name;
    return {
      out: column ? outgoingFor(table, column, rowCells, names) : [],
      in: incomingFor(model, table, rowCells, names),
    };
  }, [ctx, result.editTarget, schema.model, columns, order, valueAt]);

  const goTo = React.useCallback(
    (dest: FkDestination) => {
      setCtx(null);
      useWorkspaceStore.getState().openTab({
        kind: 'table',
        title: dest.table,
        connectionId,
        state: {
          schema: dest.schema,
          table: dest.table,
          // The filter layer parameterizes these; no value reaches SQL text.
          filter: { filters: dest.filters, where: '' },
          offset: 0,
          sort: [],
        },
      });
    },
    [connectionId],
  );

  /** Kept so the existing ⌘C / ⌘⇧C bindings read unchanged. */
  const copySelection = React.useCallback(
    (withHeader: boolean) => copyAs(withHeader ? 'tsv-header' : 'tsv'),
    [copyAs],
  );

  // --- paging ---------------------------------------------------------------

  React.useEffect(() => {
    const id = cursor.id;
    if (!id) return;
    keepCursor(connectionId, id);
    return () => releaseCursor(connectionId, id);
  }, [connectionId, cursor.id]);

  const fetchMore = React.useCallback(async () => {
    if (!cursor.id || fetching) return;
    setFetching(true);
    try {
      const chunk = await api.post<FetchMoreResponse>('/api/query/more', {
        connectionId,
        cursorId: cursor.id,
        count: FETCH_MORE_COUNT,
      });
      setExtraRows((prev) => [...prev, ...chunk.rows]);
      setCursor((c) => ({ ...c, truncated: chunk.truncated }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not fetch more rows.');
    } finally {
      setFetching(false);
    }
  }, [cursor.id, fetching, connectionId]);

  // --- mouse ----------------------------------------------------------------

  const beginEdit = React.useCallback((p: Point, seed: string | null) => {
    setEditSeed(seed);
    setEditingAt(p);
  }, []);

  const endEdit = React.useCallback(() => {
    setEditSeed(null);
    setEditingAt(null);
  }, []);

  /**
   * Hit-testing by data attribute rather than per-cell handlers: 40 columns ×
   * 60 visible rows is 2400 closures per render otherwise, and the cell memo
   * would never hold.
   */
  const pointFromEvent = (e: React.MouseEvent): { point: Point; gutter: boolean } | null => {
    const target = e.target as HTMLElement | null;
    const cell = target?.closest<HTMLElement>('[data-cell]');
    if (cell) {
      const r = Number(cell.dataset.r);
      const c = Number(cell.dataset.c);
      if (Number.isNaN(r) || Number.isNaN(c)) return null;
      return { point: { r, c }, gutter: false };
    }
    const gutter = target?.closest<HTMLElement>('[data-gutter]');
    if (gutter) {
      const r = Number(gutter.dataset.r);
      if (Number.isNaN(r)) return null;
      return { point: { r, c: 0 }, gutter: true };
    }
    return null;
  };

  const onGridMouseDown = (e: React.MouseEvent) => {
    const hit = pointFromEvent(e);
    if (!hit) return;
    scrollRef.current?.focus();
    if (editingAt) endEdit();
    if (hit.gutter) {
      setSel({ a: { r: hit.point.r, c: 0 }, f: { r: hit.point.r, c: order.length - 1 } });
      return;
    }
    select(hit.point, e.shiftKey);
  };

  const onGridContextMenu = (e: React.MouseEvent) => {
    const hit = pointFromEvent(e);
    if (!hit || hit.gutter) return;
    e.preventDefault();
    // Right-clicking moves the selection first, so the menu always describes
    // the cell it is pointing at rather than a stale one.
    select(hit.point, false);
    setCtx({ x: e.clientX, y: e.clientY, point: hit.point });
  };

  const onGridDoubleClick = (e: React.MouseEvent) => {
    const hit = pointFromEvent(e);
    if (!hit || hit.gutter) return;
    if (editable) beginEdit(hit.point, null);
    else setViewerAt(hit.point);
  };

  // --- keyboard -------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editingAt) return;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelection(e.shiftKey);
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSel({ a: { r: 0, c: 0 }, f: { r: visualRowCount - 1, c: order.length - 1 } });
      return;
    }
    if (!sel) return;
    const f = sel.f;

    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const next = clampPoint({ r: f.r + dr, c: f.c + dc });
      select(next, e.shiftKey);
      revealPoint(next);
    };

    switch (e.key) {
      case 'ArrowDown':
        return move(1, 0);
      case 'ArrowUp':
        return move(-1, 0);
      case 'ArrowLeft':
        return move(0, -1);
      case 'ArrowRight':
      case 'Tab':
        return move(0, e.key === 'Tab' && e.shiftKey ? -1 : 1);
      case 'PageDown':
        return move(Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_H) - 1, 0);
      case 'PageUp':
        return move(-(Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_H) - 1), 0);
      case 'Home':
        return mod ? move(-f.r, -f.c) : move(0, -f.c);
      case 'End':
        return mod ? move(visualRowCount - 1 - f.r, order.length - 1 - f.c) : move(0, order.length - 1 - f.c);
      case 'Enter':
        e.preventDefault();
        if (editable) beginEdit(f, null);
        else setViewerAt(f);
        return;
      case ' ':
        e.preventDefault();
        setViewerAt(f);
        return;
      case 'Escape':
        setSel(null);
        return;
      case 'Delete':
      case 'Backspace':
        if (editable) {
          e.preventDefault();
          setSelectionNull();
        }
        return;
      default:
        break;
    }

    // Typing over a cell starts an edit seeded with that character, spreadsheet
    // style: the keystroke replaces the value rather than being swallowed.
    if (editable && !mod && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      beginEdit(f, e.key);
    }
  };

  // --- columns --------------------------------------------------------------

  const dragFrom = React.useRef<number | null>(null);

  const startResize = (e: React.PointerEvent, dataCol: number) => {
    e.preventDefault();
    e.stopPropagation();
    const key = widthKey(dataCol, columns);
    const startX = e.clientX;
    const startW = widthOf(dataCol);
    setResizing(true);
    const move = (ev: PointerEvent) => {
      setWidths((w) => ({ ...w, [key]: Math.max(MIN_COL_W, Math.round(startW + ev.clientX - startX)) }));
    };
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const autoFit = (dataCol: number) => {
    const col = columns[dataCol];
    if (!col) return;
    let widest = col.name.length + (col.typeName.length > 0 ? 2 : 0);
    const sample = Math.min(rows.length, AUTOFIT_SAMPLE);
    for (let i = 0; i < sample; i++) {
      const text = cellToText(rows[i][dataCol], 'base64');
      const len = text === null ? 4 : text.length;
      if (len > widest) widest = len;
    }
    const px = Math.max(MIN_COL_W, Math.min(MAX_AUTOFIT_W, Math.round(widest * 7 + 22)));
    setWidths((w) => ({ ...w, [widthKey(dataCol, columns)]: px }));
  };

  const moveColumn = (from: number, to: number) => {
    if (from === to) return;
    setOrder((cur) => {
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setSel(null);
  };

  const cycleSort = (dataCol: number, additive: boolean) => {
    if (!onSortChange) return;
    const name = columns[dataCol]?.name;
    if (!name) return;
    const current = sort ?? [];
    const existing = current.find((s) => s.column === name);
    const rest = additive ? current.filter((s) => s.column !== name) : [];
    if (!existing) onSortChange([...rest, { column: name, direction: 'asc' }]);
    else if (existing.direction === 'asc') onSortChange([...rest, { column: name, direction: 'desc' }]);
    else onSortChange(rest);
  };

  // --- render ---------------------------------------------------------------

  if (columns.length === 0) {
    return (
      <div className={cn('flex h-full flex-col', className)}>
        <Toolbar>
          <span className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
            <Lock className="size-3.5" />
            {result.readOnlyReason ?? 'Nothing to edit here.'}
          </span>
          <div className="ml-auto flex items-center gap-1.5">{toolbarExtra}</div>
        </Toolbar>
        <EmptyState
          icon={<Rows3 className="size-6" />}
          title="No result set"
          description={
            result.affectedRows === undefined
              ? 'This statement returned no columns.'
              : `${numberFmt.format(result.affectedRows)} row(s) affected in ${Math.round(result.durationMs)} ms.`
          }
        />
      </div>
    );
  }

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualCols = colVirtualizer.getVirtualItems();
  const selRange = sel ? rangeOf(sel) : null;
  const editingCol = editingAt ? columns[order[editingAt.c]] : null;

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-[var(--bg)]', className)}>
      <Toolbar>
        {editable ? (
          <>
            <Button size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={addRow}>
              Row
            </Button>
            <Button
              size="xs"
              variant="ghost"
              icon={<Trash2 className="size-3.5" />}
              onClick={toggleDeleteSelection}
              disabled={!sel}
              title="Mark the selected rows for deletion"
            >
              Delete
            </Button>
            <Button
              size="xs"
              variant="ghost"
              icon={<CircleSlash2 className="size-3.5" />}
              onClick={setSelectionNull}
              disabled={!sel}
              title="Set the selection to NULL (Delete)"
            >
              NULL
            </Button>
            <Separator vertical />
            <Button
              size="xs"
              variant="ghost"
              icon={<Undo2 className="size-3.5" />}
              onClick={() => dispatch({ type: 'reset' })}
              disabled={counts.total === 0}
            >
              Revert
            </Button>
            <Button
              size="xs"
              variant={counts.total > 0 ? 'primary' : 'ghost'}
              icon={<Play className="size-3.5" />}
              onClick={() => setChangesetOpen(true)}
              disabled={counts.total === 0}
            >
              Preview &amp; apply
              {counts.total > 0 && (
                <span className="ml-1 rounded bg-black/15 px-1 text-[10px]">{counts.total}</span>
              )}
            </Button>
          </>
        ) : (
          // §6: when the grid cannot be edited it has to say why, right here.
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--fg-muted)]" title={editability.reason}>
            <Lock className="size-3.5 shrink-0" />
            <span className="truncate">Read-only — {editability.reason}</span>
          </span>
        )}

        <Separator vertical />
        <Button
          size="xs"
          variant="ghost"
          icon={<PanelRight className="size-3.5" />}
          onClick={() => setDetailRow(sel?.f.r ?? 0)}
          disabled={visualRowCount === 0}
          title="Show the focused row as a form"
        >
          Row
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<Maximize2 className="size-3.5" />}
          onClick={() => sel && setViewerAt(sel.f)}
          disabled={!sel}
          title="Expand the focused cell"
        />
        <div className="relative">
          <Button
            size="xs"
            variant="ghost"
            icon={<Clipboard className="size-3.5" />}
            onClick={() => setCopyMenuOpen((v) => !v)}
            disabled={!sel}
            title="Copy the selection (⌘C for TSV, ⌘⇧C with header)"
          />
          {copyMenuOpen && sel && (
            <div
              className="absolute right-0 z-30 mt-1 min-w-44 rounded border border-[var(--border)] bg-[var(--bg-raised)] py-1 shadow-lg"
              onMouseLeave={() => setCopyMenuOpen(false)}
            >
              {COPY_ITEMS.map((item) => {
                // INSERT and UPDATE need a single known table and a SQL engine.
                const needsTable = item.format === 'insert' || item.format === 'update';
                const disabled = needsTable && (!result.editTarget || !engine);
                return (
                  <button
                    key={item.format}
                    type="button"
                    disabled={disabled}
                    className={cn(
                      'block w-full px-3 py-1 text-left text-[11px]',
                      disabled
                        ? 'cursor-not-allowed text-[var(--fg-subtle)]'
                        : 'hover:bg-[var(--bg-hover)]',
                    )}
                    title={
                      disabled ? 'Only for a result whose rows come from one table' : undefined
                    }
                    onClick={() => {
                      setCopyMenuOpen(false);
                      copyAs(item.format);
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {result.notices && result.notices.length > 0 && (
          <span
            className="flex items-center gap-1 text-[11px] text-[var(--warn)]"
            title={result.notices.join('\n')}
          >
            <TriangleAlert className="size-3.5" />
            {result.notices.length} notice{result.notices.length === 1 ? '' : 's'}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">{toolbarExtra}</div>
      </Toolbar>

      {filterBar}

      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-rowcount={visualRowCount}
        aria-colcount={order.length}
        onKeyDown={onKeyDown}
        onMouseDown={onGridMouseDown}
        onContextMenu={onGridContextMenu}
        onDoubleClick={onGridDoubleClick}
        className="mono relative min-h-0 flex-1 overflow-auto outline-none"
      >
        <div style={{ width: totalWidth, minWidth: '100%' }}>
          {/* Header — sticky vertically, scrolls horizontally with the body. */}
          <div
            className="sticky top-0 z-30 border-b border-[var(--border-strong)] bg-[var(--grid-header)]"
            style={{ height: HEADER_H }}
          >
            <div
              className="sticky left-0 z-10 flex h-full items-center justify-center border-r border-[var(--border-strong)] bg-[var(--grid-header)] text-[10px] text-[var(--fg-subtle)]"
              style={{ width: gutterW }}
            >
              #
            </div>
            {virtualCols.map((vc) => {
              const dataCol = order[vc.index];
              const col = columns[dataCol];
              if (!col) return null;
              const sortEntry = sort?.find((s) => s.column === col.name);
              const sortIndex = sort && sort.length > 1 ? sort.findIndex((s) => s.column === col.name) : -1;
              return (
                <div
                  key={vc.key}
                  draggable={!resizing}
                  onDragStart={() => {
                    dragFrom.current = vc.index;
                  }}
                  onDragOver={(e) => {
                    if (dragFrom.current === null) return;
                    e.preventDefault();
                    setDragOver(vc.index);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom.current !== null) moveColumn(dragFrom.current, vc.index);
                    dragFrom.current = null;
                    setDragOver(null);
                  }}
                  onDragEnd={() => {
                    dragFrom.current = null;
                    setDragOver(null);
                  }}
                  onClick={(e) => cycleSort(dataCol, e.shiftKey)}
                  title={`${col.name} — ${col.typeName}${col.nullable === false ? ' NOT NULL' : ''}`}
                  style={{ left: vc.start, width: vc.size, top: 0, height: '100%' }}
                  className={cn(
                    'absolute flex items-center gap-1 border-r border-[var(--border)] px-1.5',
                    'select-none bg-[var(--grid-header)]',
                    onSortChange && 'cursor-pointer hover:bg-[var(--bg-hover)]',
                    dragOver === vc.index && 'shadow-[inset_2px_0_0_var(--accent)]',
                  )}
                >
                  {col.isKey && <KeyRound className="size-3 shrink-0 text-[var(--warn)]" />}
                  <span className="truncate text-[12px] font-medium text-[var(--fg)]">{col.name}</span>
                  <span className="truncate text-[10px] text-[var(--fg-subtle)]">{col.typeName}</span>
                  {sortEntry && (
                    <span className="ml-auto shrink-0 text-[10px] text-[var(--accent)]">
                      {sortEntry.direction === 'asc' ? '▲' : '▼'}
                      {sortIndex >= 0 ? sortIndex + 1 : ''}
                    </span>
                  )}
                  <div
                    onPointerDown={(e) => startResize(e, dataCol)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      autoFit(dataCol);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--accent)]"
                  />
                </div>
              );
            })}
          </div>

          {/* Body */}
          <div className="relative" style={{ height: totalHeight }}>
            {virtualRows.map((vr) => {
              const isInsert = vr.index >= rows.length;
              const deleted = !isInsert && isRowDeleted(edit, vr.index);
              const rowSelected = selRange !== null && vr.index >= selRange.r0 && vr.index <= selRange.r1;
              return (
                <div
                  key={vr.key}
                  role="row"
                  className={cn(
                    'absolute left-0 border-b border-[var(--border)]',
                    deleted && 'line-through opacity-60',
                  )}
                  style={{ top: vr.start, height: ROW_H, width: totalWidth, minWidth: '100%' }}
                >
                  <div
                    data-gutter=""
                    data-r={vr.index}
                    style={{ width: gutterW, height: '100%' }}
                    className={cn(
                      'sticky left-0 z-20 flex items-center justify-end gap-1 border-r border-[var(--border)] px-1.5 text-[10px]',
                      rowSelected ? 'bg-[var(--bg-active)]' : 'bg-[var(--bg-subtle)]',
                      'text-[var(--fg-subtle)]',
                    )}
                  >
                    {isInsert ? (
                      <span className="text-[var(--ok)]">+ new</span>
                    ) : (
                      <>
                        {edit.updates[vr.index] && <span className="text-[var(--warn)]">●</span>}
                        {numberFmt.format(rowOffset + vr.index + 1)}
                      </>
                    )}
                  </div>

                  {virtualCols.map((vc) => {
                    const dataCol = order[vc.index];
                    const col = columns[dataCol];
                    if (!col) return null;
                    const isEditing =
                      editingAt !== null && editingAt.r === vr.index && editingAt.c === vc.index;
                    if (isEditing) return null;
                    const selected =
                      selRange !== null &&
                      vr.index >= selRange.r0 &&
                      vr.index <= selRange.r1 &&
                      vc.index >= selRange.c0 &&
                      vc.index <= selRange.c1;
                    return (
                      <GridCell
                        key={vc.key}
                        cell={valueAt(vr.index, dataCol)}
                        column={col}
                        left={vc.start}
                        width={vc.size}
                        rowIndex={vr.index}
                        colIndex={vc.index}
                        selected={selected}
                        focused={focusPoint?.r === vr.index && focusPoint?.c === vc.index}
                        dirty={isDirtyAt(vr.index, dataCol)}
                        striped={vr.index % 2 === 1}
                      />
                    );
                  })}

                  {editingAt !== null && editingAt.r === vr.index && editingCol && (
                    <CellEditor
                      // A remount per cell is what re-seeds the input, so the
                      // key carries the coordinates and the seed keystroke.
                      key={`${editingAt.r}:${editingAt.c}:${editSeed ?? ''}`}
                      initial={editSeed ?? cellToEditText(valueAt(vr.index, order[editingAt.c]))}
                      left={colOffsets[editingAt.c]}
                      width={widthOf(order[editingAt.c])}
                      align={alignsRight(editingCol, valueAt(vr.index, order[editingAt.c])) ? 'right' : 'left'}
                      onCommit={(text, move) => {
                        commitEdit(editingAt.r, editingAt.c, text);
                        endEdit();
                        if (move !== 'none') {
                          const next = clampPoint(
                            move === 'right'
                              ? { r: editingAt.r, c: editingAt.c + 1 }
                              : { r: editingAt.r + 1, c: editingAt.c },
                          );
                          setSel({ a: next, f: next });
                          revealPoint(next);
                        }
                      }}
                      onCancel={endEdit}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <GridStatus
        rowsLoaded={rows.length}
        inserts={edit.inserts.length}
        durationMs={result.durationMs}
        truncated={cursor.truncated}
        canFetchMore={!!cursor.id && cursor.truncated}
        fetching={fetching}
        onFetchMore={() => void fetchMore()}
        paging={paging}
        counts={counts}
      />

      {ctx && (
        <>
          {/* A full-screen catcher, so any click or scroll dismisses the menu. */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setCtx(null)} onWheel={() => setCtx(null)} />
          <div
            className="fixed z-50 min-w-56 rounded border border-[var(--border)] bg-[var(--bg-raised)] py-1 shadow-lg"
            style={{ left: ctx.x, top: ctx.y }}
          >
            <button
              type="button"
              className="block w-full px-3 py-1 text-left text-[11px] hover:bg-[var(--bg-hover)]"
              onClick={() => {
                setCtx(null);
                setViewerAt(ctx.point);
              }}
            >
              Expand cell
            </button>

            {destinations.out.length > 0 && (
              <>
                <div className="mt-1 border-t border-[var(--border)] px-3 pt-1 text-[10px] uppercase text-[var(--fg-subtle)]">
                  Go to
                </div>
                {destinations.out.map((d, i) => (
                  <button
                    key={`out-${i}`}
                    type="button"
                    className="block w-full px-3 py-1 text-left text-[11px] hover:bg-[var(--bg-hover)]"
                    onClick={() => goTo(d)}
                  >
                    {d.label}
                  </button>
                ))}
              </>
            )}

            {destinations.in.length > 0 && (
              <>
                <div className="mt-1 border-t border-[var(--border)] px-3 pt-1 text-[10px] uppercase text-[var(--fg-subtle)]">
                  Referenced by
                </div>
                {destinations.in.map((d, i) => (
                  <button
                    key={`in-${i}`}
                    type="button"
                    className="block w-full px-3 py-1 text-left text-[11px] hover:bg-[var(--bg-hover)]"
                    onClick={() => goTo(d)}
                  >
                    {d.label}
                  </button>
                ))}
              </>
            )}

            {destinations.out.length === 0 && destinations.in.length === 0 && (
              <div className="px-3 py-1 text-[11px] text-[var(--fg-subtle)]">
                No foreign keys touch this row
              </div>
            )}
          </div>
        </>
      )}

      {viewerAt && columns[order[viewerAt.c]] && (
        <CellViewer
          open
          onClose={() => setViewerAt(null)}
          cell={valueAt(viewerAt.r, order[viewerAt.c])}
          column={columns[order[viewerAt.c]]}
          title={`${columns[order[viewerAt.c]].name} — row ${numberFmt.format(rowOffset + viewerAt.r + 1)}`}
          editable={editable}
          onSave={(text) => commitEdit(viewerAt.r, viewerAt.c, text)}
        />
      )}

      {detailRow !== null && detailRow < visualRowCount && (
        <RowDetail
          open
          onClose={() => setDetailRow(null)}
          columns={columns}
          values={columns.map((_, i) => valueAt(detailRow, i))}
          originals={detailRow < rows.length ? rows[detailRow] : undefined}
          title={detailRow >= rows.length ? 'New row' : `Row ${numberFmt.format(rowOffset + detailRow + 1)}`}
          position={{ index: detailRow, total: visualRowCount }}
          editable={editable}
          onChange={(dataCol, text) => {
            const vc = order.indexOf(dataCol);
            if (vc >= 0) commitEdit(detailRow, vc, text);
          }}
          onNavigate={(delta) =>
            setDetailRow((cur) =>
              cur === null ? cur : Math.max(0, Math.min(visualRowCount - 1, cur + delta)),
            )
          }
        />
      )}

      <ChangesetDialog
        open={changesetOpen}
        onClose={() => setChangesetOpen(false)}
        connectionId={connectionId}
        changeset={draft.changeset}
        problems={draft.problems}
        onApplied={(applied) => {
          dispatch({ type: 'reset' });
          setChangesetOpen(false);
          onApplied?.(applied);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function widthKey(dataCol: number, columns: ColumnMeta[]): string {
  // Index-qualified: a join can legitimately return two columns called "id".
  return `${dataCol}:${columns[dataCol]?.name ?? ''}`;
}

function initialWidths(columns: ColumnMeta[]): Record<string, number> {
  const out: Record<string, number> = {};
  columns.forEach((col, i) => {
    out[`${i}:${col.name}`] = defaultWidth(col);
  });
  return out;
}

function GridStatus({
  rowsLoaded,
  inserts,
  durationMs,
  truncated,
  canFetchMore,
  fetching,
  onFetchMore,
  paging,
  counts,
}: {
  rowsLoaded: number;
  inserts: number;
  durationMs: number;
  truncated: boolean;
  canFetchMore: boolean;
  fetching: boolean;
  onFetchMore: () => void;
  paging?: GridPaging;
  counts: { updates: number; inserts: number; deletes: number; total: number };
}) {
  const from = (paging?.offset ?? 0) + 1;
  const to = (paging?.offset ?? 0) + rowsLoaded;

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1 text-[11px] text-[var(--fg-muted)]">
      <span>
        {paging ? `${numberFmt.format(from)}–${numberFmt.format(to)}` : `${numberFmt.format(rowsLoaded)} rows`}
        {paging?.total !== undefined && ` of ${paging.estimated ? '≈' : ''}${numberFmt.format(paging.total)}`}
        {inserts > 0 && ` · ${inserts} new`}
      </span>
      <span className="text-[var(--fg-subtle)]">{Math.round(durationMs)} ms</span>

      {counts.total > 0 && (
        <Badge tone="warn">
          {counts.updates} edited · {counts.inserts} added · {counts.deletes} deleted
        </Badge>
      )}

      {/* §6 "Big results": the rest of the rows stay on the server until asked for. */}
      {truncated && (
        <span className="flex items-center gap-1.5">
          <Badge tone="accent">truncated</Badge>
          {canFetchMore && (
            <Button size="xs" variant="subtle" onClick={onFetchMore} loading={fetching}>
              Fetch {numberFmt.format(FETCH_MORE_COUNT)} more
            </Button>
          )}
        </span>
      )}

      {paging && (
        <span className="ml-auto flex items-center gap-1">
          {paging.loading && <Spinner className="size-3" />}
          <Button
            size="xs"
            variant="ghost"
            icon={<ChevronsLeft className="size-3.5" />}
            disabled={paging.offset === 0}
            onClick={() => paging.onOffsetChange(0)}
            title="First page"
          />
          <Button
            size="xs"
            variant="ghost"
            icon={<ChevronLeft className="size-3.5" />}
            disabled={paging.offset === 0}
            onClick={() => paging.onOffsetChange(Math.max(0, paging.offset - paging.pageSize))}
            title="Previous page"
          />
          <Button
            size="xs"
            variant="ghost"
            icon={<ChevronRight className="size-3.5" />}
            disabled={
              paging.total !== undefined
                ? paging.offset + paging.pageSize >= paging.total
                : rowsLoaded < paging.pageSize
            }
            onClick={() => paging.onOffsetChange(paging.offset + paging.pageSize)}
            title="Next page"
          />
          {rowsLoaded === 0 && (
            <span className="flex items-center gap-1 text-[var(--fg-subtle)]">
              <ListX className="size-3.5" /> no rows
            </span>
          )}
        </span>
      )}
    </div>
  );
}
