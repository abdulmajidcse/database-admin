'use client';

/**
 * Status bar (PLAN §6, §8.3).
 *
 * The four facts you need at a glance and would otherwise guess wrong: which
 * connection is live, how far away it is (RTT drives page sizes and timeouts),
 * how stale the cached schema is — with the refresh that fixes it — and whether
 * a background job is still running.
 */

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Activity, Clock, Command as CommandIcon, Lock, RefreshCw, Rows3, Signal } from 'lucide-react';
import { api } from '../../lib/api-client';
import type { ConnectionState, SchemaResponse } from '../../lib/api-types';
import { describeAddress, ENGINE_LABELS } from '../../lib/connection';
import { useActiveJobCount, useActiveTab, useConnectionState, useWorkspaceStore } from '../../state/workspace-store';
import { Button, Spinner, cn } from '../ui/primitives';
import { EngineIcon, StateDot, useConnections } from './connection-sidebar';
import { openCommandPalette } from './command-palette';
import { ACCOUNT_QUERY_KEY, signOut } from './auth-gate';
import { ThemeToggle } from './theme';

/** Subset of the manager's ConnectionStatus we display; the rest is ignored. */
interface LiveStatus {
  state?: ConnectionState;
  rttMs?: number;
  serverVersion?: string;
  openSessions?: number;
  activeRuns?: number;
  tunneled?: boolean;
}

function parseStatus(payload: unknown): LiveStatus {
  if (typeof payload !== 'object' || payload === null) return {};
  const r = payload as Record<string, unknown>;
  return {
    state: typeof r.state === 'string' ? (r.state as ConnectionState) : undefined,
    rttMs: typeof r.rttMs === 'number' ? r.rttMs : undefined,
    serverVersion: typeof r.serverVersion === 'string' ? r.serverVersion : undefined,
    openSessions: typeof r.openSessions === 'number' ? r.openSessions : undefined,
    activeRuns: typeof r.activeRuns === 'number' ? r.activeRuns : undefined,
    tunneled: r.tunneled === true,
  };
}

export function StatusBar() {
  const client = useQueryClient();
  const connections = useConnections();
  const activeConnectionId = useWorkspaceStore((s) => s.activeConnectionId);
  const setBottomTab = useWorkspaceStore((s) => s.setBottomTab);
  const state = useConnectionState(activeConnectionId);
  const activeTab = useActiveTab();
  const jobCount = useActiveJobCount();
  const [now, setNow] = React.useState(() => Date.now());

  const connection = connections.data?.connections.find((c) => c.id === activeConnectionId) ?? null;
  const connected = state === 'connected';

  // One tick a second keeps the schema age honest without polling the server.
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  // Optional endpoint: when it is not wired up the bar simply shows less.
  const status = useQuery<LiveStatus>({
    queryKey: ['connection-status', activeConnectionId],
    queryFn: async () => parseStatus(await api.get<unknown>(`/api/connections/${activeConnectionId}/status`)),
    enabled: !!activeConnectionId && connected,
    retry: false,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  const schema = useQuery<SchemaResponse>({
    queryKey: ['schema', activeConnectionId],
    queryFn: () => api.get<SchemaResponse>(`/api/schema?connectionId=${encodeURIComponent(activeConnectionId ?? '')}`),
    enabled: !!activeConnectionId && connected,
    retry: false,
    staleTime: 60_000,
  });

  const [refreshing, setRefreshing] = React.useState(false);
  async function refreshSchema(): Promise<void> {
    if (!activeConnectionId) return;
    setRefreshing(true);
    try {
      await api.get(`/api/schema?connectionId=${encodeURIComponent(activeConnectionId)}&force=1`);
      await client.invalidateQueries({ queryKey: ['schema'] });
      await client.invalidateQueries({ queryKey: ['tree'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not refresh the schema');
    } finally {
      setRefreshing(false);
    }
  }

  const version = status.data?.serverVersion ?? schema.data?.model.serverVersion;
  const rtt = status.data?.rttMs;
  const schemaAgeMs = schema.data ? Math.max(0, now - schema.data.model.fetchedAt) : null;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-1 border-t border-[var(--border)] bg-[var(--bg-subtle)] px-2 text-[11px] text-[var(--fg-muted)]">
      {connection ? (
        <>
          <span
            className="size-2 shrink-0 rounded-full border border-[var(--border-strong)]"
            style={connection.color ? { background: connection.color, borderColor: connection.color } : undefined}
          />
          <StateDot state={state} />
          <span className="flex items-center gap-1 text-[var(--fg)]">
            <EngineIcon engine={connection.engine} className="size-3" />
            {connection.name}
          </span>
          <span className="text-[var(--fg-subtle)]">{describeAddress(connection.address)}</span>
          {connection.envTag === 'prod' && (
            <span className="rounded bg-[var(--danger-bg)] px-1 font-semibold uppercase text-[var(--danger)]">prod</span>
          )}
          {connection.readOnly && (
            <span className="flex items-center gap-0.5">
              <Lock className="size-3" />
              read-only
            </span>
          )}
          <Divider />
          <span>
            {ENGINE_LABELS[connection.engine]}
            {version ? ` ${version}` : ''}
          </span>
          {rtt !== undefined && (
            <>
              <Divider />
              <span className="flex items-center gap-1" title="Measured round-trip latency (§8.3)">
                <Signal className="size-3" />
                {rtt < 10 ? rtt.toFixed(1) : Math.round(rtt)} ms
              </span>
            </>
          )}
          {status.data?.tunneled && <span title="Reached through an SSH tunnel">tunnelled</span>}
        </>
      ) : (
        <span className="text-[var(--fg-subtle)]">No connection selected</span>
      )}

      {connection && (
        <>
          <Divider />
          <span className="flex items-center gap-1" title="Age of the cached schema model (§6)">
            <Clock className="size-3" />
            {schema.isFetching || refreshing ? (
              <Spinner className="size-3" />
            ) : schemaAgeMs === null ? (
              'schema not loaded'
            ) : (
              `schema ${formatAge(schemaAgeMs)}`
            )}
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="h-4 px-1"
            title="Re-introspect now"
            aria-label="Refresh schema"
            onClick={() => void refreshSchema()}
          >
            <RefreshCw className={cn('size-3', (refreshing || schema.isFetching) && 'animate-spin')} />
          </Button>
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        {activeTab?.status.rowCount !== undefined && (
          <>
            <span className="flex items-center gap-1" title="Rows in the active result">
              <Rows3 className="size-3" />
              {activeTab.status.rowCount.toLocaleString()} rows
            </span>
            {activeTab.status.durationMs !== undefined && <span>{formatMs(activeTab.status.durationMs)}</span>}
            <Divider />
          </>
        )}

        <button
          type="button"
          onClick={() => setBottomTab('jobs')}
          className={cn(
            'flex items-center gap-1 rounded px-1 hover:bg-[var(--bg-hover)]',
            jobCount > 0 && 'text-[var(--accent)]',
          )}
          title="Background jobs (§7.3)"
        >
          <Activity className="size-3" />
          {jobCount > 0 ? `${jobCount} running` : 'jobs'}
        </button>

        <Divider />
        <button
          type="button"
          onClick={openCommandPalette}
          className="flex items-center gap-1 rounded px-1 hover:bg-[var(--bg-hover)]"
          title="Command palette"
        >
          <CommandIcon className="size-3" />K
        </button>
        <ThemeToggle />
        <Button
          size="xs"
          variant="ghost"
          className="h-4 px-1"
          title="Sign out — locks the vault and closes every open connection"
          aria-label="Sign out"
          onClick={() =>
            void signOut()
              .then(() => client.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY }))
              .catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Could not sign out'))
          }
        >
          <Lock className="size-3" />
        </Button>
      </div>
    </footer>
  );
}

function Divider() {
  return <span className="mx-0.5 h-3 w-px bg-[var(--border)]" />;
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s old`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m old`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h old`;
  return `${Math.round(h / 24)}d old`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
