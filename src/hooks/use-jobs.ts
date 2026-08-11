'use client';

/**
 * Background jobs, as one hook (PLAN §7.3).
 *
 * A job outlives the request that created it, so the drawer has two sources and
 * needs both:
 *
 *   1. `GET /api/jobs` — the authoritative list. This is what makes the drawer
 *      "survive a page reload": a reload has missed every socket event so far,
 *      and the rows are persisted precisely so they can be re-read.
 *   2. The `jobs` WebSocket channel — live `job-update` / `job-log` frames.
 *
 * They are merged into the SAME TanStack Query cache entry rather than kept in a
 * second store: one list, one sort order, and a refetch can never disagree with
 * what the socket just said. Socket frames are folded in with `setQueryData`,
 * which is why nothing here polls aggressively — the timer below is only a
 * safety net for a socket that dropped.
 */

import * as React from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, ApiRequestError } from '@/lib/api-client';
import type { JobDetail, JobSummary, ServerMessage } from '@/lib/api-types';
import { wsClient } from '@/lib/ws-client';

export type JobKind = JobSummary['kind'];
export type JobStatus = JobSummary['status'];

export const JOBS_QUERY_ROOT = 'jobs';

/** Mirrors ACTIVE_STATUSES in server/jobs/types.ts — the non-terminal states. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'cancelling'];

export function isJobActive(job: JobSummary): boolean {
  return ACTIVE_JOB_STATUSES.includes(job.status);
}

/** The server caps the log ring buffer too; this is the client-side twin. */
const LOG_CAP = 2000;
const DEFAULT_LIMIT = 100;
/** Only while something is running, and only as a fallback for a dead socket. */
const ACTIVE_POLL_MS = 5000;

export interface JobsFilter {
  connectionId?: string;
  kind?: JobKind;
  status?: JobStatus[];
  /** Shorthand for status in (queued, running, cancelling). */
  active?: boolean;
  limit?: number;
}

function filterSignature(f: JobsFilter): string {
  return [f.connectionId ?? '', f.kind ?? '', (f.status ?? []).join('+'), f.active ? '1' : '', f.limit ?? ''].join('|');
}

export function jobsQueryKey(filter: JobsFilter = {}): QueryKey {
  return [JOBS_QUERY_ROOT, 'list', filterSignature(filter)];
}

export function jobQueryKey(jobId: string): QueryKey {
  return [JOBS_QUERY_ROOT, 'detail', jobId];
}

function listPath(filter: JobsFilter): string {
  const params = new URLSearchParams();
  if (filter.connectionId) params.set('connectionId', filter.connectionId);
  if (filter.kind) params.set('kind', filter.kind);
  for (const s of filter.status ?? []) params.append('status', s);
  if (filter.active) params.set('active', '1');
  params.set('limit', String(filter.limit ?? DEFAULT_LIMIT));
  return `/api/jobs?${params.toString()}`;
}

/** The route answers `{ jobs }`; tolerate a bare array so a shim cannot break it. */
function normalizeList(payload: unknown): JobSummary[] {
  if (Array.isArray(payload)) return payload as JobSummary[];
  if (payload && typeof payload === 'object') {
    const jobs = (payload as { jobs?: unknown }).jobs;
    if (Array.isArray(jobs)) return jobs as JobSummary[];
  }
  return [];
}

/** Newest first, by the moment work actually started when it has. */
function sortJobs(jobs: JobSummary[]): JobSummary[] {
  return [...jobs].sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
}

/** Whether a live update still belongs in this list — an `active` filter drops it on completion. */
function matchesFilter(job: JobSummary, filter: JobsFilter): boolean {
  if (filter.connectionId && job.connectionId !== filter.connectionId) return false;
  if (filter.kind && job.kind !== filter.kind) return false;
  if (filter.active && !isJobActive(job)) return false;
  if (!filter.active && filter.status && filter.status.length > 0 && !filter.status.includes(job.status)) return false;
  return true;
}

function mergeJob(prev: JobSummary[] | undefined, job: JobSummary, filter: JobsFilter): JobSummary[] | undefined {
  // No cache entry yet means the first fetch is still in flight; it will land
  // with this job in it (the manager persists rows within ~500 ms), so dropping
  // the frame here loses nothing and avoids inventing a list out of one event.
  if (!prev) return prev;
  const present = prev.some((j) => j.id === job.id);
  if (!matchesFilter(job, filter)) return present ? prev.filter((j) => j.id !== job.id) : prev;
  const next = present ? prev.map((j) => (j.id === job.id ? job : j)) : [job, ...prev];
  return sortJobs(next).slice(0, filter.limit ?? DEFAULT_LIMIT);
}

/**
 * Cancel is a POST; some deployments only expose DELETE (which cancels first).
 * Falling back keeps the button honest instead of surfacing a 405 to the user.
 */
async function cancelJobRequest(id: string): Promise<void> {
  try {
    await api.post(`/api/jobs/${encodeURIComponent(id)}/cancel`);
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 404 || err.status === 405)) {
      await api.del(`/api/jobs/${encodeURIComponent(id)}`);
      return;
    }
    throw err;
  }
}

export interface UseJobsResult {
  jobs: JobSummary[];
  activeCount: number;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => void;
  /** Kills the child process AND the DB-side query (§7.3), then updates live. */
  cancel: (id: string) => Promise<void>;
  /** Cancels first if still running, then drops the row. */
  remove: (id: string) => Promise<void>;
  /** Ids with a cancel/remove in flight — for per-row spinners. */
  busyIds: Set<string>;
}

export function useJobs(filter: JobsFilter = {}): UseJobsResult {
  const client = useQueryClient();
  const signature = filterSignature(filter);
  // The caller almost always passes an object literal; pin it to its signature
  // so the query key, the fetch and the socket effect do not churn every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = React.useMemo<JobsFilter>(() => filter, [signature]);
  const key = React.useMemo(() => jobsQueryKey(stable), [stable]);

  const query = useQuery<JobSummary[]>({
    queryKey: key,
    queryFn: async () => sortJobs(normalizeList(await api.get<unknown>(listPath(stable)))),
    // Rows change under us constantly while a job runs; the socket is the fast
    // path and this is the correctness backstop.
    staleTime: 2000,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (((q.state.data as JobSummary[] | undefined) ?? []).some(isJobActive) ? ACTIVE_POLL_MS : false),
    retry: false,
  });

  // Live merge. The subscription is refcounted inside wsClient, so several
  // panels watching jobs share one frame stream.
  React.useEffect(() => {
    const off = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type !== 'job-update') return;
      client.setQueryData<JobSummary[]>(key, (prev) => mergeJob(prev, msg.job, stable));
      // Keep an open detail view's header in step without a second request.
      client.setQueryData<JobDetail>(jobQueryKey(msg.job.id), (prev) =>
        prev ? { ...prev, ...msg.job, log: prev.log, params: prev.params } : prev,
      );
    });
    const unsubs = [wsClient.subscribe({ channel: 'jobs' })];
    // The hub keys subscriptions by (channel, connectionId) and the bridge fans
    // out both ways, so a per-connection drawer asks for both.
    if (stable.connectionId) unsubs.push(wsClient.subscribe({ channel: 'jobs', connectionId: stable.connectionId }));
    return () => {
      off();
      for (const u of unsubs) u();
    };
  }, [client, key, stable]);

  const [busyIds, setBusyIds] = React.useState<Set<string>>(() => new Set());

  const withBusy = React.useCallback(async (id: string, run: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await run();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const cancel = React.useCallback(
    (id: string) =>
      withBusy(id, async () => {
        await cancelJobRequest(id);
        // The outcome arrives on the socket; this only flips the row to
        // "cancelling" straight away so the button stops looking inert.
        client.setQueryData<JobSummary[]>(key, (prev) =>
          prev?.map((j) => (j.id === id && isJobActive(j) ? { ...j, status: 'cancelling' as const } : j)),
        );
      }),
    [client, key, withBusy],
  );

  const remove = React.useCallback(
    (id: string) =>
      withBusy(id, async () => {
        await api.del(`/api/jobs/${encodeURIComponent(id)}`);
        client.setQueryData<JobSummary[]>(key, (prev) => prev?.filter((j) => j.id !== id));
        client.removeQueries({ queryKey: jobQueryKey(id) });
      }),
    [client, key, withBusy],
  );

  const jobs = query.data ?? [];

  return {
    jobs,
    activeCount: jobs.filter(isJobActive).length,
    isLoading: query.isPending && query.fetchStatus !== 'idle',
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error : null,
    refetch: () => void query.refetch(),
    cancel,
    remove,
    busyIds,
  };
}

export interface UseJobDetailResult {
  detail: JobDetail | null;
  /** The ring-buffer tail, with live `job-log` lines appended. */
  log: string[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * One job in full, including the log tail — fetched only when a row is expanded
 * (§7.3: the tail is what makes a failed export diagnosable after a reload).
 */
export function useJobDetail(jobId: string | null, enabled = true): UseJobDetailResult {
  const client = useQueryClient();
  const on = enabled && !!jobId;

  const query = useQuery<JobDetail>({
    queryKey: jobQueryKey(jobId ?? ''),
    queryFn: () => api.get<JobDetail>(`/api/jobs/${encodeURIComponent(jobId as string)}`),
    enabled: on,
    staleTime: 0,
    retry: false,
  });

  React.useEffect(() => {
    if (!on || !jobId) return;
    const key = jobQueryKey(jobId);
    const off = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === 'job-log' && msg.jobId === jobId) {
        client.setQueryData<JobDetail>(key, (prev) =>
          prev ? { ...prev, log: [...prev.log, ...msg.lines].slice(-LOG_CAP) } : prev,
        );
      } else if (msg.type === 'job-update' && msg.job.id === jobId) {
        client.setQueryData<JobDetail>(key, (prev) =>
          prev ? { ...prev, ...msg.job, log: prev.log, params: prev.params } : prev,
        );
      }
    });
    const unsub = wsClient.subscribe({ channel: 'jobs' });
    return () => {
      off();
      unsub();
    };
  }, [client, jobId, on]);

  return {
    detail: query.data ?? null,
    log: query.data?.log ?? [],
    isLoading: query.isPending && query.fetchStatus !== 'idle',
    error: query.error instanceof Error ? query.error : null,
  };
}

// ---------------------------------------------------------------------------
// Formatting — shared by the drawer, the file picker and the export dialog so
// a byte count reads the same everywhere.
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** How long the job has been running, or how long it ran. */
export function jobElapsedMs(job: JobSummary, now: number): number | null {
  if (job.startedAt === null) return null;
  return (job.endedAt ?? now) - job.startedAt;
}

/** Table-based percentage, or null when the total is not known yet. */
export function jobPercent(job: JobSummary): number | null {
  const { tablesDone, tablesTotal } = job.progress;
  if (tablesTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((tablesDone / tablesTotal) * 100)));
}
