'use client';

/**
 * Query history (PLAN §5, M2).
 *
 * Every execution that goes through /api/query is written to the app database —
 * including the ones that failed or were cancelled, because the query you got
 * wrong is usually the one you want back. The search box hits the server rather
 * than filtering a page in memory, so a 30k-row log stays usable.
 *
 * Clicking a row restores it into the editor through a normal CodeMirror
 * dispatch, which means Cmd-Z puts your own text back.
 */

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Ban, Check, History, Search, Trash2 } from 'lucide-react';

import { api } from '@/lib/api-client';
import type { HistoryEntry } from '@/lib/api-types';
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
  cn,
} from '@/components/ui/primitives';

interface HistoryResponse {
  entries: HistoryEntry[];
}

const HISTORY_KEY = 'history';

export interface HistoryPanelProps {
  connectionId: string | null;
  /** Replace the editor buffer with this SQL. */
  onRestore: (sql: string) => void;
  /** Called after a restore so the dialog wrapper can close itself. */
  onPicked?: () => void;
}

export function HistoryPanel({ connectionId, onRestore, onPicked }: HistoryPanelProps) {
  const client = useQueryClient();
  const [rawSearch, setRawSearch] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [thisConnectionOnly, setThisConnectionOnly] = React.useState(true);
  const [clearing, setClearing] = React.useState(false);
  const [selected, setSelected] = React.useState<number | null>(null);

  // Typing is faster than the round trip; 200 ms is below the threshold where a
  // list feels laggy but well above per-keystroke chatter.
  React.useEffect(() => {
    const timer = setTimeout(() => setSearch(rawSearch.trim()), 200);
    return () => clearTimeout(timer);
  }, [rawSearch]);

  const scopeId = thisConnectionOnly ? connectionId : null;

  const history = useQuery<HistoryResponse>({
    queryKey: [HISTORY_KEY, scopeId, search],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '300' });
      if (scopeId) params.set('connectionId', scopeId);
      if (search) params.set('search', search);
      return api.get<HistoryResponse>(`/api/history?${params.toString()}`);
    },
    staleTime: 5_000,
  });

  const clear = useMutation({
    mutationFn: () => api.del(`/api/history${scopeId ? `?connectionId=${encodeURIComponent(scopeId)}` : ''}`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: [HISTORY_KEY] });
      toast.success(scopeId ? 'History cleared for this connection' : 'History cleared');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not clear the history'),
  });

  const entries = history.data?.entries ?? [];

  function restore(entry: HistoryEntry): void {
    onRestore(entry.sql);
    onPicked?.();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            className="pl-6"
            placeholder="Search the query log…"
            value={rawSearch}
            onChange={(e) => setRawSearch(e.target.value)}
            autoFocus
          />
        </div>
        <Checkbox
          label="This connection"
          checked={thisConnectionOnly}
          disabled={!connectionId}
          onChange={(e) => setThisConnectionOnly(e.target.checked)}
        />
        <Button
          size="xs"
          variant="ghost"
          icon={<Trash2 className="size-3" />}
          onClick={() => setClearing(true)}
          disabled={entries.length === 0}
        >
          Clear
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {history.isPending && (
          <div className="flex items-center gap-2 p-3 text-xs text-[var(--fg-muted)]">
            <Spinner /> Reading the log…
          </div>
        )}
        {history.isError && (
          <div className="p-2">
            <ErrorBox message={history.error instanceof Error ? history.error.message : 'Could not read the history'} />
          </div>
        )}
        {history.data && entries.length === 0 && (
          <EmptyState
            icon={<History className="size-5" />}
            title={search ? 'Nothing matches that' : 'No queries yet'}
            description={
              search
                ? 'The search covers the SQL text of every execution, successful or not.'
                : 'Everything you run is logged here and survives a restart.'
            }
          />
        )}
        {entries.map((entry) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            selected={selected === entry.id}
            onSelect={() => setSelected(entry.id)}
            onRestore={() => restore(entry)}
          />
        ))}
      </div>

      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        onConfirm={() => clear.mutate()}
        title="Clear query history"
        message={
          scopeId
            ? 'Delete the logged queries for this connection? The databases themselves are untouched.'
            : 'Delete the entire query log for every connection? The databases themselves are untouched.'
        }
      />
    </div>
  );
}

const STATUS_TONE: Record<string, 'ok' | 'danger' | 'warn' | 'neutral'> = {
  ok: 'ok',
  error: 'danger',
  cancelled: 'warn',
};

function HistoryRow({
  entry,
  selected,
  onSelect,
  onRestore,
}: {
  entry: HistoryEntry;
  selected: boolean;
  onSelect: () => void;
  onRestore: () => void;
}) {
  const tone = STATUS_TONE[entry.status] ?? 'neutral';
  const Icon = entry.status === 'ok' ? Check : entry.status === 'cancelled' ? Ban : AlertTriangle;

  return (
    <div
      onClick={onSelect}
      onDoubleClick={onRestore}
      className={cn(
        'group cursor-pointer border-b border-[var(--border)] px-2 py-1.5 last:border-0',
        selected ? 'bg-[var(--selection)]' : 'hover:bg-[var(--bg-hover)]',
      )}
    >
      <div className="flex items-center gap-2 text-[10px] text-[var(--fg-subtle)]">
        <Icon
          className={cn(
            'size-3 shrink-0',
            tone === 'ok' ? 'text-[var(--ok)]' : tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--warn)]',
          )}
        />
        <span title={new Date(entry.started_at).toLocaleString()}>{relativeTime(entry.started_at)}</span>
        {entry.duration_ms !== null && <span>{formatMs(entry.duration_ms)}</span>}
        {entry.row_count !== null && <span>{entry.row_count.toLocaleString()} rows</span>}
        {entry.db_context && <Badge>{entry.db_context}</Badge>}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
        >
          Restore
        </Button>
      </div>
      <pre className="mono mt-0.5 max-h-16 overflow-hidden whitespace-pre-wrap break-words text-[var(--fg)]">
        {entry.sql}
      </pre>
      {entry.error && <p className="mt-0.5 text-[10px] text-[var(--danger)]">{entry.error}</p>}
    </div>
  );
}

export function HistoryDialog({
  open,
  onClose,
  connectionId,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  connectionId: string | null;
  onRestore: (sql: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Query history" width="lg">
      <div className="h-[60vh]">
        <HistoryPanel connectionId={connectionId} onRestore={onRestore} onPicked={onClose} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  const days = Math.floor(delta / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(2)} s`;
}
