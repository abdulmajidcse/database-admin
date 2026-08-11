/**
 * Connector interfaces (PLAN §4).
 *
 * A narrow base plus capability-gated extensions. The mistake to avoid is one
 * giant interface pretending Redis is a SQL database — so SQL, key/value and
 * document engines get their own sub-interfaces and the UI picks a workspace
 * mode from `capabilities`.
 *
 * Rule from §8.1: connectors NEVER know how they were reached. The AccessResolver
 * hands them an already-usable ResolvedAddress.
 */

import type { Address, ConnectionConfig } from '../../lib/connection';
import type { EngineKind, IntrospectScope, SchemaModel, TableModel } from '../../lib/schema-model';
import type {
  ApplyResult,
  ChangePreview,
  Changeset,
  ExplainPlan,
  FindOpts,
  IndexInfo,
  KeyMeta,
  Namespace,
  ProcessInfo,
  ResultChunk,
  ResultSet,
  RunOpts,
  ScanCursor,
  ServerInfo,
  SessionInfo,
  TreeNode,
  TreePath,
  TypedValue,
} from '../../lib/results';
import type { Row } from '../../lib/wire';

export type Capability =
  | 'sql'
  | 'transactions'
  | 'explain'
  | 'ddl'
  | 'routines'
  | 'schemas'
  | 'multipleDatabases'
  | 'keyspace'
  | 'documents'
  | 'aggregation'
  | 'processList'
  | 'cancel'
  | 'streaming';

/** What the AccessResolver produced: an address the driver can dial right now. */
export interface ResolvedAddress {
  address: Address;
  /** True when a tunnel/proxy sits in front; used for logging and adaptive defaults. */
  tunneled: boolean;
  /** The address the user configured, for display. */
  original: Address;
  /** Release the tunnel refcount. */
  release(): Promise<void>;
}

/** Everything a connector needs to open a link. Secrets are already decrypted. */
export interface ConnectorContext {
  config: ConnectionConfig;
  resolved: ResolvedAddress;
  password?: string;
  /** Emitted for the connection-state indicator and the app log. */
  onEvent?: (e: ConnectorEvent) => void;
}

export type ConnectorEvent =
  | { type: 'state'; state: 'connecting' | 'connected' | 'reconnecting' | 'closed'; message?: string }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string };

export interface Connector {
  readonly kind: EngineKind;
  readonly capabilities: ReadonlySet<Capability>;

  open(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<ServerInfo>;
  /** Lazy tree, one level at a time. */
  listNodes(path: TreePath): Promise<TreeNode[]>;
}

export interface SqlConnector extends Connector {
  /** Run one statement. Returns at most `maxRows` and a cursor for the rest. */
  query(sql: string, opts: RunOpts): Promise<ResultSet>;
  fetchMore(cursorId: string, n: number): Promise<ResultChunk>;
  closeCursor(cursorId: string): Promise<void>;
  /** Unbounded streaming for export/copy. Never buffers. */
  stream(sql: string, opts: RunOpts): AsyncIterable<Row[]>;
  cancel(runId: string): Promise<void>;

  /**
   * Introspect into the canonical model. MUST use a fixed number of round trips
   * regardless of table count (§8.3) — no per-table loops.
   */
  introspect(scope: IntrospectScope): Promise<SchemaModel>;

  /** Read a page of a table with server-side sort/filter. */
  readTable(req: TableReadRequest): Promise<ResultSet>;
  countTable(req: Omit<TableReadRequest, 'offset' | 'limit' | 'orderBy'>): Promise<number>;

  generateDdl(target: DdlTarget): Promise<string>;
  /** Render the SQL a changeset would run, without running it. */
  previewChangeset(cs: Changeset): Promise<ChangePreview>;
  applyChangeset(cs: Changeset): Promise<ApplyResult>;
  /** Turn a desired table shape into migration DDL (create or alter). */
  planTableDdl(current: TableModel | null, desired: TableModel): Promise<string[]>;

  explain(sql: string, analyze: boolean): Promise<ExplainPlan>;

  /** Pinned connections for transaction mode (§6 "Sessions vs pools"). */
  openSession(): Promise<SessionInfo>;
  closeSession(sessionId: string): Promise<void>;
  sessionCommand(sessionId: string, cmd: 'begin' | 'commit' | 'rollback'): Promise<void>;

  listProcesses?(): Promise<ProcessInfo[]>;
  killProcess?(id: string): Promise<void>;

  /** Identifier quoting for this engine — never string-concatenate identifiers. */
  quoteIdent(name: string): string;
  quoteLiteral(value: string): string;
}

export interface TableReadRequest {
  schema?: string;
  table: string;
  columns?: string[];
  offset: number;
  limit: number;
  orderBy?: { column: string; direction: 'asc' | 'desc' }[];
  filters?: ColumnFilter[];
  /** Raw WHERE the user typed in the filter bar. */
  where?: string;
}

export type FilterOperator =
  | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'contains' | 'startsWith' | 'endsWith'
  | 'isNull' | 'isNotNull' | 'in' | 'between';

export interface ColumnFilter {
  column: string;
  op: FilterOperator;
  value?: string;
  value2?: string;
  values?: string[];
}

export type DdlTarget =
  | { type: 'table'; schema?: string; name: string }
  | { type: 'view'; schema?: string; name: string }
  | { type: 'routine'; schema?: string; name: string }
  | { type: 'index'; schema?: string; table: string; name: string }
  | { type: 'database'; name: string };

export interface KeyValueConnector extends Connector {
  scanKeys(cur: ScanCursor): Promise<{ keys: KeyMeta[]; next: ScanCursor; done: boolean }>;
  readKey(key: string, opts?: { offset?: number; limit?: number }): Promise<TypedValue>;
  writeKey(key: string, value: TypedValue, ttlMs?: number): Promise<void>;
  deleteKeys(keys: string[]): Promise<number>;
  renameKey(from: string, to: string): Promise<void>;
  expireKey(key: string, ttlMs: number | null): Promise<void>;
  /** Raw CLI console. */
  command(argv: string[]): Promise<unknown>;
  /** MONITOR / pub-sub, streamed over WebSocket. */
  subscribe(channel: string, sink: (msg: unknown) => void): () => void;
  monitor(sink: (line: string) => void): () => void;
  listDatabases(): Promise<{ index: number; keys: number }[]>;
  info(): Promise<Record<string, Record<string, string>>>;
}

export interface DocumentConnector extends Connector {
  listDatabases(): Promise<{ name: string; sizeBytes?: number }[]>;
  listCollections(database: string): Promise<{ name: string; type: string; count?: number }[]>;
  find(ns: Namespace, filter: unknown, opts: FindOpts): Promise<ResultSet>;
  count(ns: Namespace, filter: unknown): Promise<number>;
  aggregate(ns: Namespace, pipeline: unknown[], opts?: { limit?: number }): Promise<ResultSet>;
  insert(ns: Namespace, docs: unknown[]): Promise<{ inserted: number }>;
  replace(ns: Namespace, id: unknown, doc: unknown): Promise<{ modified: number }>;
  deleteDocs(ns: Namespace, ids: unknown[]): Promise<{ deleted: number }>;
  indexes(ns: Namespace): Promise<IndexInfo[]>;
  createIndex(ns: Namespace, spec: IndexInfo): Promise<void>;
  dropIndex(ns: Namespace, name: string): Promise<void>;
  explainFind(ns: Namespace, filter: unknown, opts: FindOpts): Promise<ExplainPlan>;
  listProcesses(): Promise<ProcessInfo[]>;
  killProcess(id: string): Promise<void>;
}

export function isSqlConnector(c: Connector): c is SqlConnector {
  return c.capabilities.has('sql');
}
export function isKeyValueConnector(c: Connector): c is KeyValueConnector {
  return c.capabilities.has('keyspace');
}
export function isDocumentConnector(c: Connector): c is DocumentConnector {
  return c.capabilities.has('documents');
}

/** Factory registered per engine. */
export type ConnectorFactory = (ctx: ConnectorContext) => Connector;

/** Error carrying an engine code so the UI can special-case (e.g. SQLITE_BUSY). */
export class DbError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly detail?: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'DbError';
  }
}
