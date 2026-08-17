'use client';

/**
 * Command palette (PLAN M9).
 *
 * Cmd/Ctrl-K. Everything reachable by mouse in the shell is reachable here, plus
 * the few actions that belong to the active editor — those are broadcast on the
 * workspace command bus so the pane that owns them decides what to do.
 */

import * as React from 'react';
import { Command } from 'cmdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Activity,
  ChevronRight,
  Download,
  Lock,
  Monitor,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Sun,
  Table2,
  Upload,
  Wrench,
} from 'lucide-react';
import { api } from '../../lib/api-client';
import type { SchemaResponse } from '../../lib/api-types';
import { allTables, qualifiedName } from '../../lib/schema-model';
import { ENGINE_LABELS } from '../../lib/connection';
import { emitWorkspaceCommand, useActiveTab, useWorkspaceStore } from '../../state/workspace-store';
import { cn } from '../ui/primitives';
import { openExportDialog, openImportDialog, openNativeToolsDialog } from '../transfer/transfer-host';
import { connectConnection, EngineIcon, openConnectionEditor, useConnections } from './connection-sidebar';
import { ACCOUNT_QUERY_KEY, signOut } from './auth-gate';
import { setThemeMode } from './theme';

let externalOpen: ((open: boolean) => void) | null = null;

export function openCommandPalette(): void {
  externalOpen?.(true);
}

type Page = 'root' | 'connections' | 'tables';

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const [page, setPage] = React.useState<Page>('root');
  const [search, setSearch] = React.useState('');
  const client = useQueryClient();

  const connections = useConnections();
  const activeConnectionId = useWorkspaceStore((s) => s.activeConnectionId);
  const activeTab = useActiveTab();
  const setActiveConnection = useWorkspaceStore((s) => s.setActiveConnection);
  const openTab = useWorkspaceStore((s) => s.openTab);
  const setBottomTab = useWorkspaceStore((s) => s.setBottomTab);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);

  const activeConnection = connections.data?.connections.find((c) => c.id === activeConnectionId) ?? null;

  React.useEffect(() => {
    externalOpen = setOpen;
    return () => {
      externalOpen = null;
    };
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  React.useEffect(() => {
    if (!open) {
      setPage('root');
      setSearch('');
    }
  }, [open]);

  // Only fetched when the user actually asks for the table list — introspection
  // is not free on a remote link (§8.3).
  const schema = useQuery<SchemaResponse>({
    queryKey: ['schema', activeConnectionId],
    queryFn: () => api.get<SchemaResponse>(`/api/schema?connectionId=${encodeURIComponent(activeConnectionId ?? '')}`),
    enabled: open && page === 'tables' && !!activeConnectionId,
    retry: false,
  });

  const close = () => setOpen(false);

  async function refreshSchema(): Promise<void> {
    close();
    if (!activeConnectionId) return;
    try {
      await api.get(`/api/schema?connectionId=${encodeURIComponent(activeConnectionId)}&force=1`);
      await client.invalidateQueries({ queryKey: ['schema'] });
      await client.invalidateQueries({ queryKey: ['tree'] });
      emitWorkspaceCommand('refresh-schema');
      toast.success('Schema refreshed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not refresh the schema');
    }
  }

  const tables = schema.data ? allTables(schema.data.model) : [];

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      shouldFilter
      overlayClassName="fixed inset-0 z-[60] bg-black/40"
      contentClassName="fixed left-1/2 top-[12vh] z-[61] w-[min(640px,92vw)] -translate-x-1/2 border border-[var(--border)] bg-[var(--bg-panel)] shadow-2xl"
      onKeyDown={(e) => {
        // Backspace on an empty query walks back out of a sub-page.
        if (page !== 'root' && e.key === 'Backspace' && search === '') {
          e.preventDefault();
          setPage('root');
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3">
        {page !== 'root' && (
          <span className="flex items-center gap-1 rounded bg-[var(--bg-active)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--fg-muted)]">
            {page}
            <ChevronRight className="size-3" />
          </span>
        )}
        <Command.Input
          value={search}
          onValueChange={setSearch}
          autoFocus
          placeholder={
            page === 'tables' ? 'Find a table…' : page === 'connections' ? 'Switch connection…' : 'Type a command…'
          }
          className="h-10 w-full bg-transparent text-[13px] text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)]"
        />
      </div>

      <Command.List className="max-h-[50vh] overflow-y-auto p-1">
        <Command.Empty className="px-3 py-6 text-center text-xs text-[var(--fg-subtle)]">
          {page === 'tables' && schema.isFetching ? 'Reading the schema…' : 'No matching command.'}
        </Command.Empty>

        {page === 'root' && (
          <>
            <Group heading="Query">
              <Item
                value="new query tab sql editor"
                icon={<Plus className="size-3.5" />}
                onSelect={() => {
                  close();
                  openTab({ kind: 'sql' });
                }}
              >
                New query tab
              </Item>
              <Item
                value="run execute statement"
                icon={<Play className="size-3.5" />}
                onSelect={() => {
                  close();
                  emitWorkspaceCommand('run');
                }}
              >
                Run
              </Item>
              <Item
                value="open table browse data"
                icon={<Table2 className="size-3.5" />}
                onSelect={() => {
                  setSearch('');
                  setPage('tables');
                }}
                disabled={!activeConnectionId}
              >
                Open table…
              </Item>
              <Item
                value="export result table database csv json sql dump"
                icon={<Download className="size-3.5" />}
                detail="Result, table, database or server"
                // Gate on the connection the handler will actually dispatch to:
                // a SQL tab exports through its own connection, which is not
                // necessarily the sidebar's selection.
                disabled={!(activeTab?.kind === 'sql' ? activeTab.connectionId : activeConnectionId)}
                onSelect={() => {
                  close();
                  // A SQL tab owns the statement behind its current result, so
                  // it opens the wizard itself with that preselected. Anywhere
                  // else — a grid tab, a Mongo workspace, no tab at all — there
                  // is no statement and nothing listening, so open it directly.
                  if (activeTab?.kind === 'sql') emitWorkspaceCommand('export');
                  else openExportDialog({ connectionId: activeConnectionId });
                }}
              >
                Export…
              </Item>
              <Item
                value="import load csv restore dump sql script"
                icon={<Upload className="size-3.5" />}
                detail="CSV, JSON, a .sql script or a dump"
                disabled={!activeConnectionId}
                onSelect={() => {
                  close();
                  openImportDialog({ connectionId: activeConnectionId });
                }}
              >
                Import…
              </Item>
              <Item
                value="native tools mysqldump pg_dump mongodump versions"
                icon={<Wrench className="size-3.5" />}
                detail="Which dump binaries are bundled, and their versions"
                onSelect={() => {
                  close();
                  openNativeToolsDialog(activeConnection?.engine ?? null);
                }}
              >
                Dump and restore tools…
              </Item>
            </Group>

            <Group heading="Connections">
              <Item
                value="switch connection"
                icon={
                  activeConnection ? (
                    <EngineIcon engine={activeConnection.engine} />
                  ) : (
                    <Activity className="size-3.5" />
                  )
                }
                detail={activeConnection ? activeConnection.name : 'none selected'}
                onSelect={() => {
                  setSearch('');
                  setPage('connections');
                }}
              >
                Switch connection…
              </Item>
              <Item
                value="new connection add database"
                icon={<Plus className="size-3.5" />}
                onSelect={() => {
                  close();
                  openConnectionEditor(null);
                }}
              >
                New connection…
              </Item>
              <Item
                value="refresh schema introspect reload"
                icon={<RefreshCw className="size-3.5" />}
                disabled={!activeConnectionId}
                onSelect={() => void refreshSchema()}
              >
                Refresh schema
              </Item>
            </Group>

            <Group heading="View">
              <Item
                value="jobs drawer import export progress"
                icon={<Activity className="size-3.5" />}
                onSelect={() => {
                  close();
                  setBottomTab('jobs');
                }}
              >
                Show jobs
              </Item>
              <Item
                value="toggle sidebar"
                shortcut="⌘B"
                icon={<ChevronRight className="size-3.5" />}
                onSelect={() => {
                  close();
                  toggleSidebar();
                }}
              >
                Toggle sidebar
              </Item>
              <Item
                value="theme light"
                icon={<Sun className="size-3.5" />}
                onSelect={() => {
                  close();
                  setThemeMode('light');
                }}
              >
                Theme: light
              </Item>
              <Item
                value="theme dark"
                icon={<Moon className="size-3.5" />}
                onSelect={() => {
                  close();
                  setThemeMode('dark');
                }}
              >
                Theme: dark
              </Item>
              <Item
                value="theme system auto"
                icon={<Monitor className="size-3.5" />}
                onSelect={() => {
                  close();
                  setThemeMode('system');
                }}
              >
                Theme: system
              </Item>
            </Group>

            <Group heading="Security">
              <Item
                value="sign out log out lock vault"
                icon={<Lock className="size-3.5" />}
                onSelect={() => {
                  close();
                  void signOut()
                    .then(() => client.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY }))
                    .catch((err: unknown) =>
                      toast.error(err instanceof Error ? err.message : 'Could not sign out'),
                    );
                }}
              >
                Sign out
              </Item>
            </Group>
          </>
        )}

        {page === 'connections' &&
          (connections.data?.connections ?? []).map((c) => (
            <Item
              key={c.id}
              value={`${c.name} ${c.engine} ${c.envTag}`}
              icon={<EngineIcon engine={c.engine} />}
              detail={`${ENGINE_LABELS[c.engine]} · ${c.envTag}`}
              onSelect={() => {
                close();
                setActiveConnection(c.id);
                void connectConnection(c.id).catch(() => undefined);
              }}
            >
              {c.name}
            </Item>
          ))}

        {page === 'tables' &&
          tables.slice(0, 500).map((t) => (
            <Item
              key={`${t.schema ?? ''}.${t.name}`}
              value={qualifiedName(t)}
              icon={<Table2 className="size-3.5" />}
              detail={t.kind === 'table' ? undefined : t.kind.replace('_', ' ')}
              onSelect={() => {
                close();
                openTab({
                  kind: 'table',
                  title: t.name,
                  key: `table:${qualifiedName(t)}`,
                  connectionId: activeConnectionId,
                  state: { schema: t.schema, table: t.name, tableKind: t.kind },
                });
              }}
            >
              {qualifiedName(t)}
            </Item>
          ))}
      </Command.List>
    </Command.Dialog>
  );
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-[var(--fg-subtle)]"
    >
      {children}
    </Command.Group>
  );
}

function Item({
  value,
  icon,
  detail,
  shortcut,
  disabled,
  onSelect,
  children,
}: {
  value: string;
  icon?: React.ReactNode;
  detail?: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] text-[var(--fg)]',
        'data-[selected=true]:bg-[var(--selection)] data-[disabled=true]:opacity-40',
      )}
    >
      <span className="text-[var(--fg-muted)]">{icon}</span>
      <span className="truncate">{children}</span>
      {detail && <span className="truncate text-[11px] text-[var(--fg-subtle)]">{detail}</span>}
      {shortcut && <span className="mono ml-auto text-[10px] text-[var(--fg-subtle)]">{shortcut}</span>}
    </Command.Item>
  );
}
