'use client';

/**
 * The jobs drawer (PLAN §7.3 "the UI gets a jobs drawer that survives page
 * reloads").
 *
 * Everything a long transfer needs to be trusted: a progress bar, the phase, how
 * long it has been running and how long is left, a cancel that really kills the
 * child process and the DB-side query, and an expandable tail of the job log —
 * which is the only thing that makes a failure diagnosable an hour later.
 *
 * Reload survival is not a feature of this component but of `useJobs`: the list
 * is re-read from /api/jobs on mount and the socket only adds live frames on top.
 *
 * Two surfaces, same body:
 *   - `<JobsDrawer>`  — a bottom overlay opened by `openJobsDrawer()`.
 *   - `JobsSlot`      — registered as the shell's 'jobs' slot, filling the
 *                       bottom pane. Mount one or the other, not both.
 */

import * as React from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { Activity, Ban, ChevronRight, Download, Trash2, TriangleAlert, Upload, X } from 'lucide-react';
import type { JobSummary } from '@/lib/api-types';
import {
  formatBytes,
  formatDuration,
  isJobActive,
  jobElapsedMs,
  jobPercent,
  useJobDetail,
  useJobs,
  type JobsFilter,
} from '@/hooks/use-jobs';
import { useWorkspaceStore } from '@/state/workspace-store';
import { Badge, Button, EmptyState, ErrorBox, Spinner, Toolbar, cn } from '@/components/ui/primitives';

// ---------------------------------------------------------------------------
// Open/close state, so a dialog that just created a job can raise the drawer
// ---------------------------------------------------------------------------

interface JobsDrawerState {
  open: boolean;
  /** The row whose log tail is expanded. */
  expandedId: string | null;
  activeOnly: boolean;
  setOpen: (open: boolean) => void;
  expand: (id: string | null) => void;
  setActiveOnly: (v: boolean) => void;
}

export const useJobsDrawerStore = create<JobsDrawerState>((set, get) => ({
  open: false,
  expandedId: null,
  activeOnly: false,
  setOpen: (open) => set({ open }),
  expand: (id) => set({ expandedId: get().expandedId === id ? null : id }),
  setActiveOnly: (activeOnly) => set({ activeOnly }),
}));

/**
 * Called by the export/import dialogs the moment a job id comes back. It raises
 * both surfaces — the overlay drawer and the shell's bottom pane — because only
 * one of them is ever mounted in a given app shell.
 */
export function openJobsDrawer(jobId?: string): void {
  useJobsDrawerStore.setState({ open: true, expandedId: jobId ?? null, activeOnly: false });
  useWorkspaceStore.getState().setBottomTab('jobs');
}

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------

export function JobsDrawer({
  connectionId,
  heightPx = 320,
}: {
  /** Narrow the list to one connection; omit for every job. */
  connectionId?: string | null;
  heightPx?: number;
}) {
  const open = useJobsDrawerStore((s) => s.open);
  const setOpen = useJobsDrawerStore((s) => s.setOpen);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col border-t border-[var(--border)] bg-[var(--bg-panel)] shadow-[var(--shadow)]"
      style={{ height: heightPx }}
      role="complementary"
      aria-label="Background jobs"
    >
      <JobsPanel
        connectionId={connectionId ?? undefined}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

/** Shell slot adapter: `registerWorkspaceSlot('jobs', JobsSlot)`. */
export function JobsSlot(_props: { connectionId: string | null }) {
  // The slot deliberately shows every job, not only the active connection's: a
  // dump still running after you switched connections is exactly the row you
  // are looking for.
  return <JobsPanel />;
}

export function JobsPanel({ connectionId, onClose }: { connectionId?: string; onClose?: () => void }) {
  const activeOnly = useJobsDrawerStore((s) => s.activeOnly);
  const setActiveOnly = useJobsDrawerStore((s) => s.setActiveOnly);
  const expandedId = useJobsDrawerStore((s) => s.expandedId);
  const expand = useJobsDrawerStore((s) => s.expand);

  const filter: JobsFilter = React.useMemo(
    () => ({ connectionId, active: activeOnly, limit: 100 }),
    [connectionId, activeOnly],
  );
  const { jobs, activeCount, isLoading, isFetching, error, refetch, cancel, remove, busyIds } = useJobs(filter);

  // One clock for every row: elapsed and ETA must tick without each row owning
  // a timer, and nothing re-renders when no job is running.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (activeCount === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeCount]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <Activity className="size-3.5 text-[var(--fg-subtle)]" />
        <span className="text-xs font-medium">Jobs</span>
        {activeCount > 0 && <Badge tone="accent">{activeCount} running</Badge>}
        <Button
          size="xs"
          variant={activeOnly ? 'primary' : 'ghost'}
          onClick={() => setActiveOnly(!activeOnly)}
          title="Show only queued and running jobs"
        >
          Active only
        </Button>
        <Button size="xs" variant="ghost" onClick={refetch} loading={isFetching && !isLoading}>
          Refresh
        </Button>
        {onClose && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={onClose} aria-label="Close jobs drawer">
            <X className="size-3.5" />
          </Button>
        )}
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && (
          <div className="flex items-center gap-2 p-3 text-xs text-[var(--fg-muted)]">
            <Spinner /> Loading jobs…
          </div>
        )}

        {error && (
          <div className="p-3">
            <ErrorBox title="Could not read the job list" message={error.message} />
          </div>
        )}

        {!isLoading && !error && jobs.length === 0 && (
          <EmptyState
            icon={<Activity className="size-5" />}
            title={activeOnly ? 'Nothing running' : 'No jobs yet'}
            description="Exports, imports and restores run here in the background. They keep going if you close this drawer, and the list is re-read after a page reload."
          />
        )}

        {jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            now={now}
            busy={busyIds.has(job.id)}
            expanded={expandedId === job.id}
            onToggle={() => expand(job.id)}
            onCancel={() =>
              void cancel(job.id).catch((err: unknown) =>
                toast.error(err instanceof Error ? err.message : 'Could not cancel the job'),
              )
            }
            onRemove={() =>
              void remove(job.id).catch((err: unknown) =>
                toast.error(err instanceof Error ? err.message : 'Could not remove the job'),
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

const STATUS_TONE: Record<JobSummary['status'], 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'> = {
  queued: 'neutral',
  running: 'accent',
  cancelling: 'warn',
  done: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};

function JobRow({
  job,
  now,
  busy,
  expanded,
  onToggle,
  onCancel,
  onRemove,
}: {
  job: JobSummary;
  now: number;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const active = isJobActive(job);
  const pct = jobPercent(job);
  const elapsed = jobElapsedMs(job, now);
  const { tablesDone, tablesTotal, rowsDone, bytesOut, phase, etaMs } = job.progress;

  return (
    <div className="border-b border-[var(--border)] last:border-0">
      <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--bg-hover)]">
        <button
          type="button"
          onClick={onToggle}
          className="flex size-4 shrink-0 items-center justify-center text-[var(--fg-subtle)]"
          aria-label={expanded ? 'Hide log' : 'Show log'}
          aria-expanded={expanded}
        >
          <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
        </button>

        <span className="shrink-0 text-[var(--fg-subtle)]">
          {job.kind === 'export' ? <Download className="size-3.5" /> : <Upload className="size-3.5" />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs" title={job.title}>
              {job.title}
            </span>
            <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
            <span className="text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]">{job.kind}</span>
          </div>

          <div className="mt-1 flex items-center gap-2">
            {/* Indeterminate while the table count is unknown — a bar pinned at
                0% reads as "stuck" when the job is only still planning. */}
            <div className="h-1 w-40 shrink-0 overflow-hidden bg-[var(--bg-active)]">
              <div
                className={cn('h-full bg-[var(--accent)]', pct === null && active && 'animate-pulse')}
                style={{ width: pct === null ? (active ? '100%' : '0%') : `${pct}%` }}
              />
            </div>
            <span className="truncate text-[10px] text-[var(--fg-muted)]">
              {phase || (active ? 'working' : job.status)}
              {tablesTotal > 0 && ` · ${tablesDone} of ${tablesTotal} tables`}
              {rowsDone > 0 && ` · ${rowsDone.toLocaleString()} rows`}
              {bytesOut > 0 && ` · ${formatBytes(bytesOut)}`}
              {elapsed !== null && ` · ${formatDuration(elapsed)}`}
              {active && etaMs !== undefined && etaMs > 0 && ` · ~${formatDuration(etaMs)} left`}
            </span>
          </div>

          {job.error && (
            <p className="mono mt-1 flex items-start gap-1 text-[10px] text-[var(--danger)]">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              <span className="break-words">{job.error}</span>
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {active ? (
            <Button size="xs" variant="ghost" loading={busy} icon={<Ban className="size-3" />} onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button
              size="xs"
              variant="ghost"
              loading={busy}
              icon={<Trash2 className="size-3" />}
              onClick={onRemove}
              title="Remove this job from the list"
            />
          )}
        </div>
      </div>

      {expanded && <JobLog jobId={job.id} />}
    </div>
  );
}

/** The ring-buffer tail, live. Auto-scrolls only while pinned to the bottom. */
function JobLog({ jobId }: { jobId: string }) {
  const { detail, log, isLoading, error } = useJobDetail(jobId, true);
  const boxRef = React.useRef<HTMLPreElement>(null);
  const pinnedRef = React.useRef(true);

  React.useEffect(() => {
    const box = boxRef.current;
    if (!box || !pinnedRef.current) return;
    box.scrollTop = box.scrollHeight;
  }, [log.length]);

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1.5">
      {isLoading && (
        <div className="flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
          <Spinner className="size-3" /> Reading the log…
        </div>
      )}
      {error && <ErrorBox message={error.message} />}
      {detail && log.length === 0 && <p className="text-[11px] text-[var(--fg-subtle)]">No log output yet.</p>}
      {log.length > 0 && (
        <pre
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="mono max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-snug text-[var(--fg-muted)]"
        >
          {log.join('\n')}
        </pre>
      )}
    </div>
  );
}
