/**
 * JobManager (PLAN §7.3).
 *
 * "A 50 GB dump cannot live inside an HTTP request." So: create → run detached
 * → stream progress over the existing WebSocket → cancel (kills the child
 * process *and* the DB-side query) → persist to the `jobs` table with a log tail
 * you can reopen.
 *
 * Two rules shape the whole file:
 *
 *  1. **Nothing here is ever awaited by a request.** `create()` writes a row,
 *     enqueues, and returns. The runner starts on a later tick.
 *  2. **Memory is the fast path, SQLite is the durable one.** Progress and log
 *     lines are emitted to subscribers immediately (coalesced so a 200k rows/s
 *     import cannot flood the socket) but written to SQLite only ~every 500 ms,
 *     because a fsync per row would dominate the runtime of the actual export.
 *
 * The runner interface is deliberately generic — §7.3 says this gets reused for
 * long DDL and migrations, so it knows nothing about dumps.
 *
 * The WebSocket bridge lives in ./index; import the subsystem through
 * `src/server/jobs` rather than this file so the `jobs` channel gets wired up.
 *
 * Server-side only: no React, no Next (PLAN §11).
 */

import { randomUUID } from 'node:crypto';
// Explicit node:timers import: the DOM lib is in scope (tsconfig), and its
// setTimeout returns a number rather than a NodeJS.Timeout we can unref().
import { clearTimeout, setImmediate, setTimeout } from 'node:timers';
import type Database from 'better-sqlite3';
import type { JobDetail, JobSummary } from '../../lib/api-types';
import { getDb } from '../store/db';
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  type CancelHook,
  type Job,
  type JobChild,
  type JobContext,
  type JobEvent,
  type JobKind,
  type JobListOptions,
  type JobListener,
  type JobManagerOptions,
  type JobParams,
  type JobProgress,
  type JobRunner,
  type JobStatus,
} from './types';

// --- tuning -----------------------------------------------------------------

/** §7.3 "ring buffer, tailed live". Enough to diagnose a failure, small enough to ship on every reopen. */
const LOG_CAP = 2000;
/** A single log line from a native tool can be pathological; keep the row sane. */
const LOG_LINE_MAX = 4000;
/** Ceiling on the persisted tail so one job cannot bloat the app database. */
const LOG_TAIL_MAX_CHARS = 256 * 1024;
/** §7.3: persist throttled so the drawer survives a reload without fsyncing per row. */
const PERSIST_INTERVAL_MS = 500;
/** Socket coalescing window. Below human perception, above per-row chatter. */
const EMIT_INTERVAL_MS = 120;
/** SIGTERM → SIGKILL grace. pg_dump/mysqldump need a moment to close their output. */
const KILL_GRACE_MS = 8_000;
/** If a runner ignores both the abort and the kill, stop waiting and free the slot. */
const CANCEL_FORCE_MS = KILL_GRACE_MS * 2;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Repository — the `jobs` table from store/schema.sql
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  kind: string;
  connection_id: string | null;
  title: string;
  params_json: string;
  status: string;
  progress_json: string;
  log_tail: string;
  result_json: string | null;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

/**
 * Statements are re-prepared whenever the handle changes (tests call closeDb()),
 * otherwise reused: progress persistence runs twice a second per job.
 */
let stmtDb: Database.Database | null = null;
const stmtCache = new Map<string, Database.Statement>();

function stmt(sql: string): Database.Statement {
  const db = getDb();
  if (db !== stmtDb) {
    stmtCache.clear();
    stmtDb = db;
  }
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

/** Newline-joined; `log()` splits embedded newlines on the way in, so this round-trips. */
function serializeLog(lines: string[]): string {
  let text = lines.join('\n');
  if (text.length > LOG_TAIL_MAX_CHARS) text = text.slice(text.length - LOG_TAIL_MAX_CHARS);
  return text;
}

function deserializeLog(tail: string): string[] {
  return tail === '' ? [] : tail.split('\n');
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind as JobKind,
    title: r.title,
    connectionId: r.connection_id,
    params: JSON.parse(r.params_json) as JobParams,
    status: r.status as JobStatus,
    progress: JSON.parse(r.progress_json) as JobProgress,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    error: r.error,
    result: r.result_json === null ? null : (JSON.parse(r.result_json) as unknown),
    log: deserializeLog(r.log_tail),
    createdAt: r.created_at,
  };
}

const jobsRepo = {
  insert(job: Job): void {
    stmt(
      `INSERT INTO jobs (id, kind, connection_id, title, params_json, status, progress_json,
          log_tail, result_json, error, started_at, ended_at, created_at)
       VALUES (@id, @kind, @connectionId, @title, @params, @status, @progress,
          @logTail, @result, @error, @startedAt, @endedAt, @createdAt)`,
    ).run({
      id: job.id,
      kind: job.kind,
      connectionId: job.connectionId,
      title: job.title,
      params: JSON.stringify(job.params),
      status: job.status,
      progress: JSON.stringify(job.progress),
      logTail: serializeLog(job.log),
      result: job.result === null || job.result === undefined ? null : JSON.stringify(job.result),
      error: job.error,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      createdAt: job.createdAt,
    });
  },

  /** One statement for every mutable field: a job row is tiny and this stays honest. */
  save(job: Job): void {
    stmt(
      `UPDATE jobs SET status=@status, progress_json=@progress, log_tail=@logTail,
          result_json=@result, error=@error, started_at=@startedAt, ended_at=@endedAt
       WHERE id=@id`,
    ).run({
      id: job.id,
      status: job.status,
      progress: JSON.stringify(job.progress),
      logTail: serializeLog(job.log),
      result: job.result === null || job.result === undefined ? null : JSON.stringify(job.result),
      error: job.error,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
    });
  },

  get(id: string): Job | null {
    const r = stmt('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return r ? rowToJob(r) : null;
  },

  list(opts: JobListOptions): Job[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.connectionId) {
      where.push('connection_id = ?');
      params.push(opts.connectionId);
    }
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    const statuses = opts.active
      ? [...ACTIVE_STATUSES]
      : opts.status === undefined
        ? []
        : Array.isArray(opts.status)
          ? opts.status
          : [opts.status];
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    const sql =
      `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
      'ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    const rows = stmt(sql).all(...params) as JobRow[];
    return rows.map(rowToJob);
  },

  remove(id: string): void {
    stmt('DELETE FROM jobs WHERE id = ?').run(id);
  },

  /**
   * A job cannot outlive the process that ran it, so anything left active in the
   * table is the debris of a crash or restart — mark it failed rather than
   * showing a spinner that will never move (§7.3 "survives page reloads").
   */
  failOrphans(now: number): number {
    const info = stmt(
      `UPDATE jobs SET status='failed', ended_at=?, error=COALESCE(error, ?)
       WHERE status IN ('queued', 'running', 'cancelling')`,
    ).run(now, 'Interrupted by a server restart');
    return info.changes;
  },

  deleteFinishedBefore(cutoff: number): number {
    const info = stmt(
      `DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled')
         AND COALESCE(ended_at, created_at) < ?`,
    ).run(cutoff);
    return info.changes;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** AbortController rejections surface as AbortError / DOMException across Node APIs. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function emptyProgress(): JobProgress {
  return { phase: 'queued', tablesDone: 0, tablesTotal: 0, rowsDone: 0, bytesOut: 0 };
}

/**
 * ETA from throughput (§7.3). Rows are the honest unit — bytes lie under
 * compression and tables lie when one table is 90% of the database — so a row
 * total (from the catalog's `rowEstimate`) wins, with table fraction as the
 * fallback when the runner cannot know how many rows are coming.
 */
function computeEta(p: JobProgress, startedAt: number | null, now: number): number | undefined {
  if (startedAt === null) return undefined;
  const elapsed = now - startedAt;
  // Under a second the rate is noise and the ETA jumps around uselessly.
  if (elapsed < 1_000) return undefined;
  if (p.rowsTotal !== undefined && p.rowsTotal > 0 && p.rowsDone > 0) {
    const remaining = Math.max(p.rowsTotal - p.rowsDone, 0);
    return Math.round((remaining * elapsed) / p.rowsDone);
  }
  if (p.tablesTotal > 0 && p.tablesDone > 0 && p.tablesDone < p.tablesTotal) {
    const done = p.tablesDone / p.tablesTotal;
    return Math.round((elapsed * (1 - done)) / done);
  }
  return undefined;
}

function cloneJob(job: Job): Job {
  return { ...job, progress: { ...job.progress }, log: [...job.log] };
}

/**
 * The drawer's list payload: never carries the 2000-line log or the params blob,
 * and copies `progress` field by field so the internal `rowsTotal` denominator
 * stays out of the frozen `JobSummary` wire shape.
 */
export function toSummary(job: Readonly<Job>): JobSummary {
  const p = job.progress;
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    connectionId: job.connectionId,
    status: job.status,
    progress: {
      phase: p.phase,
      tablesDone: p.tablesDone,
      tablesTotal: p.tablesTotal,
      rowsDone: p.rowsDone,
      bytesOut: p.bytesOut,
      etaMs: p.etaMs,
    },
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    error: job.error,
    createdAt: job.createdAt,
  };
}

export function toDetail(job: Readonly<Job>): JobDetail {
  return { ...toSummary(job), log: [...job.log], params: job.params };
}

function killChild(child: JobChild, signal: NodeJS.Signals): void {
  // Already exited: kill() would be a no-op on a ChildProcess but can throw on
  // an adapter, and there is nothing to signal anyway.
  if (child.exitCode !== undefined && child.exitCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    /* the process is gone, which is the outcome we wanted */
  }
}

// ---------------------------------------------------------------------------
// Live (in-memory) state for jobs this process is running
// ---------------------------------------------------------------------------

interface LiveJob {
  job: Job;
  runner: JobRunner;
  controller: AbortController;
  children: Set<JobChild>;
  cancelHooks: CancelHook[];
  /** Log lines produced since the last emit. */
  pendingLog: string[];
  /** Progress changed since the last emit. */
  progressDirty: boolean;
  /** Anything changed since the last write to SQLite. */
  persistDirty: boolean;
  lastPersistAt: number;
  flushTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  forceTimer: NodeJS.Timeout | null;
  cancelRequested: boolean;
  finished: boolean;
  /** Removed while running: stop persisting and stop emitting for it. */
  removed: boolean;
}

// ---------------------------------------------------------------------------
// JobManager
// ---------------------------------------------------------------------------

export class JobManager {
  private readonly listeners = new Set<JobListener>();
  private readonly live = new Map<string, LiveJob>();
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  private concurrency: number;
  private readonly retentionDays: number;
  private initialized = false;

  constructor(opts: JobManagerOptions = {}) {
    const envConcurrency = Number(process.env.DBADMIN_JOB_CONCURRENCY);
    this.concurrency = Math.max(
      1,
      opts.concurrency ?? (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : DEFAULT_CONCURRENCY),
    );
    const envRetention = Number(process.env.DBADMIN_JOB_RETENTION_DAYS);
    this.retentionDays =
      opts.retentionDays ?? (Number.isFinite(envRetention) && envRetention > 0 ? envRetention : DEFAULT_RETENTION_DAYS);
  }

  /**
   * Touches SQLite on first use, not at import: pulling in this module from a
   * unit test must not create $DBADMIN_HOME.
   */
  private ensureInit(): void {
    if (this.initialized) return;
    this.initialized = true;
    jobsRepo.failOrphans(Date.now());
    this.cleanup(this.retentionDays);
  }

  // --- subscriptions ------------------------------------------------------

  /** The WebSocket bridge (./index) is the main subscriber; tests are the other. */
  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: JobEvent, job: Readonly<Job>): void {
    for (const listener of this.listeners) {
      try {
        listener(event, job);
      } catch {
        /* a bad subscriber must never take down a running export */
      }
    }
  }

  // --- creation and scheduling -------------------------------------------

  /**
   * Persist, enqueue, return. The runner has not started when this returns, so
   * a route can respond with the job id immediately (§7.3).
   */
  create(
    kind: JobKind,
    title: string,
    connectionId: string | null,
    params: JobParams,
    runner: JobRunner,
  ): Job {
    this.ensureInit();
    if (params.kind !== kind) {
      throw new Error(`Job kind "${kind}" does not match params kind "${params.kind}"`);
    }
    const job: Job = {
      id: randomUUID(),
      kind,
      title,
      connectionId,
      params,
      status: 'queued',
      progress: emptyProgress(),
      startedAt: null,
      endedAt: null,
      error: null,
      result: null,
      log: [],
      createdAt: Date.now(),
    };
    jobsRepo.insert(job);

    const live: LiveJob = {
      job,
      runner,
      controller: new AbortController(),
      children: new Set(),
      cancelHooks: [],
      pendingLog: [],
      progressDirty: false,
      persistDirty: false,
      lastPersistAt: Date.now(),
      flushTimer: null,
      killTimer: null,
      forceTimer: null,
      cancelRequested: false,
      finished: false,
      removed: false,
    };
    this.live.set(job.id, live);
    this.queue.push(job.id);
    this.emit({ type: 'job-update', job: toSummary(job) }, job);
    // setImmediate, not a direct call: the runner's first synchronous slice must
    // not execute inside the HTTP request that created it (§7.3 "run detached").
    setImmediate(() => this.pump());
    return cloneJob(job);
  }

  /** Concurrency cap (§7.3): a dump saturates the link, two at once is plenty. */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n));
    this.pump();
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) return;
      const live = this.live.get(id);
      // Cancelled or removed while queued.
      if (!live || live.finished || live.job.status !== 'queued') continue;
      this.start(live);
    }
  }

  private start(live: LiveJob): void {
    const now = Date.now();
    live.job.status = 'running';
    live.job.startedAt = now;
    live.job.progress.phase = 'starting';
    live.lastPersistAt = now;
    this.running.add(live.job.id);
    this.persist(live);
    this.emit({ type: 'job-update', job: toSummary(live.job) }, live.job);

    const ctx = this.makeContext(live);
    // Detached: the promise is never returned to a caller. Both settlement paths
    // land in finish(), which is the only place that frees the slot.
    void Promise.resolve()
      .then(() => live.runner(ctx))
      .then(
        (result) => this.finish(live, 'done', null, result),
        (err: unknown) => {
          if (live.cancelRequested || live.controller.signal.aborted || isAbortError(err)) {
            this.finish(live, 'cancelled', errorMessage(err));
          } else {
            this.finish(live, 'failed', errorMessage(err));
          }
        },
      );
  }

  private makeContext(live: LiveJob): JobContext {
    return {
      jobId: live.job.id,
      signal: live.controller.signal,

      progress: (patch: Partial<JobProgress>): void => {
        if (live.finished) return;
        const p = live.job.progress;
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          (p as unknown as Record<string, unknown>)[key] = value;
        }
        const eta = computeEta(p, live.job.startedAt, Date.now());
        if (eta === undefined) delete p.etaMs;
        else p.etaMs = eta;
        live.progressDirty = true;
        live.persistDirty = true;
        this.scheduleFlush(live);
      },

      log: (line: string): void => {
        if (live.finished) return;
        this.appendLog(live, line);
      },

      registerChild: (child: JobChild): void => {
        live.children.add(child);
        // Cancel can land between spawn and register; do not leak the process.
        if (live.cancelRequested) killChild(child, 'SIGTERM');
      },

      onCancel: (hook: CancelHook): void => {
        live.cancelHooks.push(hook);
        if (live.cancelRequested) void this.runHook(live, hook);
      },
    };
  }

  // --- log ring buffer ----------------------------------------------------

  private appendLog(live: LiveJob, line: string): void {
    // Split so the ring buffer counts real lines and log_tail round-trips.
    // Native tools on Windows-built images emit CRLF; strip the CR.
    for (const chunk of String(line).split('\n')) {
      const raw = chunk.endsWith('\r') ? chunk.slice(0, -1) : chunk;
      const text = raw.length > LOG_LINE_MAX ? `${raw.slice(0, LOG_LINE_MAX)}… (truncated)` : raw;
      live.job.log.push(text);
      live.pendingLog.push(text);
    }
    if (live.job.log.length > LOG_CAP) {
      live.job.log.splice(0, live.job.log.length - LOG_CAP);
    }
    live.persistDirty = true;
    this.scheduleFlush(live);
  }

  // --- flushing: emit fast, persist slow ----------------------------------

  private scheduleFlush(live: LiveJob): void {
    if (live.flushTimer !== null || live.finished) return;
    live.flushTimer = setTimeout(() => {
      live.flushTimer = null;
      this.flush(live);
    }, EMIT_INTERVAL_MS);
    live.flushTimer.unref?.();
  }

  /** Emit every tick (~120 ms), write to SQLite at most every PERSIST_INTERVAL_MS. */
  private flush(live: LiveJob): void {
    if (live.removed) return;
    if (live.pendingLog.length > 0) {
      const lines = live.pendingLog.splice(0);
      this.emit({ type: 'job-log', jobId: live.job.id, lines }, live.job);
    }
    if (live.progressDirty) {
      live.progressDirty = false;
      this.emit({ type: 'job-update', job: toSummary(live.job) }, live.job);
    }
    if (live.persistDirty && Date.now() - live.lastPersistAt >= PERSIST_INTERVAL_MS) {
      this.persist(live);
    }
    // Still dirty (persist was throttled out) — come back for it.
    if (live.persistDirty) this.scheduleFlush(live);
  }

  private persist(live: LiveJob): void {
    if (live.removed) return;
    live.persistDirty = false;
    live.lastPersistAt = Date.now();
    try {
      jobsRepo.save(live.job);
    } catch (err) {
      // Losing a progress write is survivable; losing the export is not.
      // eslint-disable-next-line no-console
      console.error('[jobs] failed to persist job', live.job.id, errorMessage(err));
    }
  }

  // --- completion ---------------------------------------------------------

  private finish(live: LiveJob, status: JobStatus, error: string | null, result?: unknown): void {
    if (live.finished) return;
    live.finished = true;

    // A runner that finished cleanly after the user hit cancel is still a
    // cancelled job — the output is half-written and must not read as "done".
    const finalStatus: JobStatus = live.cancelRequested && status === 'done' ? 'cancelled' : status;

    if (live.flushTimer !== null) {
      clearTimeout(live.flushTimer);
      live.flushTimer = null;
    }
    if (live.killTimer !== null) {
      clearTimeout(live.killTimer);
      live.killTimer = null;
    }
    if (live.forceTimer !== null) {
      clearTimeout(live.forceTimer);
      live.forceTimer = null;
    }

    live.job.status = finalStatus;
    live.job.endedAt = Date.now();
    live.job.error = finalStatus === 'done' ? null : (error ?? live.job.error);
    if (result !== undefined) live.job.result = result;
    if (finalStatus === 'done') {
      live.job.progress.phase = 'done';
      delete live.job.progress.etaMs;
    }
    live.persistDirty = true;

    // Drain the tail before the terminal update so the UI never sees a job go
    // "done" with log lines still in flight.
    if (live.pendingLog.length > 0 && !live.removed) {
      const lines = live.pendingLog.splice(0);
      this.emit({ type: 'job-log', jobId: live.job.id, lines }, live.job);
    }
    this.persist(live);
    if (!live.removed) this.emit({ type: 'job-update', job: toSummary(live.job) }, live.job);

    this.running.delete(live.job.id);
    live.children.clear();
    live.cancelHooks.length = 0;
    // The row is authoritative from here; keeping the log in memory would leak.
    this.live.delete(live.job.id);
    this.pump();
  }

  // --- cancellation -------------------------------------------------------

  /**
   * §7.3: cancel kills the child process *and* the DB-side query. A `pg_dump`
   * killed on this side leaves its backend running server-side, so the abort
   * signal, the registered cancel hooks (connector.cancel / KILL <pid>) and the
   * process signals all have to fire.
   */
  async cancel(id: string): Promise<boolean> {
    this.ensureInit();
    const live = this.live.get(id);
    if (!live) {
      // Not running here: either finished, or debris from a previous process.
      const job = jobsRepo.get(id);
      if (!job || TERMINAL_STATUSES.includes(job.status)) return false;
      job.status = 'cancelled';
      job.endedAt = Date.now();
      jobsRepo.save(job);
      this.emit({ type: 'job-update', job: toSummary(job) }, job);
      return true;
    }
    if (live.finished || live.cancelRequested) return false;
    live.cancelRequested = true;

    if (live.job.status === 'queued') {
      // Never started: no signal, no child, nothing to unwind.
      const at = this.queue.indexOf(id);
      if (at >= 0) this.queue.splice(at, 1);
      this.finish(live, 'cancelled', 'Cancelled before it started');
      return true;
    }

    live.job.status = 'cancelling';
    live.job.progress.phase = 'cancelling';
    this.appendLog(live, 'Cancel requested');
    this.persist(live);
    this.emit({ type: 'job-update', job: toSummary(live.job) }, live.job);

    // 1. Abort: cooperative runners (streams, RunOpts.signal) unwind here.
    live.controller.abort(new DOMException('Job cancelled', 'AbortError'));

    // 2. Hooks: kill the query on the server. Not awaited before the signals,
    //    because a hook on a wedged connection can hang for the socket timeout.
    const hooks = [...live.cancelHooks];
    void Promise.allSettled(hooks.map((hook) => this.runHook(live, hook)));

    // 3. Children: SIGTERM now, SIGKILL after the grace period (§7.3). The timer
    //    is armed even with no child yet, because a runner mid-spawn will
    //    register one a moment from now.
    for (const child of live.children) killChild(child, 'SIGTERM');
    live.killTimer = setTimeout(() => {
      live.killTimer = null;
      if (live.finished || live.children.size === 0) return;
      for (const child of live.children) killChild(child, 'SIGKILL');
      this.appendLog(live, 'Child process did not exit on SIGTERM; sent SIGKILL');
    }, KILL_GRACE_MS);
    live.killTimer.unref?.();

    // 4. Last resort: a runner that ignores all of the above must not hold a
    //    concurrency slot or leave the drawer stuck on "cancelling" forever.
    live.forceTimer = setTimeout(() => {
      live.forceTimer = null;
      if (live.finished) return;
      this.appendLog(live, 'Runner did not stop after SIGKILL; releasing the job slot');
      this.finish(live, 'cancelled', 'Cancelled (runner did not stop)');
    }, CANCEL_FORCE_MS);
    live.forceTimer.unref?.();

    return true;
  }

  private async runHook(live: LiveJob, hook: CancelHook): Promise<void> {
    try {
      await hook();
    } catch (err) {
      this.appendLog(live, `Cancel hook failed: ${errorMessage(err)}`);
    }
  }

  // --- queries ------------------------------------------------------------

  /** Live jobs win over the row: the row is up to 500 ms stale by design. */
  list(opts: JobListOptions = {}): JobSummary[] {
    this.ensureInit();
    return jobsRepo.list(opts).map((row) => {
      const live = this.live.get(row.id);
      return toSummary(live ? live.job : row);
    });
  }

  get(id: string): JobDetail | null {
    this.ensureInit();
    const live = this.live.get(id);
    if (live) return toDetail(live.job);
    const job = jobsRepo.get(id);
    return job ? toDetail(job) : null;
  }

  /** The full in-memory job, including params — server-side callers only. */
  getJob(id: string): Job | null {
    this.ensureInit();
    const live = this.live.get(id);
    if (live) return cloneJob(live.job);
    return jobsRepo.get(id);
  }

  /** Cancels first when the job is still active, then drops the row. */
  async remove(id: string): Promise<boolean> {
    this.ensureInit();
    const live = this.live.get(id);
    if (live && !live.finished) {
      await this.cancel(id);
      const stillLive = this.live.get(id);
      if (stillLive) stillLive.removed = true;
    }
    const at = this.queue.indexOf(id);
    if (at >= 0) this.queue.splice(at, 1);
    const existed = jobsRepo.get(id) !== null;
    jobsRepo.remove(id);
    return existed;
  }

  /** Drops finished jobs older than `days`. Runs on startup and on demand. */
  cleanup(days = this.retentionDays): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return jobsRepo.deleteFinishedBefore(cutoff);
  }

  /** Jobs this process is actually running or holding in the queue. */
  activeCount(): number {
    return this.running.size + this.queue.length;
  }
}

/**
 * One manager per process. Routes, the WebSocket bridge and the transfer
 * subsystem all talk to this instance (§7.3).
 */
export const jobManager = new JobManager();
