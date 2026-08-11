'use client';

/**
 * The Redis workspace (PLAN M4).
 *
 * A different shape of UI from the SQL workspace, chosen by
 * `workspaceModeFor(engine) === 'keyvalue'`: there is no editor and no result
 * grid here. The keyspace browser is the permanent left pane, and the right pane
 * is whichever of the four tools you need — the value editor for the selected
 * key, the CLI console, the MONITOR/pub-sub streams, and INFO.
 *
 * This module registers itself with the shell (`registerTabView('redis', …)`),
 * so nothing in the shell imports Redis code.
 */

import * as React from 'react';
import { Group, Panel, Separator as PanelSeparator } from 'react-resizable-panels';
import { Database, KeyRound, Radio, Terminal } from 'lucide-react';
import { workspaceModeFor } from '../../lib/connection';
import type { KeyMeta } from '../../lib/results';
import { useWorkspaceStore } from '../../state/workspace-store';
import { registerTabView, type TabViewProps } from '../shell/workspace';
import { useConnections } from '../shell/connection-sidebar';
import { Badge, EmptyState, ErrorBox, Spinner, Tabs } from '../ui/primitives';
import { KeyspaceBrowser } from './keyspace-browser';
import { ValueEditor } from './value-editor';
import { RedisConsole } from './redis-console';
import { MonitorPanel } from './monitor-panel';
import { RedisInfo } from './redis-info';

type Pane = 'value' | 'console' | 'monitor' | 'info';

const PANES: { id: Pane; label: React.ReactNode }[] = [
  {
    id: 'value',
    label: (
      <span className="flex items-center gap-1.5">
        <KeyRound className="size-3" /> Value
      </span>
    ),
  },
  {
    id: 'console',
    label: (
      <span className="flex items-center gap-1.5">
        <Terminal className="size-3" /> Console
      </span>
    ),
  },
  {
    id: 'monitor',
    label: (
      <span className="flex items-center gap-1.5">
        <Radio className="size-3" /> Monitor
      </span>
    ),
  },
  {
    id: 'info',
    label: (
      <span className="flex items-center gap-1.5">
        <Database className="size-3" /> Info
      </span>
    ),
  },
];

export function RedisWorkspace({ tab }: TabViewProps) {
  const connections = useConnections();
  const connectionId = tab.connectionId;

  // Tab state is persisted by the workspace store, so a reload lands you on the
  // same key, database and pane.
  const [pane, setPane] = React.useState<Pane>(() => readPane(tab.state.pane));
  const [db, setDb] = React.useState<number | undefined>(() => readDb(tab.state.db));
  const [selectedKey, setSelectedKey] = React.useState<string | null>(() => readKey(tab.state.selectedKey));
  const [reloadToken, setReloadToken] = React.useState(0);
  const [visited, setVisited] = React.useState<Set<Pane>>(() => new Set<Pane>([pane]));

  React.useEffect(() => {
    setVisited((prev) => (prev.has(pane) ? prev : new Set(prev).add(pane)));
  }, [pane]);

  const tabId = tab.id;
  React.useEffect(() => {
    useWorkspaceStore.getState().setTabState(tabId, { pane, db: db ?? null, selectedKey });
  }, [tabId, pane, db, selectedKey]);

  React.useEffect(() => {
    useWorkspaceStore.getState().setTabStatus(tabId, { message: selectedKey ?? undefined });
  }, [tabId, selectedKey]);

  const bumpKeyspace = React.useCallback(() => setReloadToken((n) => n + 1), []);

  const onSelectKey = React.useCallback((meta: KeyMeta) => {
    setSelectedKey(meta.key);
    setPane('value');
  }, []);

  const onSelectDb = React.useCallback((next: number) => {
    // A key name is only meaningful inside one database, so switching drops the
    // selection rather than showing a value from the wrong db.
    setDb(next);
    setSelectedKey(null);
    setPane('value');
  }, []);

  if (!connectionId) {
    return (
      <EmptyState
        title="This tab has no connection"
        description="Pick a Redis connection in the sidebar, then reopen the keyspace."
      />
    );
  }

  const connection = connections.data?.connections.find((c) => c.id === connectionId);

  if (!connection) {
    return connections.isPending ? (
      <div className="flex items-center gap-2 p-4 text-xs text-[var(--fg-muted)]">
        <Spinner /> Loading connection…
      </div>
    ) : (
      <div className="p-3">
        <ErrorBox message="This tab points at a connection that no longer exists." />
      </div>
    );
  }

  if (workspaceModeFor(connection.engine) !== 'keyvalue') {
    return (
      <div className="p-3">
        <ErrorBox
          title="Not a keyspace connection"
          message={`${connection.name} is a ${connection.engine} connection, which has no keyspace.`}
          hint="Open this connection in a query tab instead."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel id="keyspace" minSize="15%" maxSize="60%" defaultSize="30%" className="min-w-0">
          <KeyspaceBrowser
            connectionId={connectionId}
            db={db}
            selectedKey={selectedKey}
            onSelect={onSelectKey}
            reloadToken={reloadToken}
          />
        </Panel>

        <PanelSeparator className="w-px bg-[var(--border)] transition-colors hover:bg-[var(--accent)] data-[separator]:cursor-col-resize" />

        <Panel id="detail" minSize="30%" className="min-w-0">
          <div className="flex h-full min-h-0 flex-col">
            <Tabs
              items={PANES}
              active={pane}
              onSelect={(id) => setPane(readPane(id))}
              right={
                <>
                  {connection.readOnly && <Badge tone="warn">read-only</Badge>}
                  <span className="max-w-[14rem] truncate text-[11px] text-[var(--fg-muted)]" title={connection.name}>
                    {connection.name}
                  </span>
                </>
              }
            />
            {/*
              Panes are mounted on first visit and then kept mounted, hidden with
              CSS. Unmounting would kill a running MONITOR stream, drop pub/sub
              subscriptions and throw away console scrollback every time you
              glanced at a key — but nothing is mounted before it is asked for,
              so INFO is not polled by a tab you never opened.
            */}
            <div className="min-h-0 flex-1 overflow-hidden">
              {visited.has('value') && (
                <PaneHost visible={pane === 'value'}>
                  <ValueEditor
                    connectionId={connectionId}
                    db={db}
                    keyName={selectedKey}
                    onKeyChanged={setSelectedKey}
                    onKeyspaceChanged={bumpKeyspace}
                  />
                </PaneHost>
              )}
              {visited.has('console') && (
                <PaneHost visible={pane === 'console'}>
                  <RedisConsole connectionId={connectionId} db={db} onKeyspaceChanged={bumpKeyspace} />
                </PaneHost>
              )}
              {visited.has('monitor') && (
                <PaneHost visible={pane === 'monitor'}>
                  <MonitorPanel connectionId={connectionId} />
                </PaneHost>
              )}
              {visited.has('info') && (
                <PaneHost visible={pane === 'info'}>
                  <RedisInfo connectionId={connectionId} db={db} onSelectDb={onSelectDb} />
                </PaneHost>
              )}
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  );
}

/** Keeps a visited pane in the tree but out of the layout while it is hidden. */
function PaneHost({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return <div className={visible ? 'h-full min-h-0' : 'hidden'}>{children}</div>;
}

// --- persisted tab state ----------------------------------------------------

const PANE_IDS: Pane[] = ['value', 'console', 'monitor', 'info'];

function readPane(value: unknown): Pane {
  return typeof value === 'string' && (PANE_IDS as string[]).includes(value) ? (value as Pane) : 'value';
}

function readDb(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readKey(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

registerTabView('redis', RedisWorkspace);
