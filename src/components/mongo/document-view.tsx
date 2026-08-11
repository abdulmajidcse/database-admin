'use client';

/**
 * The result surface of the MongoDB workspace (PLAN M5): the same page of
 * documents in two shapes the user switches between.
 *
 *  • **Table** — the shared `DataGrid`, so a Mongo result behaves like every
 *    other result set in the app (same virtualization, same cell rendering).
 *    The connector flattens a page into the union of its top-level keys.
 *  • **Documents** — a tree that expands nested objects and arrays, which is
 *    the only readable view of a deep document and the one you edit from.
 *
 * Cells arrive in the wire format (`src/lib/wire.ts`) with the Mongo tags
 * `objectid`, `decimal128`, `timestamp`, `bytes`, `regex`, `document` and
 * `array`. `cellToEjson` maps every one of them back to the Extended JSON token
 * it came from — the exact inverse of the connector's `cellFromBson` — so:
 *
 *   1. the tree renders each type distinctly rather than as an opaque string,
 *   2. the editor is pre-filled with Extended JSON that `EJSON.parse` decodes
 *      server-side into the same BSON the document was read with, and
 *   3. read → edit → save round-trips losslessly (PLAN §6 "Type fidelity").
 *
 * Writes go to /api/mongo/replace, /api/mongo/insert and /api/mongo/delete. The
 * `_id` is sent as the raw wire cell rather than as text, because the server
 * decodes tagged cells straight back into BSON.
 */

import * as React from 'react';
import { toast } from 'sonner';
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Copy,
  FileBraces,
  Pencil,
  Plus,
  RefreshCw,
  Rows3,
  Trash2,
} from 'lucide-react';
import { api } from '../../lib/api-client';
import type { ColumnMeta, ResultSet } from '../../lib/results';
import { base64ToBytes, type Cell, type Row } from '../../lib/wire';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorBox, Spinner, Toolbar, cn } from '../ui/primitives';
import { DataGrid } from '../grid/data-grid';
import { JsonEditor, formatCount, prettyJson } from './query-bar';

/**
 * Why the table view is read-only: the grid writes through
 * `/api/changeset/apply`, which is SQL — it acquires a *SQL* connector and
 * emits UPDATE/INSERT/DELETE. A document is replaced whole through
 * `/api/mongo/replace` instead, which is what the Documents view does. The
 * grid renders this sentence in its own toolbar, so the way out is on screen.
 */
const TABLE_READ_ONLY_REASON =
  'A document is replaced whole, not by column. Switch to Documents to edit, duplicate or delete one.';

// ---------------------------------------------------------------------------
// Wire cells → Extended JSON
// ---------------------------------------------------------------------------

export type EjsonValue = null | string | number | boolean | EjsonValue[] | { [key: string]: EjsonValue };

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const REGEX_CELL = /^\/([\s\S]*)\/([a-z]*)$/;

function parseNested(text: string): EjsonValue {
  try {
    return JSON.parse(text) as EjsonValue;
  } catch {
    // The connector writes canonical EJSON here, so this only fires if a cell
    // was hand-assembled elsewhere; keeping the text is better than throwing.
    return text;
  }
}

function dateToken(v: string): EjsonValue {
  // The connector writes an ISO string, or `@<epoch ms>` for a date outside the
  // ISO range. EJSON.parse accepts both `{"$date": "<iso>"}` and the canonical
  // `{"$date": {"$numberLong": "<ms>"}}`.
  if (v.startsWith('@')) {
    const ms = Number(v.slice(1));
    return Number.isFinite(ms) ? { $date: { $numberLong: String(ms) } } : v;
  }
  return { $date: v };
}

/** One wire `Cell` → the Extended JSON value it was encoded from. */
export function cellToEjson(cell: Cell): EjsonValue | undefined {
  if (cell === null) return null;
  if (typeof cell === 'boolean' || typeof cell === 'string') return cell;
  if (typeof cell === 'number') {
    // A plain number is an Int32 or a Double. An integer outside the int32
    // range would be re-read as a Long, so it keeps its $numberDouble token.
    return Number.isInteger(cell) && !Object.is(cell, -0) && (cell < INT32_MIN || cell > INT32_MAX)
      ? { $numberDouble: String(cell) }
      : cell;
  }

  const { $t, v, of } = cell;

  switch (of) {
    case 'missing':
      // Absent, which Mongo distinguishes from null: the caller drops the key.
      return undefined;
    case 'undefined':
      return { $undefined: true };
    case 'minKey':
      return { $minKey: 1 };
    case 'maxKey':
      return { $maxKey: 1 };
    case 'symbol':
      return { $symbol: v };
    case 'javascript':
      return { $code: v };
    case 'javascriptWithScope':
    case 'dbRef':
    case 'object':
    case 'array':
      return parseNested(v);
    case 'double':
      return { $numberDouble: v };
    case 'long':
      return { $numberLong: v };
    case 'timestamp': {
      // A replication timestamp: a (seconds, counter) pair, not a datetime.
      const [t, i] = v.split(',');
      return { $timestamp: { t: Number(t) || 0, i: Number(i) || 0 } };
    }
    case 'date':
      return dateToken(v);
    case 'uuid':
      return { $uuid: v };
    default:
      break;
  }

  if (of && of.startsWith('binData:')) {
    const subType = Number(of.slice('binData:'.length)) || 0;
    return { $binary: { base64: v, subType: subType.toString(16).padStart(2, '0') } };
  }

  switch ($t) {
    case 'objectid':
      return { $oid: v };
    case 'decimal128':
    case 'decimal':
      return { $numberDecimal: v };
    case 'bigint':
      return { $numberLong: v };
    case 'bytes':
      return { $binary: { base64: v, subType: '00' } };
    case 'uuid':
      return { $uuid: v };
    case 'timestamp':
    case 'timestamptz':
    case 'date':
      return dateToken(v);
    case 'regex': {
      const m = REGEX_CELL.exec(v);
      return { $regularExpression: { pattern: m ? m[1] : v, options: m ? m[2] : '' } };
    }
    case 'json':
    case 'document':
    case 'array':
      return parseNested(v);
    default:
      return v;
  }
}

/** Rebuild one document from a grid row. Missing fields stay missing. */
export function documentFromRow(columns: ColumnMeta[], row: Row): Record<string, EjsonValue> {
  const doc: Record<string, EjsonValue> = {};
  const width = Math.min(columns.length, row.length);
  for (let i = 0; i < width; i++) {
    const value = cellToEjson(row[i]);
    if (value === undefined) continue;
    doc[columns[i].name] = value;
  }
  return doc;
}

export function ejsonToText(value: EjsonValue): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Extended JSON → what the tree draws
// ---------------------------------------------------------------------------

type Described =
  | { kind: 'oid'; hex: string; typeName: string }
  | { kind: 'binary'; base64: string; subType: string; typeName: string }
  | { kind: 'date'; iso: string; title: string; typeName: string }
  | { kind: 'scalar'; text: string; tone: 'string' | 'number' | 'keyword' | 'special'; typeName: string }
  | { kind: 'container'; container: 'object' | 'array'; entries: [string, EjsonValue][]; typeName: string };

/** `unknown` rather than `EjsonValue`, because callers pass optional tokens. */
function isRecord(value: unknown): value is { [key: string]: EjsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function token(value: { [key: string]: EjsonValue }, name: string): EjsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(value, name) ? value[name] : undefined;
}

function longText(value: EjsonValue | undefined): string {
  if (isRecord(value)) {
    const inner = token(value, '$numberLong');
    if (typeof inner === 'string') return inner;
  }
  return String(value);
}

/** Classify an Extended JSON value so the tree can render it as its BSON type. */
export function describeEjson(value: EjsonValue): Described {
  if (value === null) return { kind: 'scalar', text: 'null', tone: 'keyword', typeName: 'null' };
  if (typeof value === 'boolean') return { kind: 'scalar', text: String(value), tone: 'keyword', typeName: 'bool' };
  if (typeof value === 'number') {
    return {
      kind: 'scalar',
      text: String(value),
      tone: 'number',
      typeName: Number.isInteger(value) ? 'int' : 'double',
    };
  }
  if (typeof value === 'string') return { kind: 'scalar', text: value, tone: 'string', typeName: 'string' };
  if (Array.isArray(value)) {
    return {
      kind: 'container',
      container: 'array',
      entries: value.map((item, i): [string, EjsonValue] => [String(i), item]),
      typeName: `array[${value.length}]`,
    };
  }

  const oid = token(value, '$oid');
  if (typeof oid === 'string') return { kind: 'oid', hex: oid, typeName: 'objectId' };

  const date = token(value, '$date');
  if (date !== undefined) {
    const ms = typeof date === 'string' ? Date.parse(date) : Number(longText(date));
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      return { kind: 'date', iso: d.toISOString(), title: d.toString(), typeName: 'date' };
    }
    return { kind: 'scalar', text: String(date), tone: 'special', typeName: 'date' };
  }

  const decimal = token(value, '$numberDecimal');
  if (typeof decimal === 'string') return { kind: 'scalar', text: decimal, tone: 'number', typeName: 'decimal' };
  const long = token(value, '$numberLong');
  if (typeof long === 'string') return { kind: 'scalar', text: long, tone: 'number', typeName: 'long' };
  const dbl = token(value, '$numberDouble');
  if (typeof dbl === 'string') return { kind: 'scalar', text: dbl, tone: 'number', typeName: 'double' };
  const int = token(value, '$numberInt');
  if (typeof int === 'string') return { kind: 'scalar', text: int, tone: 'number', typeName: 'int' };

  const binary = token(value, '$binary');
  if (isRecord(binary)) {
    const base64 = token(binary, 'base64');
    const subType = token(binary, 'subType');
    return {
      kind: 'binary',
      base64: typeof base64 === 'string' ? base64 : '',
      subType: typeof subType === 'string' ? subType : '00',
      typeName: 'binData',
    };
  }
  const uuid = token(value, '$uuid');
  if (typeof uuid === 'string') return { kind: 'scalar', text: uuid, tone: 'special', typeName: 'uuid' };

  const regex = token(value, '$regularExpression');
  if (isRecord(regex)) {
    const pattern = token(regex, 'pattern');
    const options = token(regex, 'options');
    return {
      kind: 'scalar',
      text: `/${typeof pattern === 'string' ? pattern : ''}/${typeof options === 'string' ? options : ''}`,
      tone: 'special',
      typeName: 'regex',
    };
  }

  const timestamp = token(value, '$timestamp');
  if (isRecord(timestamp)) {
    return {
      kind: 'scalar',
      text: `Timestamp(${String(token(timestamp, 't') ?? 0)}, ${String(token(timestamp, 'i') ?? 0)})`,
      tone: 'special',
      typeName: 'timestamp',
    };
  }

  const code = token(value, '$code');
  if (typeof code === 'string') {
    return { kind: 'scalar', text: code, tone: 'special', typeName: token(value, '$scope') ? 'code+scope' : 'code' };
  }
  const symbol = token(value, '$symbol');
  if (typeof symbol === 'string') return { kind: 'scalar', text: symbol, tone: 'string', typeName: 'symbol' };
  if (token(value, '$minKey') !== undefined) {
    return { kind: 'scalar', text: 'MinKey', tone: 'keyword', typeName: 'minKey' };
  }
  if (token(value, '$maxKey') !== undefined) {
    return { kind: 'scalar', text: 'MaxKey', tone: 'keyword', typeName: 'maxKey' };
  }
  if (token(value, '$undefined') !== undefined) {
    return { kind: 'scalar', text: 'undefined', tone: 'keyword', typeName: 'undefined' };
  }

  const entries = Object.entries(value);
  const ref = token(value, '$ref');
  return {
    kind: 'container',
    container: 'object',
    entries,
    typeName: typeof ref === 'string' ? 'dbRef' : `object{${entries.length}}`,
  };
}

function hexPreview(base64: string): { length: number; preview: string } {
  try {
    const bytes = base64ToBytes(base64);
    const head = Array.from(bytes.subarray(0, 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    return { length: bytes.length, preview: bytes.length > 8 ? `${head} …` : head };
  } catch {
    return { length: 0, preview: '' };
  }
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error('The browser refused clipboard access');
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text, label);
      }}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className="rounded p-0.5 text-[var(--fg-subtle)] opacity-0 hover:bg-[var(--bg-active)] hover:text-[var(--fg)] group-hover:opacity-100"
    >
      <Copy className="size-3" />
    </button>
  );
}

function ValueLabel({ described }: { described: Described }) {
  switch (described.kind) {
    case 'oid':
      return (
        <span className="flex min-w-0 items-center gap-1">
          <span className="mono truncate text-[var(--fg)]">ObjectId(&quot;{described.hex}&quot;)</span>
          <CopyButton text={described.hex} label="ObjectId" />
        </span>
      );
    case 'date':
      return (
        <span className="mono truncate text-[var(--fg)]" title={described.title}>
          {described.iso}
        </span>
      );
    case 'binary': {
      const { length, preview } = hexPreview(described.base64);
      return (
        <span className="flex min-w-0 items-center gap-1">
          <span className="mono truncate text-[var(--fg-muted)]">
            {length} bytes{described.subType !== '00' ? ` · subtype 0x${described.subType}` : ''}
            {preview && ` · ${preview}`}
          </span>
          <CopyButton text={described.base64} label="base64" />
        </span>
      );
    }
    case 'scalar': {
      const tone =
        described.tone === 'string'
          ? 'text-[var(--ok)]'
          : described.tone === 'number'
            ? 'text-[var(--accent)]'
            : described.tone === 'keyword'
              ? 'null-cell'
              : 'text-[var(--warn)]';
      return (
        <span className={cn('mono truncate', tone)} title={described.text}>
          {described.tone === 'string' ? `"${described.text}"` : described.text}
        </span>
      );
    }
    case 'container':
      return (
        <span className="mono truncate text-[var(--fg-subtle)]">
          {described.container === 'array'
            ? `[ ${described.entries.length} items ]`
            : `{ ${described.entries.length} fields }`}
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// Tree rows
// ---------------------------------------------------------------------------

interface OpenState {
  /** Levels shallower than this are open unless toggled; 1 = documents only. */
  baseDepth: number;
  toggled: Set<string>;
}

function isOpen(state: OpenState, path: string, level: number): boolean {
  const byDefault = level < state.baseDepth;
  return state.toggled.has(path) ? !byDefault : byDefault;
}

function EjsonRows({
  entries,
  depth,
  prefix,
  state,
  onToggle,
}: {
  entries: [string, EjsonValue][];
  depth: number;
  prefix: string;
  state: OpenState;
  onToggle: (path: string) => void;
}) {
  return (
    <>
      {entries.map(([key, value]) => (
        <EjsonRow
          key={key}
          name={key}
          value={value}
          depth={depth}
          path={`${prefix}.${key}`}
          state={state}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

function EjsonRow({
  name,
  value,
  depth,
  path,
  state,
  onToggle,
}: {
  name: string;
  value: EjsonValue;
  depth: number;
  path: string;
  state: OpenState;
  onToggle: (path: string) => void;
}) {
  const described = describeEjson(value);
  const container = described.kind === 'container';
  // The document itself is level 0, so its own fields are level 1.
  const open = container && isOpen(state, path, depth + 1);

  return (
    <>
      <div
        className="group flex items-center gap-1.5 py-px pr-2 hover:bg-[var(--bg-hover)]"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {container ? (
          <button
            type="button"
            onClick={() => onToggle(path)}
            className="shrink-0 text-[var(--fg-subtle)] hover:text-[var(--fg)]"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="mono shrink-0 text-[var(--fg-muted)]">{name}</span>
        <span className="mono shrink-0 text-[10px] text-[var(--fg-subtle)]">{described.typeName}</span>
        <ValueLabel described={described} />
      </div>
      {open && described.kind === 'container' && (
        <EjsonRows entries={described.entries} depth={depth + 1} prefix={path} state={state} onToggle={onToggle} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Document view
// ---------------------------------------------------------------------------

export type DocumentViewMode = 'table' | 'tree';

export interface DocumentViewProps {
  connectionId: string;
  database: string;
  collection: string;
  result: ResultSet | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  mode: DocumentViewMode;
  onModeChange: (mode: DocumentViewMode) => void;
  /** Aggregation output is computed, not stored, so it cannot be written back. */
  editable?: boolean;
  /** Extra controls (paging, timings) rendered at the right of the toolbar. */
  toolbarExtra?: React.ReactNode;
}

/** How many documents the tree renders before asking; a page can be thousands. */
const TREE_PAGE = 50;

export function DocumentView({
  connectionId,
  database,
  collection,
  result,
  loading,
  error,
  onRefresh,
  mode,
  onModeChange,
  editable = true,
  toolbarExtra,
}: DocumentViewProps) {
  const [state, setState] = React.useState<OpenState>({ baseDepth: 1, toggled: new Set() });
  const [shown, setShown] = React.useState(TREE_PAGE);
  const [editor, setEditor] = React.useState<EditorTarget | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<{ id: Cell; label: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  // A new page is a new set of documents: expansion and paging start over.
  React.useEffect(() => {
    setState({ baseDepth: 1, toggled: new Set() });
    setShown(TREE_PAGE);
  }, [result]);

  // What is stored is the *exception* to the current default, which is what
  // keeps "expand all" / "collapse all" a single click rather than a walk of
  // every path in the page.
  const toggle = React.useCallback((path: string) => {
    setState((prev) => {
      const toggled = new Set(prev.toggled);
      if (toggled.has(path)) toggled.delete(path);
      else toggled.add(path);
      return { baseDepth: prev.baseDepth, toggled };
    });
  }, []);

  const columns = result?.columns ?? [];
  const rows = result?.rows ?? [];
  const idIndex = columns.findIndex((c) => c.name === '_id');
  const writable = editable && result?.editTarget !== null && idIndex >= 0;

  const documents = React.useMemo(
    () => rows.slice(0, shown).map((row) => documentFromRow(columns, row)),
    [rows, columns, shown],
  );

  async function submitEditor(text: string): Promise<void> {
    if (!editor) return;
    setBusy(true);
    try {
      if (editor.kind === 'edit') {
        const body = { connectionId, database, collection, id: editor.id, document: text };
        const res = await api.post<{ modified: number }>('/api/mongo/replace', body);
        toast.success(res.modified > 0 ? 'Document replaced' : 'Document unchanged');
      } else {
        const body = { connectionId, database, collection, document: text };
        const res = await api.post<{ inserted: number }>('/api/mongo/insert', body);
        toast.success(`${formatCount(res.inserted)} document${res.inserted === 1 ? '' : 's'} inserted`);
      }
      setEditor(null);
      onRefresh();
    } catch (err) {
      throw err instanceof Error ? err : new Error('Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function deleteDocument(id: Cell): Promise<void> {
    setBusy(true);
    try {
      const res = await api.post<{ deleted: number }>('/api/mongo/delete', {
        connectionId,
        database,
        collection,
        id,
      });
      toast.success(`${formatCount(res.deleted)} document${res.deleted === 1 ? '' : 's'} deleted`);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <div className="flex overflow-hidden rounded border border-[var(--border)]">
          <ModeButton active={mode === 'table'} onClick={() => onModeChange('table')} icon={<Rows3 className="size-3" />}>
            Table
          </ModeButton>
          <ModeButton active={mode === 'tree'} onClick={() => onModeChange('tree')} icon={<Braces className="size-3" />}>
            Documents
          </ModeButton>
        </div>
        <Button size="xs" variant="ghost" icon={<RefreshCw className="size-3" />} onClick={onRefresh} title="Re-run">
          Refresh
        </Button>
        {editable && (
          <Button
            size="xs"
            variant="ghost"
            icon={<Plus className="size-3" />}
            onClick={() => setEditor({ kind: 'insert', text: '{\n  \n}' })}
            disabled={!collection}
          >
            Insert
          </Button>
        )}
        {mode === 'tree' && (
          <>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setState({ baseDepth: 99, toggled: new Set() })}
              title="Expand every object and array"
            >
              Expand all
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setState({ baseDepth: 0, toggled: new Set() })}>
              Collapse all
            </Button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
          {loading && <Spinner className="size-3" />}
          {result && (
            <>
              <span className="tabular-nums">
                {formatCount(rows.length)} doc{rows.length === 1 ? '' : 's'}
              </span>
              <span className="tabular-nums">{result.durationMs.toFixed(0)} ms</span>
              {result.truncated && <Badge tone="warn">truncated</Badge>}
            </>
          )}
          {toolbarExtra}
        </div>
      </Toolbar>

      {result?.readOnlyReason && (
        <p className="shrink-0 border-b border-[var(--border)] bg-[var(--warn-bg)] px-2 py-0.5 text-[11px] text-[var(--warn)]">
          {result.readOnlyReason}
        </p>
      )}
      {result?.notices?.map((notice) => (
        <p
          key={notice}
          className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]"
        >
          {notice}
        </p>
      ))}

      {/* The grid owns its own scrolling (it virtualizes both axes), so the
          container must not add a second scrollbar around it. */}
      <div
        className={cn(
          'min-h-0 flex-1',
          mode === 'table' && !error && result && rows.length > 0 ? 'overflow-hidden' : 'overflow-auto',
        )}
      >
        {error ? (
          <div className="p-3">
            <ErrorBox title="Query failed" message={error} />
          </div>
        ) : !result ? (
          loading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <EmptyState
              icon={<FileBraces className="size-5" />}
              title="No results yet"
              description="Run a find to load a page of documents."
            />
          )
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<FileBraces className="size-5" />}
            title="No documents matched"
            description={result.statement}
          />
        ) : mode === 'table' ? (
          <DataGrid
            result={result}
            connectionId={connectionId}
            className="h-full"
            readOnly
            readOnlyReason={writable ? TABLE_READ_ONLY_REASON : (result.readOnlyReason ?? TABLE_READ_ONLY_REASON)}
          />
        ) : (
          <div className="flex flex-col">
            {documents.map((doc, index) => {
              const idCell = idIndex >= 0 ? rows[index][idIndex] : null;
              const described = describeEjson(cellToEjson(idCell) ?? null);
              const path = String(index);
              const open = isOpen(state, path, 0);
              return (
                <DocumentCard
                  key={path}
                  index={index}
                  header={described}
                  open={open}
                  onToggle={() => toggle(path)}
                  actions={
                    writable ? (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          icon={<Pencil className="size-3" />}
                          onClick={() => setEditor({ kind: 'edit', id: idCell, text: ejsonToText(doc) })}
                          title="Edit this document as Extended JSON"
                        />
                        <Button
                          size="xs"
                          variant="ghost"
                          icon={<Copy className="size-3" />}
                          title="Duplicate: insert a copy without its _id"
                          onClick={() => {
                            // A new _id is the server's job; carrying the old
                            // one over would only ever be a duplicate-key error.
                            const copy: Record<string, EjsonValue> = { ...doc };
                            delete copy._id;
                            setEditor({ kind: 'insert', text: ejsonToText(copy) });
                          }}
                        />
                        <Button
                          size="xs"
                          variant="ghost"
                          icon={<Trash2 className="size-3 text-[var(--danger)]" />}
                          title="Delete this document"
                          onClick={() =>
                            setPendingDelete({
                              id: idCell,
                              label: described.kind === 'oid' ? described.hex : JSON.stringify(cellToEjson(idCell)),
                            })
                          }
                        />
                      </>
                    ) : null
                  }
                >
                  <EjsonRows
                    entries={Object.entries(doc)}
                    depth={0}
                    prefix={path}
                    state={state}
                    onToggle={toggle}
                  />
                </DocumentCard>
              );
            })}
            {rows.length > shown && (
              <div className="p-2">
                <Button size="xs" onClick={() => setShown((n) => n + TREE_PAGE)}>
                  Show {Math.min(TREE_PAGE, rows.length - shown)} more of {formatCount(rows.length)}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <DocumentEditorDialog
        target={editor}
        collection={`${database}.${collection}`}
        busy={busy}
        onClose={() => setEditor(null)}
        onSubmit={submitEditor}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void deleteDocument(pendingDelete.id);
        }}
        title="Delete document"
        message={
          <div className="flex flex-col gap-2">
            <p>
              This deletes one document from{' '}
              <span className="mono">
                {database}.{collection}
              </span>
              . It cannot be undone.
            </p>
            <p className="mono break-all text-[var(--fg-muted)]">_id: {pendingDelete?.label}</p>
          </div>
        }
      />
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 px-2 py-0.5 text-[11px] transition-colors',
        active ? 'bg-[var(--bg-active)] text-[var(--fg)]' : 'text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function DocumentCard({
  index,
  header,
  open,
  onToggle,
  actions,
  children,
}: {
  index: number;
  header: Described;
  open: boolean;
  onToggle: () => void;
  actions: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--border)]">
      <div className="group flex items-center gap-1.5 bg-[var(--bg-subtle)] px-2 py-0.5">
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 text-[var(--fg-subtle)] hover:text-[var(--fg)]"
          aria-label={open ? 'Collapse document' : 'Expand document'}
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <span className="mono shrink-0 text-[10px] text-[var(--fg-subtle)]">#{index + 1}</span>
        <span className="mono shrink-0 text-[var(--fg-muted)]">_id</span>
        <ValueLabel described={header} />
        <span className="ml-auto flex items-center opacity-0 group-hover:opacity-100">{actions}</span>
      </div>
      {open && <div className="py-0.5">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The JSON editor dialog (insert / replace)
// ---------------------------------------------------------------------------

type EditorTarget = { kind: 'edit'; id: Cell; text: string } | { kind: 'insert'; text: string };

function DocumentEditorDialog({
  target,
  collection,
  busy,
  onClose,
  onSubmit,
}: {
  target: EditorTarget | null;
  collection: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!target) return;
    setText(target.text);
    setError(null);
  }, [target]);

  async function save(): Promise<void> {
    // Catch a syntax error here so the user sees the parser's message next to
    // the editor instead of a 400 from the server.
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('A document must be a JSON object.');
        return;
      }
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    try {
      await onSubmit(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  const isEdit = target?.kind === 'edit';

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={`${isEdit ? 'Edit' : 'Insert'} document · ${collection}`}
      width="lg"
      footer={
        <>
          <Button onClick={() => setText((t) => prettyJson(t))}>Format</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {isEdit ? 'Replace' : 'Insert'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-[11px] text-[var(--fg-muted)]">
          Extended JSON. Types are written as tokens — <span className="mono">{'{"$oid": "…"}'}</span>,{' '}
          <span className="mono">{'{"$date": "…"}'}</span>, <span className="mono">{'{"$numberDecimal": "…"}'}</span> —
          and are decoded server-side into the BSON they name.
          {isEdit && ' The _id is immutable: to change it, delete and re-insert.'}
        </p>
        <JsonEditor value={text} onChange={setText} height={380} lineNumbers autoFocus onSubmit={() => void save()} />
        {error && <ErrorBox title="Not saved" message={error} />}
      </div>
    </Dialog>
  );
}
