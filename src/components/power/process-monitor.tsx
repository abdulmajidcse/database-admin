'use client';

/**
 * Session / process monitor (PLAN M6, §6 power tools).
 *
 * Data comes from POST /api/processes and is kept current by the `processes`
 * WebSocket channel. The socket is the fast path, but it is not the only one:
 * the channel only pushes while the server has a broadcaster attached to it, so
 * this panel also re-polls whenever it has heard nothing for `STALE_MS`. A
 * monitor that silently freezes is worse than one that costs a query every few
 * seconds — you would trust an out-of-date list and kill the wrong session.
 *
 * What the colouring means (the reason you open this panel at all):
 *  - a row with `blockedBy` is waiting on someone else — red;
 *  - a row someone else names in `blockedBy` is the blocker — amber, and called
 *    out even when it is idle, because "idle in transaction" holding a lock is
 *    the classic production stall;
 *  - long-running rows shade by age.
 */

import * as React from 'react';
import { toast } from 'sonner';
import { Activity, ArrowDown, ArrowUp, Ban, Copy, Pause, Play, RefreshCw, Search } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api-client';
import type { ProcessListResponse, ServerMessage } from '@/lib/api-types';
import type { ProcessInfo } from '@/lib/results';
import { wsClient } from '@/lib/ws-client';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  Input,
  Spinner,
  Toolbar,
  cn,
} from '@/components/ui/primitives';

/** Re-poll when the socket has been quiet for this long. */
const STALE_MS = 5_000;
/** How often the staleness check runs (and the "updated Ns ago" label ticks). */
const TICK_MS = 1_000;
/** After a failure, back off hard: a broken server must not be polled at 1 Hz. */
const ERROR_RETRY_MS = 15_000;
/** Duration thresholds for the age colouring. */
const LONG_MS = 10_000;
const VERY_LONG_MS = 60_000;
/** A session list is not a data grid; beyond this the panel asks for a filter. */
const MAX_ROWS = 500;

type SortKey = 'id' | 'user' | 'client' | 'database' | 'state' | 'durationMs' | 'query' | 'waitEvent' | 'blockedBy';

interface Column {
  key: SortKey;
  label: string;
  className?: string;
  numeric?: boolean;
}

const COLUMNS: Column[] = [
  { key: 'id', label: 'ID', className: 'w-24' },
  { key: 'user', label: 'User', className: 'w-28' },
  { key: 'client', label: 'Client', className: 'w-36' },
  { key: 'database', label: 'Database', className: 'w-28' },
  { key: 'state', label: 'State', className: 'w-32' },
  { key: 'durationMs', label: 'Duration', className: 'w-24 text-right', numeric: true },
  { key: 'query', label: 'Query' },
  { key: 'waitEvent', label: 'Wait', className: 'w-32' },
  { key: 'blockedBy', label: 'Blocked by', className: 'w-24' },
];

export interface ProcessMonitorProps {
  connectionId: string;
  className?: string;
}

export function ProcessMonitor({ connectionId, className }: ProcessMonitorProps) {
  const [processes, setProcesses] = React.useState<ProcessInfo[] | null>(null);
  const [error, setError] = React.useState<{ message: string; unsupported: boolean } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [live, setLive] = React.useState(true);
  const [hideIdle, setHideIdle] = React.useState(false);
  const [filter, setFilter] = React.useState('');
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'durationMs', dir: 'desc' });
  const [detail, setDetail] = React.useState<ProcessInfo | null>(null);
  const [killing, setKilling] = React.useState<ProcessInfo | null>(null);
  const [, setTick] = React.useState(0);

  /** Last successful update, from either transport. */
  const updatedAt = React.useRef<number>(0);
  /** Last attempt, successful or not — this is what the backoff measures. */
  const attemptedAt = React.useRef<number>(0);
  const inFlight = React.useRef(false);
  const failed = React.useRef(false);
  /** An engine with no process list is never polled again. */
  const unsupported = React.useRef(false);

  const refresh = React.useCallback(async () => {
    if (inFlight.current || unsupported.current) return;
    inFlight.current = true;
    attemptedAt.current = Date.now();
    setLoading(true);
    try {
      const res = await api.post<ProcessListResponse>('/api/processes', { connectionId });
      setProcesses(res.processes);
      setError(null);
      failed.current = false;
      updatedAt.current = Date.now();
    } catch (err) {
      // 501 is "this engine has no server-side session list" — a fact about the
      // engine, not a failure, so it gets an explanation rather than a red box.
      const is501 = err instanceof ApiRequestError && err.status === 501;
      failed.current = true;
      unsupported.current = is501;
      setError({ message: err instanceof Error ? err.message : 'Could not read the session list', unsupported: is501 });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [connectionId]);

  // Reset when the panel is pointed at another server.
  React.useEffect(() => {
    setProcesses(null);
    setError(null);
    updatedAt.current = 0;
    attemptedAt.current = 0;
    failed.current = false;
    unsupported.current = false;
    void refresh();
  }, [connectionId, refresh]);

  // The push path.
  React.useEffect(() => {
    if (!live) return;
    const off = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type !== 'processes' || msg.connectionId !== connectionId) return;
      setProcesses(msg.processes);
      setError(null);
      updatedAt.current = Date.now();
    });
    const unsub = wsClient.subscribe({ channel: 'processes', connectionId });
    return () => {
      off();
      unsub();
    };
  }, [connectionId, live]);

  // The pull path: a poll that only fires when the socket has gone quiet, plus
  // the clock behind the "updated Ns ago" label.
  React.useEffect(() => {
    const timer = setInterval(() => {
      setTick((n) => n + 1);
      if (!live || unsupported.current) return;
      const now = Date.now();
      const wait = failed.current ? ERROR_RETRY_MS : STALE_MS;
      if (now - updatedAt.current >= STALE_MS && now - attemptedAt.current >= wait) void refresh();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [live, refresh]);

  const list = processes ?? [];

  /** Ids named by someone else's `blockedBy` — the sessions actually at fault. */
  const blockers = React.useMemo(() => {
    const set = new Set<string>();
    for (const p of list) if (p.blockedBy) set.add(p.blockedBy);
    return set;
  }, [list]);

  const rows = React.useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = list.filter((p) => {
      if (hideIdle && isIdle(p) && !blockers.has(p.id)) return false;
      if (needle === '') return true;
      return searchText(p).includes(needle);
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => compare(a, b, sort.key) * dir);
  }, [list, filter, hideIdle, sort, blockers]);

  const shown = rows.slice(0, MAX_ROWS);
  const active = list.filter((p) => !isIdle(p)).length;
  const blocked = list.filter((p) => !!p.blockedBy).length;
  const age = updatedAt.current === 0 ? null : Date.now() - updatedAt.current;

  const kill = async (target: ProcessInfo) => {
    try {
      await api.post('/api/processes/kill', { connectionId, id: target.id });
      toast.success(`Killed session ${target.id}`);
      // Do not wait for the next tick: the list is why you clicked the button.
      updatedAt.current = 0;
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not kill the session');
    }
  };

  if (error?.unsupported) {
    return (
      <EmptyState
        icon={<Activity className="size-5" />}
        title="No server-side sessions here"
        description={error.message}
      />
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-[var(--bg)]', className)}>
      <Toolbar>
        <Button
          size="xs"
          variant={live ? 'primary' : 'default'}
          icon={live ? <Pause className="size-3" /> : <Play className="size-3" />}
          onClick={() => setLive((v) => !v)}
        >
          {live ? 'Live' : 'Paused'}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<RefreshCw className={cn('size-3', loading && 'animate-spin')} />}
          onClick={() => void refresh()}
          disabled={loading}
        >
          Refresh
        </Button>
        <div className="relative w-56">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            className="h-6 pl-6"
            placeholder="filter user, db, query…"
            value={filter}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <Checkbox
          label="Hide idle"
          className="text-[11px]"
          checked={hideIdle}
          onChange={(e) => setHideIdle(e.target.checked)}
        />
        <div className="ml-auto flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
          <span className="tabular-nums">
            {list.length} session{list.length === 1 ? '' : 's'} · {active} active
          </span>
          {blocked > 0 && <Badge tone="danger">{blocked} blocked</Badge>}
          <span className="tabular-nums text-[var(--fg-subtle)]">{age === null ? 'never read' : formatAge(age)}</span>
        </div>
      </Toolbar>

      {error && !error.unsupported && (
        <div className="border-b border-[var(--border)] p-2">
          <ErrorBox title="Could not refresh the session list" message={error.message} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {processes === null && !error ? (
          <div className="flex items-center gap-2 p-3 text-xs text-[var(--fg-muted)]">
            <Spinner /> Reading sessions…
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<Activity className="size-5" />}
            title={list.length === 0 ? 'No sessions' : 'Nothing matches the filter'}
            description={
              list.length === 0
                ? 'The server reports no client sessions other than the ones this app hides.'
                : `${list.length} sessions are connected; none match the current filter.`
            }
          />
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-[var(--grid-header)]">
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    onClick={() =>
                      setSort((prev) =>
                        prev.key === col.key
                          ? { key: col.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                          : { key: col.key, dir: col.numeric ? 'desc' : 'asc' },
                      )
                    }
                    className={cn(
                      'cursor-pointer select-none border-b border-[var(--border)] px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-[var(--fg-muted)] hover:text-[var(--fg)]',
                      col.className,
                    )}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {sort.key === col.key &&
                        (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </span>
                  </th>
                ))}
                <th className="w-16 border-b border-[var(--border)] px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <ProcessRow
                  key={p.id}
                  process={p}
                  blocking={blockers.has(p.id)}
                  onOpen={() => setDetail(p)}
                  onKill={() => setKilling(p)}
                />
              ))}
            </tbody>
          </table>
        )}
        {rows.length > shown.length && (
          <p className="px-2 py-1 text-[11px] text-[var(--fg-muted)]">
            Showing the first {MAX_ROWS} of {rows.length} matching sessions — narrow the filter to see the rest.
          </p>
        )}
      </div>

      <ProcessDetailDialog process={detail} onClose={() => setDetail(null)} />

      <ConfirmDialog
        open={killing !== null}
        onClose={() => setKilling(null)}
        onConfirm={() => {
          if (killing) void kill(killing);
        }}
        title="Kill session"
        confirmWord={killing?.id}
        message={
          killing && (
            <div className="flex flex-col gap-2">
              <p>
                Session <span className="mono">{killing.id}</span>
                {killing.user ? ` owned by ${killing.user}` : ''}
                {killing.database ? ` on ${killing.database}` : ''} will be terminated. Its open transaction is rolled
                back and the client sees a broken connection.
              </p>
              {killing.query && (
                <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap break-words border border-[var(--border)] bg-[var(--bg-subtle)] p-2">
                  {killing.query}
                </pre>
              )}
            </div>
          )
        }
      />
    </div>
  );
}

/**
 * The monitor in a dialog, for hosts that have no pane to spare (the connection
 * header, the command palette). Mounted lazily so the poll only runs while the
 * dialog is open.
 */
export function ProcessMonitorDialog({
  open,
  onClose,
  connectionId,
  connectionName,
}: {
  open: boolean;
  onClose: () => void;
  connectionId: string;
  connectionName?: string;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="full"
      title={connectionName ? `Sessions · ${connectionName}` : 'Sessions'}
      footer={
        <Button size="sm" variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="h-[65vh] border border-[var(--border)]">
        <ProcessMonitor connectionId={connectionId} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

const ProcessRow = React.memo(function ProcessRow({
  process,
  blocking,
  onOpen,
  onKill,
}: {
  process: ProcessInfo;
  blocking: boolean;
  onOpen: () => void;
  onKill: () => void;
}) {
  const duration = process.durationMs ?? 0;
  const blocked = !!process.blockedBy;
  const idle = isIdle(process);

  return (
    <tr
      onClick={onOpen}
      className={cn(
        'cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-hover)]',
        blocked && 'bg-[var(--danger-bg)]',
        !blocked && blocking && 'bg-[var(--warn-bg)]',
        !blocked && !blocking && 'even:bg-[var(--row-alt)]',
      )}
    >
      <td className="mono px-2 py-1 align-top tabular-nums">{process.id}</td>
      <td className="truncate px-2 py-1 align-top" title={process.user}>
        {process.user ?? <Dash />}
      </td>
      <td className="mono truncate px-2 py-1 align-top text-[11px]" title={process.client}>
        {process.client ?? <Dash />}
      </td>
      <td className="truncate px-2 py-1 align-top" title={process.database}>
        {process.database ?? <Dash />}
      </td>
      <td className="px-2 py-1 align-top">
        <span className="flex flex-wrap items-center gap-1">
          <span className={cn('truncate', idle ? 'text-[var(--fg-subtle)]' : 'text-[var(--fg)]')}>
            {process.state ?? process.command ?? <Dash />}
          </span>
          {blocking && <Badge tone="warn">blocking</Badge>}
          {blocked && <Badge tone="danger">blocked</Badge>}
        </span>
      </td>
      <td
        className={cn(
          'px-2 py-1 text-right align-top tabular-nums',
          duration >= VERY_LONG_MS && !idle
            ? 'font-medium text-[var(--danger)]'
            : duration >= LONG_MS && !idle
              ? 'text-[var(--warn)]'
              : 'text-[var(--fg-muted)]',
        )}
      >
        {process.durationMs === undefined ? <Dash /> : formatDuration(process.durationMs)}
      </td>
      <td className="max-w-0 px-2 py-1 align-top">
        <span className="mono block truncate text-[11px]" title={process.query}>
          {process.query?.replace(/\s+/g, ' ').trim() || <Dash />}
        </span>
      </td>
      <td className="truncate px-2 py-1 align-top text-[11px] text-[var(--fg-muted)]" title={process.waitEvent}>
        {process.waitEvent ?? <Dash />}
      </td>
      <td className="mono px-2 py-1 align-top text-[11px] text-[var(--danger)]">{process.blockedBy ?? <Dash />}</td>
      <td className="px-2 py-1 text-right align-top">
        <Button
          size="xs"
          variant="ghost"
          icon={<Ban className="size-3" />}
          onClick={(e) => {
            e.stopPropagation();
            onKill();
          }}
        >
          Kill
        </Button>
      </td>
    </tr>
  );
});

function Dash() {
  return <span className="text-[var(--fg-subtle)]">—</span>;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function ProcessDetailDialog({ process, onClose }: { process: ProcessInfo | null; onClose: () => void }) {
  const copy = () => {
    if (!process?.query) return;
    void navigator.clipboard
      .writeText(process.query)
      .then(() => toast.success('Query copied'))
      .catch(() => toast.error('The browser refused clipboard access'));
  };

  return (
    <Dialog
      open={process !== null}
      onClose={onClose}
      width="lg"
      title={process ? `Session ${process.id}` : 'Session'}
      footer={
        <>
          <Button size="sm" icon={<Copy className="size-3" />} onClick={copy} disabled={!process?.query}>
            Copy query
          </Button>
          <Button size="sm" variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {process && (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-[12px]">
            <Detail label="User" value={process.user} />
            <Detail label="Client" value={process.client} mono />
            <Detail label="Database" value={process.database} />
            <Detail label="State" value={process.state} />
            <Detail label="Command" value={process.command} />
            <Detail
              label="Duration"
              value={process.durationMs === undefined ? undefined : formatDuration(process.durationMs)}
            />
            <Detail label="Wait event" value={process.waitEvent} mono />
            <Detail label="Blocked by" value={process.blockedBy} mono />
          </dl>
          <div>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">Query</p>
            <pre className="mono max-h-[45vh] overflow-auto whitespace-pre-wrap break-words border border-[var(--border)] bg-[var(--bg-subtle)] p-2 text-[var(--fg)]">
              {process.query?.trim() || 'This session is not running a statement.'}
            </pre>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Detail({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">{label}</dt>
      <dd className={cn('break-words', mono && 'mono', !value && 'text-[var(--fg-subtle)]')}>{value ?? '—'}</dd>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every engine spells it differently: `Sleep`, `idle`, `idle in transaction`. */
function isIdle(p: ProcessInfo): boolean {
  const state = `${p.state ?? ''} ${p.command ?? ''}`.toLowerCase();
  if (state.includes('idle in transaction')) return false; // holds locks: never "idle"
  return state.includes('idle') || state.includes('sleep');
}

function searchText(p: ProcessInfo): string {
  return [p.id, p.user, p.client, p.database, p.state, p.command, p.query, p.waitEvent, p.blockedBy]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function compare(a: ProcessInfo, b: ProcessInfo, key: SortKey): number {
  if (key === 'durationMs') return (a.durationMs ?? -1) - (b.durationMs ?? -1);
  if (key === 'id') {
    // Numeric ids (MySQL, Postgres pids) must not sort as "10 < 9".
    const na = Number(a.id);
    const nb = Number(b.id);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  }
  return String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatAge(ms: number): string {
  if (ms < 2000) return 'updated just now';
  if (ms < 60_000) return `updated ${Math.round(ms / 1000)}s ago`;
  return `updated ${Math.round(ms / 60_000)}m ago`;
}

export default ProcessMonitor;
