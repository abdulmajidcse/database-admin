'use client';

/**
 * Connection list (PLAN §4, §8.3).
 *
 * Grouped by environment so a prod link never hides among a dozen dev ones, with
 * a live state dot fed by the `connection-state` WebSocket channel — the manager
 * reconnects in the background after a laptop sleeps, and the dot is how you see
 * that happen.
 */

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  HardDrive,
  Leaf,
  Lock,
  Pencil,
  Plug,
  Plus,
  Search,
  Trash2,
  Unplug,
  Zap,
} from 'lucide-react';
import { api } from '../../lib/api-client';
import type { ConnectionListResponse, ConnectionState } from '../../lib/api-types';
import { describeAddress, ENGINE_LABELS, type ConnectionConfig, type ConnectionInput, type EnvTag } from '../../lib/connection';
import type { EngineKind } from '../../lib/schema-model';
import { Button, ConfirmDialog, EmptyState, ErrorBox, Input, Spinner, Toolbar, cn } from '../ui/primitives';
import { useConnStateStore, useWorkspaceStore } from '../../state/workspace-store';
import { ConnectionDialog, connectionToInput } from './connection-dialog';

export const CONNECTIONS_QUERY_KEY = ['connections'] as const;

export function useConnections() {
  return useQuery<ConnectionListResponse>({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: () => api.get<ConnectionListResponse>('/api/connections'),
    staleTime: 10_000,
    // The list carries the manager's own view of every state, which is what
    // keeps the dots honest even when nothing is pushing on the socket.
    refetchInterval: 20_000,
  });
}

/** /api/connections/[id]/connect answers with the manager's ConnectionStatus. */
function stateFromStatus(payload: unknown): ConnectionState | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const state = (payload as { state?: unknown }).state;
  return typeof state === 'string' ? (state as ConnectionState) : null;
}

export async function connectConnection(id: string): Promise<void> {
  useConnStateStore.getState().apply(id, 'connecting');
  try {
    const status = await api.post<unknown>(`/api/connections/${id}/connect`);
    useConnStateStore.getState().apply(id, stateFromStatus(status) ?? 'connected');
  } catch (err) {
    useConnStateStore.getState().apply(id, 'error', err instanceof Error ? err.message : undefined);
    toast.error(err instanceof Error ? err.message : 'Could not connect');
    throw err;
  }
}

export async function disconnectConnection(id: string): Promise<void> {
  try {
    await api.post(`/api/connections/${id}/disconnect`);
    useConnStateStore.getState().apply(id, 'closed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not disconnect');
  }
}

// --- engine presentation ---------------------------------------------------

const ENGINE_ICONS: Record<EngineKind, React.ComponentType<{ className?: string }>> = {
  postgres: Database,
  mysql: Database,
  mariadb: Database,
  sqlite: HardDrive,
  redis: Zap,
  mongodb: Leaf,
};

export function EngineIcon({ engine, className }: { engine: EngineKind; className?: string }) {
  const Icon = ENGINE_ICONS[engine];
  return <Icon className={className ?? 'size-3.5'} />;
}

const STATE_TONE: Record<ConnectionState, string> = {
  idle: 'bg-[var(--fg-subtle)]',
  connecting: 'bg-[var(--warn)] animate-pulse',
  connected: 'bg-[var(--ok)]',
  reconnecting: 'bg-[var(--warn)] animate-pulse',
  closed: 'bg-[var(--fg-subtle)]',
  error: 'bg-[var(--danger)]',
};

export function StateDot({ state, className }: { state: ConnectionState; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', STATE_TONE[state], className)} title={state} />;
}

// --- external opener so the palette can start a new connection -------------

interface DialogState {
  open: boolean;
  connection: ConnectionConfig | null;
  initial: ConnectionInput | null;
}

const CLOSED: DialogState = { open: false, connection: null, initial: null };

let externalOpen: ((state: DialogState) => void) | null = null;

/** Used by the command palette; the dialog itself lives in the sidebar. */
export function openConnectionEditor(connection?: ConnectionConfig | null): void {
  externalOpen?.({ open: true, connection: connection ?? null, initial: null });
}

// --- sidebar ---------------------------------------------------------------

const ENV_ORDER: EnvTag[] = ['dev', 'staging', 'prod'];
const ENV_LABEL: Record<EnvTag, string> = { dev: 'Development', staging: 'Staging', prod: 'Production' };

export function ConnectionSidebar() {
  const connections = useConnections();
  const client = useQueryClient();
  const activeConnectionId = useWorkspaceStore((s) => s.activeConnectionId);
  const setActiveConnection = useWorkspaceStore((s) => s.setActiveConnection);
  const states = useConnStateStore((s) => s.states);
  const mergeStates = useConnStateStore((s) => s.merge);

  const [filter, setFilter] = React.useState('');
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [dialog, setDialog] = React.useState<DialogState>(CLOSED);
  const [pendingDelete, setPendingDelete] = React.useState<ConnectionConfig | null>(null);

  React.useEffect(() => {
    externalOpen = setDialog;
    return () => {
      externalOpen = null;
    };
  }, []);

  // The HTTP snapshot seeds the dots; live transitions arrive over the socket.
  const httpStates = connections.data?.states;
  React.useEffect(() => {
    if (httpStates) mergeStates(httpStates);
  }, [httpStates, mergeStates]);

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/connections/${id}`),
    onSuccess: async (_res, id) => {
      if (activeConnectionId === id) setActiveConnection(null);
      await client.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
      toast.success('Connection deleted');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not delete'),
  });

  const all = connections.data?.connections ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? all.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          c.engine.includes(needle) ||
          describeAddress(c.address).toLowerCase().includes(needle),
      )
    : all;

  const groups = ENV_ORDER.map((env) => ({ env, items: visible.filter((c) => c.envTag === env) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-panel)]">
      <Toolbar>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">Connections</span>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          title="New connection"
          onClick={() => setDialog({ open: true, connection: null, initial: null })}
        >
          <Plus className="size-3.5" />
        </Button>
      </Toolbar>

      <div className="border-b border-[var(--border)] px-2 py-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            className="pl-6"
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {connections.isPending && (
          <div className="flex items-center gap-2 p-3 text-xs text-[var(--fg-muted)]">
            <Spinner /> Loading…
          </div>
        )}
        {connections.isError && (
          <div className="p-2">
            <ErrorBox
              message={connections.error instanceof Error ? connections.error.message : 'Could not load connections'}
            />
          </div>
        )}
        {connections.data && all.length === 0 && (
          <EmptyState
            icon={<Database className="size-6" />}
            title="No connections yet"
            description="Add MySQL, MariaDB, PostgreSQL, SQLite, Redis or MongoDB."
            action={
              <Button variant="primary" onClick={() => setDialog({ open: true, connection: null, initial: null })}>
                New connection
              </Button>
            }
          />
        )}

        {groups.map((group) => (
          <div key={group.env}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [group.env]: !c[group.env] }))}
              className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)]"
            >
              {collapsed[group.env] ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
              <span className={group.env === 'prod' ? 'text-[var(--danger)]' : undefined}>{ENV_LABEL[group.env]}</span>
              <span className="ml-auto font-normal">{group.items.length}</span>
            </button>
            {!collapsed[group.env] &&
              group.items.map((c) => (
                <ConnectionRow
                  key={c.id}
                  connection={c}
                  state={states[c.id] ?? 'idle'}
                  active={activeConnectionId === c.id}
                  onSelect={() => {
                    setActiveConnection(c.id);
                    const state = useConnStateStore.getState().states[c.id];
                    if (state !== 'connected' && state !== 'connecting') void connectConnection(c.id).catch(() => undefined);
                  }}
                  onConnect={() => void connectConnection(c.id).catch(() => undefined)}
                  onDisconnect={() => void disconnectConnection(c.id)}
                  onEdit={() => setDialog({ open: true, connection: c, initial: null })}
                  onDuplicate={() =>
                    setDialog({
                      open: true,
                      connection: null,
                      // Secrets never leave the server, so a copy always needs its
                      // password entered again (§9.3).
                      initial: { ...connectionToInput(c), name: `${c.name} copy` },
                    })
                  }
                  onDelete={() => setPendingDelete(c)}
                />
              ))}
          </div>
        ))}
      </div>

      <ConnectionDialog
        open={dialog.open}
        connection={dialog.connection}
        initial={dialog.initial}
        onClose={() => setDialog(CLOSED)}
        onSaved={(saved) => setActiveConnection(saved.id)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id);
        }}
        title="Delete connection"
        confirmWord={pendingDelete?.name}
        message={
          <span>
            Delete <strong>{pendingDelete?.name}</strong> and its stored credentials? The database itself is untouched.
          </span>
        }
      />
    </div>
  );
}

function ConnectionRow({
  connection,
  state,
  active,
  onSelect,
  onConnect,
  onDisconnect,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  connection: ConnectionConfig;
  state: ConnectionState;
  active: boolean;
  onSelect: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const connected = state === 'connected';
  return (
    <div
      onClick={onSelect}
      className={cn(
        'group flex cursor-pointer items-center gap-1.5 px-2 py-1 text-xs',
        active ? 'bg-[var(--selection)]' : 'hover:bg-[var(--bg-hover)]',
      )}
      title={`${ENGINE_LABELS[connection.engine]} · ${describeAddress(connection.address)}`}
    >
      <span
        className="size-2 shrink-0 rounded-full border border-[var(--border-strong)]"
        style={connection.color ? { background: connection.color, borderColor: connection.color } : undefined}
      />
      <EngineIcon engine={connection.engine} className="size-3.5 shrink-0 text-[var(--fg-muted)]" />
      <span className="truncate">{connection.name}</span>
      {connection.readOnly && <Lock className="size-3 shrink-0 text-[var(--fg-subtle)]" />}
      {connection.envTag === 'prod' && (
        <span className="shrink-0 rounded bg-[var(--danger-bg)] px-1 text-[9px] font-semibold uppercase text-[var(--danger)]">
          prod
        </span>
      )}

      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <span className="flex items-center gap-1 opacity-100 group-hover:hidden">
          <StateDot state={state} />
        </span>
        <span className="hidden items-center gap-0.5 group-hover:flex">
          <RowAction
            label={connected ? 'Disconnect' : 'Connect'}
            onClick={connected ? onDisconnect : onConnect}
            icon={connected ? <Unplug className="size-3" /> : <Plug className="size-3" />}
          />
          <RowAction label="Edit" onClick={onEdit} icon={<Pencil className="size-3" />} />
          <RowAction label="Duplicate" onClick={onDuplicate} icon={<Copy className="size-3" />} />
          <RowAction label="Delete" onClick={onDelete} icon={<Trash2 className="size-3" />} />
        </span>
      </span>
    </div>
  );
}

function RowAction({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-0.5 text-[var(--fg-muted)] hover:bg-[var(--bg-active)] hover:text-[var(--fg)]"
    >
      {icon}
    </button>
  );
}
