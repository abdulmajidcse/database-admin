/**
 * Query results, changesets, plans and tree nodes — the shapes that cross the
 * HTTP boundary between the server layer and the React UI. Shared: no Node,
 * no React imports.
 */

import type { BaseType, Cell, Row } from './wire';
import type { EngineKind } from './schema-model';

export interface ColumnMeta {
  name: string;
  /** The engine's own type name for display. */
  typeName: string;
  base: BaseType;
  nullable?: boolean;
  /** Source table, when the driver can tell us — needed for editability. */
  table?: string;
  schema?: string;
  /** Part of the result's unique key, so the grid can build a WHERE clause. */
  isKey?: boolean;
  /** SQLite columns can hold mixed types per row (§6). */
  dynamicType?: boolean;
}

export interface ResultSet {
  /** Statement that produced this set, for the result-tab label. */
  statement: string;
  columns: ColumnMeta[];
  rows: Row[];
  /** True when more rows remain behind the cursor. */
  truncated: boolean;
  /** Handle for fetchMore(); absent when the result is complete. */
  cursorId?: string;
  /** Rows affected by a DML statement. */
  affectedRows?: number;
  insertId?: string;
  durationMs: number;
  /** Server notices/warnings (Postgres NOTICE, MySQL warnings). */
  notices?: string[];
  /** Editability: the table and key columns, when this is a simple single-table select. */
  editTarget?: { schema?: string; table: string; keyColumns: string[] } | null;
  /** Why the result is not editable, shown in the UI. */
  readOnlyReason?: string;
}

export interface ResultChunk {
  rows: Row[];
  truncated: boolean;
}

export interface RunOpts {
  /** Max rows to materialize before handing back a cursor. */
  maxRows?: number;
  /** Identifier so the UI can cancel this run. */
  runId?: string;
  /** Pin to a specific session (transaction mode). */
  sessionId?: string;
  /** Bound parameters, when the caller built the SQL itself. */
  params?: unknown[];
  database?: string;
  schema?: string;
  signal?: AbortSignal;
}

/** One executed statement in a multi-statement script. */
export interface StatementResult {
  index: number;
  statement: string;
  result?: ResultSet;
  error?: { message: string; code?: string; position?: number; detail?: string };
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Changesets (PLAN §6 "Grid editing")
// ---------------------------------------------------------------------------

export interface RowKey {
  /** Column name → lossless value identifying exactly one row. */
  [column: string]: Cell;
}

export type ChangeOp =
  | { op: 'update'; key: RowKey; values: Record<string, Cell> }
  | { op: 'insert'; values: Record<string, Cell> }
  | { op: 'delete'; key: RowKey };

export interface Changeset {
  schema?: string;
  table: string;
  keyColumns: string[];
  changes: ChangeOp[];
}

export interface ChangePreview {
  /** Exactly the SQL that will run, in order. */
  statements: string[];
  /** Rows each statement is expected to touch; a mismatch aborts the apply. */
  expectedAffected: number[];
  warnings: string[];
}

export interface ApplyResult {
  applied: number;
  statements: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Plans, sessions, tree
// ---------------------------------------------------------------------------

export interface ExplainNode {
  label: string;
  detail?: string;
  /** Estimated and (with ANALYZE) actual costs. */
  estimatedCost?: number;
  estimatedRows?: number;
  actualRows?: number;
  actualTimeMs?: number;
  loops?: number;
  /** Share of total runtime, 0..1 — drives the flame bar. */
  share?: number;
  children: ExplainNode[];
  /** Anything the engine reported that we did not model. */
  extra?: Record<string, unknown>;
}

export interface ExplainPlan {
  engine: EngineKind;
  analyzed: boolean;
  root: ExplainNode;
  totalTimeMs?: number;
  planningTimeMs?: number;
  /** Raw text/JSON, always available as a fallback view. */
  raw: string;
}

export interface ServerInfo {
  version: string;
  versionNumber?: number;
  edition?: string;
  uptimeSeconds?: number;
  /** Measured round-trip latency, drives adaptive defaults (§8.3). */
  rttMs: number;
  /** Extra facts for the connection header. */
  details?: Record<string, string>;
}

export type TreeNodeKind =
  | 'server'
  | 'database'
  | 'schema'
  | 'table-folder'
  | 'view-folder'
  | 'routine-folder'
  | 'sequence-folder'
  | 'trigger-folder'
  | 'index-folder'
  | 'column-folder'
  | 'table'
  | 'view'
  | 'materialized-view'
  | 'column'
  | 'index'
  | 'foreign-key'
  | 'routine'
  | 'sequence'
  | 'trigger'
  | 'enum'
  | 'keyspace'
  | 'key'
  | 'collection'
  | 'mongo-index';

export interface TreeNode {
  /** Stable path id, e.g. `db:app/schema:public/table:users`. */
  id: string;
  kind: TreeNodeKind;
  label: string;
  /** Secondary text shown dimmed on the right. */
  detail?: string;
  hasChildren: boolean;
  /** Anything the UI needs to open the right editor. */
  meta?: Record<string, unknown>;
}

export interface TreePath {
  /** Empty for the root. Segments are `kind:name`. */
  segments: string[];
}

export interface SessionInfo {
  id: string;
  connectionId: string;
  inTransaction: boolean;
  autoCommit: boolean;
  backendId?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Redis / Mongo shapes
// ---------------------------------------------------------------------------

export type RedisValueType = 'string' | 'list' | 'set' | 'zset' | 'hash' | 'stream' | 'none';

export interface KeyMeta {
  key: string;
  type: RedisValueType;
  ttlMs: number;
  sizeBytes?: number;
  length?: number;
}

export interface ScanCursor {
  cursor: string;
  match?: string;
  count?: number;
  db?: number;
  /** Per-node cursors in cluster mode. */
  nodeCursors?: Record<string, string>;
}

export type TypedValue =
  | { type: 'string'; value: string }
  | { type: 'list'; items: string[]; total: number }
  | { type: 'set'; members: string[]; total: number }
  | { type: 'zset'; members: { member: string; score: string }[]; total: number }
  | { type: 'hash'; fields: { field: string; value: string }[]; total: number }
  | { type: 'stream'; entries: { id: string; fields: Record<string, string> }[]; total: number }
  | { type: 'none' };

export interface Namespace {
  database: string;
  collection: string;
}

export interface FindOpts {
  projection?: Record<string, 0 | 1>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}

export interface IndexInfo {
  name: string;
  keys: Record<string, 1 | -1 | string>;
  unique?: boolean;
  sparse?: boolean;
  ttlSeconds?: number;
  sizeBytes?: number;
}

/** A live server-side session/process, for the monitor (§6 power tools). */
export interface ProcessInfo {
  id: string;
  user?: string;
  client?: string;
  database?: string;
  state?: string;
  command?: string;
  durationMs?: number;
  query?: string;
  waitEvent?: string;
  blockedBy?: string;
}
