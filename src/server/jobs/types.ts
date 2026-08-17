/**
 * Job types (PLAN §7.3 "Jobs, because these run for hours").
 *
 * A 50 GB dump cannot live inside an HTTP request: the route creates a job,
 * returns its id, and the work continues detached while progress streams over
 * the WebSocket and is persisted so the jobs drawer survives a page reload.
 *
 * Server-side only — but every shape here is plain JSON so it can be handed to
 * the UI through `JobSummary`/`JobDetail` in lib/api-types without translation.
 * No React, no Next imports (PLAN §11).
 */

import type {
  ColumnMapping,
  ExportFormat,
  ExportOptions,
  ImportOptions,
  JobSummary,
} from '../../lib/api-types';

// ---------------------------------------------------------------------------
// The job itself
// ---------------------------------------------------------------------------

export type JobKind = 'export' | 'import' | 'restore' | 'copy';

export type JobStatus = 'queued' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

/** Terminal states: nothing is running and the row will never change again. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ['done', 'failed', 'cancelled'];

export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'running', 'cancelling'];

export interface JobProgress {
  /** Free-text stage shown in the drawer, e.g. `dumping public.orders`. */
  phase: string;
  tablesDone: number;
  tablesTotal: number;
  rowsDone: number;
  bytesOut: number;
  /** Computed by the manager from rowsDone over elapsed time — runners never set it. */
  etaMs?: number;
  /**
   * Optional denominator for the ETA. Not part of the §7.3 sketch, but without
   * it a row rate is not a forecast; connectors have `rowEstimate` from the
   * catalog (§4 TableModel) so this costs nothing to supply.
   */
  rowsTotal?: number;
}

export interface Job {
  id: string;
  kind: JobKind;
  /** Human label for the drawer, e.g. "Export public.orders → orders.csv". */
  title: string;
  /**
   * PLAN §7.3 types this `string`; it is widened to `string | null` to match the
   * frozen `jobs.connection_id` column and `JobSummary` — a cross-engine copy
   * (§7.6) has two connections and neither is "the" one, so it carries them in
   * `params` instead.
   */
  connectionId: string | null;
  params: JobParams;
  status: JobStatus;
  progress: JobProgress;
  /** Null until the job leaves the queue. */
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  /** Whatever the runner returned — output path, byte count, error report. */
  result: unknown;
  /** Ring buffer capped at LOG_CAP lines, tailed live and persisted as log_tail. */
  log: string[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Params — one variant per kind, discriminated on `kind` so a route can narrow
// after reading a persisted row (PLAN §7.3).
// ---------------------------------------------------------------------------

export type ExportSource =
  | { kind: 'query'; sql: string; database?: string; schema?: string }
  | { kind: 'table'; schema?: string; table: string; where?: string; columns?: string[] }
  | { kind: 'database'; database: string; tables?: string[] }
  | { kind: 'server' };

/**
 * A job never writes to an HTTP response: by the time a 50 GB dump finishes the
 * request is long gone (§7.3). `download` therefore still means a file — one
 * the manager put under $DBADMIN_HOME/tmp for a later GET to stream back.
 */
export type ExportDestination =
  | { kind: 'file'; path: string }
  | { kind: 'download'; path: string; filename: string };

export interface ExportJobParams {
  kind: 'export';
  source: ExportSource;
  format: ExportFormat;
  destination: ExportDestination;
  options: ExportOptions;
}

export interface ImportJobParams {
  kind: 'import';
  /** `bundle` is a directory loaded as one table per file (§7.1). */
  source: { kind: 'csv' | 'json' | 'ndjson' | 'bundle'; path: string; encoding?: string };
  /** A bundle leaves `table` empty and takes each table name from a filename. */
  target: { schema?: string; table: string; createTable?: boolean };
  /** Per-column mapping from the CSV wizard (§7.4). */
  mapping?: ColumnMapping[];
  options: ImportOptions;
}

/** §7.5: restore has its own knobs — definers, ownership, ordering — that an import does not. */
export interface RestoreOptions {
  useNativeTool?: boolean;
  /** `pg_restore -j`. Ignored by the built-in SQL script runner. */
  parallel?: number;
  dropExisting?: boolean;
  /** Postgres `--no-owner` / `--no-privileges` (§7.5). */
  noOwner?: boolean;
  noPrivileges?: boolean;
  /** MySQL dumps embed `DEFINER=user@host`, which fails on another host (§7.5). */
  stripDefiner?: boolean;
  disableForeignKeys?: boolean;
  continueOnError?: boolean;
  singleTransaction?: boolean;
  dryRun?: boolean;
}

export interface RestoreJobParams {
  kind: 'restore';
  source: { kind: 'sql' | 'dump'; path: string; compression?: 'none' | 'gzip' };
  target?: { database?: string };
  options: RestoreOptions;
}

/** §7.6 cross-engine copy: same pipeline, different sink, canonical model does the type mapping. */
export interface CopyJobParams {
  kind: 'copy';
  source: {
    connectionId: string;
    database?: string;
    schema?: string;
    tables: { table: string; where?: string }[];
  };
  target: {
    connectionId: string;
    database?: string;
    schema?: string;
    /** source table name → target table name, when they differ. */
    rename?: Record<string, string>;
    createMissing: boolean;
  };
  options: ImportOptions & {
    /** Show the proposed target DDL and lossy conversions before writing (§7.6). */
    reviewDdl?: boolean;
  };
}

export type JobParams = ExportJobParams | ImportJobParams | RestoreJobParams | CopyJobParams;

// ---------------------------------------------------------------------------
// Runner contract — deliberately generic, because §7.3 says this gets reused
// for long DDL and migrations.
// ---------------------------------------------------------------------------

/**
 * The subset of `ChildProcess` cancellation needs. Structural, so a spawned
 * `mysqldump` satisfies it directly and an ssh2 remote channel (§8.4) can be
 * adapted with a three-line wrapper instead of pulling ssh2 into this module.
 */
export interface JobChild {
  readonly pid?: number | null;
  readonly killed?: boolean;
  readonly exitCode?: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Runs when the user cancels: kill the DB-side query, not just the pipe (§7.3). */
export type CancelHook = () => void | Promise<void>;

export interface JobContext {
  readonly jobId: string;
  /** Aborted on cancel; pass it into `RunOpts.signal` and `stream.pipeline`. */
  readonly signal: AbortSignal;
  /** Absolute values, not deltas. Coalesced by the manager before it emits. */
  progress(patch: Partial<JobProgress>): void;
  /** Embedded newlines are split into separate ring-buffer entries. */
  log(line: string): void;
  /** Registered children get SIGTERM then SIGKILL on cancel (§7.3). */
  registerChild(child: JobChild): void;
  /** Multiple hooks are allowed; all run concurrently on cancel. */
  onCancel(hook: CancelHook): void;
}

/** Anything returned is persisted as `result_json` and shown when the job is reopened. */
export type JobRunner = (ctx: JobContext) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Events + queries
// ---------------------------------------------------------------------------

/**
 * Exactly the two `ServerMessage` variants the WebSocket relays, so the bridge
 * in ./index can pass an event straight to `broadcast()` (§7.3, §2).
 */
export type JobEvent =
  | { type: 'job-update'; job: JobSummary }
  | { type: 'job-log'; jobId: string; lines: string[] };

/** The job is passed alongside so the bridge can also fan out per connection. */
export type JobListener = (event: JobEvent, job: Readonly<Job>) => void;

export interface JobListOptions {
  connectionId?: string;
  kind?: JobKind;
  status?: JobStatus | JobStatus[];
  /** Shorthand for status in (queued, running, cancelling). */
  active?: boolean;
  limit?: number;
  offset?: number;
}

export interface JobManagerOptions {
  /** Parallel jobs; the rest queue. A dump saturates a link, so the default is low. */
  concurrency?: number;
  /** Finished jobs older than this are dropped on startup and by cleanup(). */
  retentionDays?: number;
}
