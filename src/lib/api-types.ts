/**
 * The HTTP + WebSocket contract between the React UI and the server layer.
 * Both sides code against this file. Shared: no Node, no React imports.
 */

import type { ConnectionConfig, ConnectionInput } from './connection';
import type { EngineKind, IntrospectScope, SchemaModel, TableModel } from './schema-model';
import type {
  ApplyResult,
  ChangePreview,
  Changeset,
  ColumnMeta,
  ExplainPlan,
  IndexInfo,
  KeyMeta,
  ProcessInfo,
  ResultChunk,
  ResultSet,
  ScanCursor,
  ServerInfo,
  StatementResult,
  TreeNode,
  TypedValue,
} from './results';
import type { Row } from './wire';

export interface ApiError {
  error: string;
  code?: string;
  detail?: string;
  position?: number;
  /** Set when the failure has a known, actionable fix (e.g. §10.3 loopback). */
  hint?: string;
}

export type ApiResult<T> = T | ApiError;

export function isApiError(v: unknown): v is ApiError {
  return typeof v === 'object' && v !== null && 'error' in v;
}

// --- account / session -----------------------------------------------------

/**
 * What the shell asks for first (§9.2). `exists: false` means first run — show
 * "create your account"; `signedIn: false` means show sign-in. The vault fields
 * ride along because signing in unlocks the vault in the same step, so the app
 * can render straight through without a second round trip.
 */
export interface AccountStatus {
  exists: boolean;
  signedIn: boolean;
  username: string | null;
  vault: VaultStatus;
}

// --- vault -----------------------------------------------------------------

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  isContainer: boolean;
  sqliteRoot: string;
  exportRoot: string;
}

// --- connections -----------------------------------------------------------

export interface ConnectionListResponse {
  connections: ConnectionConfig[];
  states: Record<string, ConnectionState>;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export interface TestConnectionResponse {
  ok: boolean;
  info?: ServerInfo;
  error?: string;
  hint?: string;
}

export type ConnectionUpsertRequest = ConnectionInput;

// --- schema / tree ---------------------------------------------------------

export interface TreeRequest {
  connectionId: string;
  /** Empty for the root. */
  path: string[];
}

export interface TreeResponse {
  nodes: TreeNode[];
}

export interface SchemaRequest {
  connectionId: string;
  scope?: IntrospectScope;
  force?: boolean;
}

export interface SchemaResponse {
  model: SchemaModel;
  fetchedAt: number;
  /** Drives the "schema from 12m ago" indicator (§6). */
  ageMs: number;
}

// --- query -----------------------------------------------------------------

export interface QueryRequest {
  connectionId: string;
  sql: string;
  /** Run every statement in the script, or just this one. */
  mode?: 'script' | 'single';
  maxRows?: number;
  runId: string;
  sessionId?: string;
  database?: string;
  schema?: string;
}

export interface QueryResponse {
  results: StatementResult[];
  runId: string;
}

export interface FetchMoreRequest {
  connectionId: string;
  cursorId: string;
  count: number;
}

export type FetchMoreResponse = ResultChunk;

export interface CancelRequest {
  connectionId: string;
  runId: string;
}

export interface TableReadRequestApi {
  connectionId: string;
  schema?: string;
  table: string;
  offset: number;
  limit: number;
  orderBy?: { column: string; direction: 'asc' | 'desc' }[];
  filters?: unknown[];
  where?: string;
}

export interface TableCountResponse {
  count: number;
  estimated: boolean;
}

// --- editing ---------------------------------------------------------------

export interface ChangesetRequest {
  connectionId: string;
  changeset: Changeset;
}

export type ChangesetPreviewResponse = ChangePreview;
export type ChangesetApplyResponse = ApplyResult;

export interface DdlRequest {
  connectionId: string;
  current: TableModel | null;
  desired: TableModel;
}

export interface DdlResponse {
  statements: string[];
  warnings: string[];
}

// --- explain / monitor -----------------------------------------------------

export interface ExplainRequest {
  connectionId: string;
  sql: string;
  analyze: boolean;
}

export type ExplainResponse = ExplainPlan;

export interface ProcessListResponse {
  processes: ProcessInfo[];
}

// --- redis -----------------------------------------------------------------

export interface RedisScanRequest {
  connectionId: string;
  cursor: ScanCursor;
}

export interface RedisScanResponse {
  keys: KeyMeta[];
  next: ScanCursor;
  done: boolean;
}

export interface RedisKeyRequest {
  connectionId: string;
  key: string;
  offset?: number;
  limit?: number;
}

export interface RedisKeyResponse {
  value: TypedValue;
  ttlMs: number;
}

export interface RedisCommandRequest {
  connectionId: string;
  argv: string[];
}

// --- mongo -----------------------------------------------------------------

export interface MongoFindRequest {
  connectionId: string;
  database: string;
  collection: string;
  filter: string;
  projection?: string;
  sort?: string;
  limit: number;
  skip: number;
}

export interface MongoAggregateRequest {
  connectionId: string;
  database: string;
  collection: string;
  pipeline: string;
  limit?: number;
}

export interface MongoIndexesResponse {
  indexes: IndexInfo[];
}

// --- transfer / jobs -------------------------------------------------------

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'ndjson' | 'xlsx' | 'markdown' | 'html' | 'sql';

export interface ExportRequest {
  connectionId: string;
  /** What to export. */
  source:
    | { kind: 'query'; sql: string }
    | { kind: 'table'; schema?: string; table: string; where?: string }
    | { kind: 'database'; database: string; tables?: string[] }
    | { kind: 'server' };
  format: ExportFormat;
  destination: { kind: 'file'; path: string } | { kind: 'download' };
  options: ExportOptions;
}

export interface ExportOptions {
  compression?: 'none' | 'gzip';
  structure: 'both' | 'structure-only' | 'data-only';
  binaryEncoding: 'base64' | 'hex';
  nullLiteral: string;
  delimiter?: string;
  header?: boolean;
  batchSize?: number;
  /** Prefer the bundled mysqldump/pg_dump over the built-in engine (§7.2). */
  useNativeTool?: boolean;
  /** Run the dump on the remote host and stream compressed bytes back (§8.4). */
  remoteSide?: boolean;
  stripDefiner?: boolean;
  pgFormat?: 'custom' | 'plain';
}

export interface ImportRequest {
  connectionId: string;
  source: { kind: 'csv' | 'json' | 'ndjson' | 'sql' | 'dump'; path: string };
  target?: { schema?: string; table: string; createTable?: boolean };
  mapping?: ColumnMapping[];
  options: ImportOptions;
}

export interface ColumnMapping {
  sourceIndex: number;
  sourceName: string;
  targetColumn: string | null;
  targetType?: string;
  dateFormat?: string;
  nullLiteral?: string;
  trim?: boolean;
}

export interface ImportOptions {
  onConflict: 'insert' | 'upsert' | 'replace' | 'ignore';
  truncateFirst: boolean;
  disableForeignKeys: boolean;
  batchSize: number;
  wrapInTransaction: boolean;
  continueOnError: boolean;
  dryRun: boolean;
  useFastPath: boolean;
}

export interface CsvPreviewRequest {
  path: string;
}

export interface CsvPreviewResponse {
  dialect: {
    delimiter: string;
    quote: string;
    encoding: string;
    hasHeader: boolean;
    bom: boolean;
  };
  headers: string[];
  rows: string[][];
  inferredTypes: string[];
}

export interface JobSummary {
  id: string;
  kind: 'export' | 'import' | 'restore' | 'copy';
  title: string;
  connectionId: string | null;
  status: 'queued' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';
  progress: {
    phase: string;
    tablesDone: number;
    tablesTotal: number;
    rowsDone: number;
    bytesOut: number;
    etaMs?: number;
  };
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  createdAt: number;
}

export interface JobDetail extends JobSummary {
  log: string[];
  params: unknown;
}

export interface NativeToolsResponse {
  tools: { name: string; path: string | null; version: string | null }[];
}

// --- schema compare --------------------------------------------------------

export interface CompareRequest {
  sourceConnectionId: string;
  targetConnectionId: string;
  sourceScope?: IntrospectScope;
  targetScope?: IntrospectScope;
  options?: {
    ignoreCase?: boolean;
    ignoreCollation?: boolean;
    ignoreComments?: boolean;
    ignoreIndexNames?: boolean;
  };
}

export interface CompareResponse {
  diff: unknown;
  migration: { statements: string[]; destructive: string[]; warnings: string[] };
}

// --- history / saved -------------------------------------------------------

export interface HistoryEntry {
  id: number;
  connection_id: string | null;
  sql: string;
  db_context: string | null;
  started_at: number;
  duration_ms: number | null;
  row_count: number | null;
  status: string;
  error: string | null;
}

export interface SavedQuery {
  id: string;
  name: string;
  folder: string;
  sql: string;
  connection_id: string | null;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export type ClientMessage =
  // Legacy no-op: the session cookie authenticates the handshake itself (§9.2).
  | { type: 'auth' }
  | { type: 'subscribe'; channel: WsChannel; connectionId?: string; arg?: string }
  | { type: 'unsubscribe'; channel: WsChannel; connectionId?: string; arg?: string }
  | { type: 'redis-command'; connectionId: string; argv: string[]; id: string }
  | { type: 'ping' };

export type WsChannel = 'jobs' | 'connection-state' | 'redis-monitor' | 'redis-pubsub' | 'processes' | 'query-progress';

export type ServerMessage =
  | { type: 'ready' }
  | { type: 'auth-failed'; message: string }
  | { type: 'job-update'; job: JobSummary }
  | { type: 'job-log'; jobId: string; lines: string[] }
  | { type: 'connection-state'; connectionId: string; state: ConnectionState; message?: string }
  | { type: 'redis-monitor'; connectionId: string; lines: string[] }
  | { type: 'redis-pubsub'; connectionId: string; channel: string; message: string }
  | { type: 'processes'; connectionId: string; processes: ProcessInfo[] }
  | { type: 'query-progress'; runId: string; rows: number; phase: string }
  | { type: 'pong' };

// Re-export so UI modules import result shapes from one place.
export type { ColumnMeta, ResultSet, Row, EngineKind, TreeNode, SchemaModel, ServerInfo };
