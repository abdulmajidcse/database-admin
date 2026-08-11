'use client';

/**
 * Saved queries (PLAN §5, M2).
 *
 * Folders are a plain string on the row rather than a table of their own: the
 * app database stores `folder` and the tree here is derived from the distinct
 * values, so renaming a folder is one UPDATE per query and never leaves an
 * orphaned node behind.
 *
 * `POST /api/saved` upserts, so "Save" and "Save as" are the same call — the
 * only difference is whether an id travels with it.
 */

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, FolderOpen, Pencil, Save, Search, Star, Trash2 } from 'lucide-react';

import { api } from '@/lib/api-client';
import type { SavedQuery } from '@/lib/api-types';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Separator,
  Spinner,
  cn,
} from '@/components/ui/primitives';

interface SavedListResponse {
  queries: SavedQuery[];
}

export const SAVED_QUERIES_KEY = ['saved-queries'] as const;

export function useSavedQueries() {
  return useQuery<SavedListResponse>({
    queryKey: SAVED_QUERIES_KEY,
    queryFn: () => api.get<SavedListResponse>('/api/saved'),
    staleTime: 10_000,
  });
}

const UNFILED = 'Unfiled';

function folderOf(q: SavedQuery): string {
  return q.folder.trim() === '' ? UNFILED : q.folder;
}

export interface SavedQueriesPanelProps {
  connectionId: string | null;
  /** The editor buffer, so "Save current" has something to write. */
  currentSql: string;
  /** Load a saved query into the editor. */
  onLoad: (sql: string, name: string) => void;
  onPicked?: () => void;
}

export function SavedQueriesPanel({ connectionId, currentSql, onLoad, onPicked }: SavedQueriesPanelProps) {
  const client = useQueryClient();
  const saved = useSavedQueries();

  const [filter, setFilter] = React.useState('');
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<SavedQuery | null>(null);
  const [editing, setEditing] = React.useState<SavedQuery | null>(null);
  const [draftName, setDraftName] = React.useState('');
  const [draftFolder, setDraftFolder] = React.useState('');

  const refresh = React.useCallback(
    () => client.invalidateQueries({ queryKey: SAVED_QUERIES_KEY }),
    [client],
  );

  const create = useMutation({
    mutationFn: (input: { name: string; folder: string; sql: string }) =>
      api.post<SavedQuery>('/api/saved', { ...input, connectionId }),
    onSuccess: async (row) => {
      await refresh();
      setSelectedId(row.id);
      toast.success(`Saved "${row.name}"`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save the query'),
  });

  const update = useMutation({
    mutationFn: (input: { id: string; name?: string; folder?: string; sql?: string }) =>
      api.put<SavedQuery>(`/api/saved/${encodeURIComponent(input.id)}`, {
        name: input.name,
        folder: input.folder,
        sql: input.sql,
      }),
    onSuccess: async () => {
      await refresh();
      setEditing(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not update the query'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/saved/${encodeURIComponent(id)}`),
    onSuccess: async () => {
      await refresh();
      setSelectedId(null);
      toast.success('Deleted');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not delete the query'),
  });

  const all = saved.data?.queries ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? all.filter(
        (q) =>
          q.name.toLowerCase().includes(needle) ||
          q.folder.toLowerCase().includes(needle) ||
          q.sql.toLowerCase().includes(needle),
      )
    : all;

  const folders = React.useMemo(() => {
    const map = new Map<string, SavedQuery[]>();
    for (const q of visible) {
      const key = folderOf(q);
      const list = map.get(key) ?? [];
      list.push(q);
      map.set(key, list);
    }
    return [...map.entries()]
      .map(([name, queries]) => ({
        name,
        queries: queries.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => (a.name === UNFILED ? 1 : b.name === UNFILED ? -1 : a.name.localeCompare(b.name)));
  }, [visible]);

  const selected = all.find((q) => q.id === selectedId) ?? null;
  const knownFolders = [...new Set(all.map((q) => q.folder).filter((f) => f.trim() !== ''))].sort();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SaveCurrentBar
        disabled={currentSql.trim() === ''}
        folders={knownFolders}
        pending={create.isPending}
        onSave={(name, folder) => create.mutate({ name, folder, sql: currentSql })}
      />

      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            className="pl-6"
            placeholder="Filter by name, folder or SQL…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_1.4fr]">
        <div className="min-h-0 overflow-y-auto border-r border-[var(--border)]">
          {saved.isPending && (
            <div className="flex items-center gap-2 p-3 text-xs text-[var(--fg-muted)]">
              <Spinner /> Loading…
            </div>
          )}
          {saved.isError && (
            <div className="p-2">
              <ErrorBox
                message={saved.error instanceof Error ? saved.error.message : 'Could not load the saved queries'}
              />
            </div>
          )}
          {saved.data && folders.length === 0 && (
            <EmptyState
              icon={<Star className="size-5" />}
              title={needle ? 'Nothing matches that' : 'No saved queries'}
              description="Name the query you are writing and it lands here, in whatever folder you type."
            />
          )}
          {folders.map((folder) => (
            <div key={folder.name}>
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [folder.name]: !c[folder.name] }))}
                className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)]"
              >
                {collapsed[folder.name] ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                <FolderOpen className="size-3" />
                <span className="truncate">{folder.name}</span>
                <span className="ml-auto font-normal">{folder.queries.length}</span>
              </button>
              {!collapsed[folder.name] &&
                folder.queries.map((q) => (
                  <div
                    key={q.id}
                    onClick={() => setSelectedId(q.id)}
                    onDoubleClick={() => {
                      onLoad(q.sql, q.name);
                      onPicked?.();
                    }}
                    className={cn(
                      'group flex cursor-pointer items-center gap-1.5 px-2 py-1 text-xs',
                      selectedId === q.id ? 'bg-[var(--selection)]' : 'hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <span className="truncate">{q.name}</span>
                    <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      <IconAction
                        label="Rename"
                        icon={<Pencil className="size-3" />}
                        onClick={() => {
                          setEditing(q);
                          setDraftName(q.name);
                          setDraftFolder(q.folder);
                        }}
                      />
                      <IconAction
                        label="Delete"
                        icon={<Trash2 className="size-3" />}
                        onClick={() => setPendingDelete(q)}
                      />
                    </span>
                  </div>
                ))}
            </div>
          ))}
        </div>

        <div className="flex min-h-0 flex-col">
          {selected ? (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
                <span className="truncate text-[13px] font-medium">{selected.name}</span>
                <span className="truncate text-[11px] text-[var(--fg-subtle)]">{folderOf(selected)}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="xs"
                    onClick={() => update.mutate({ id: selected.id, sql: currentSql })}
                    disabled={currentSql.trim() === '' || currentSql === selected.sql || update.isPending}
                    title="Overwrite this saved query with the editor's current text"
                  >
                    Update from editor
                  </Button>
                  <Button
                    size="xs"
                    variant="primary"
                    onClick={() => {
                      onLoad(selected.sql, selected.name);
                      onPicked?.();
                    }}
                  >
                    Open
                  </Button>
                </div>
              </div>
              <pre className="mono min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-2 text-[var(--fg)]">
                {selected.sql}
              </pre>
              <div className="shrink-0 border-t border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-subtle)]">
                updated {new Date(selected.updated_at).toLocaleString()}
                {selected.connection_id && ' · bound to a connection'}
              </div>
            </>
          ) : (
            <EmptyState title="Nothing selected" description="Pick a query to preview it, or double-click to open." />
          )}
        </div>
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Rename saved query"
        width="sm"
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={draftName.trim() === ''}
              onClick={() => {
                if (editing) update.mutate({ id: editing.id, name: draftName.trim(), folder: draftFolder.trim() });
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} autoFocus />
          </Field>
          <Field label="Folder" hint="Leave blank to keep it unfiled.">
            <Input
              value={draftFolder}
              onChange={(e) => setDraftFolder(e.target.value)}
              list="saved-query-folders"
              placeholder={UNFILED}
            />
          </Field>
          <datalist id="saved-query-folders">
            {knownFolders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id);
        }}
        title="Delete saved query"
        message={
          <span>
            Delete <strong>{pendingDelete?.name}</strong>? This cannot be undone.
          </span>
        }
      />
    </div>
  );
}

function SaveCurrentBar({
  disabled,
  folders,
  pending,
  onSave,
}: {
  disabled: boolean;
  folders: string[];
  pending: boolean;
  onSave: (name: string, folder: string) => void;
}) {
  const [name, setName] = React.useState('');
  const [folder, setFolder] = React.useState('');

  function submit(): void {
    const trimmed = name.trim();
    if (trimmed === '') return;
    onSave(trimmed, folder.trim());
    setName('');
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1.5">
      <Input
        placeholder="Name the current query…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        disabled={disabled}
        className="flex-1"
      />
      <Input
        placeholder="Folder"
        value={folder}
        onChange={(e) => setFolder(e.target.value)}
        list="saved-query-folders-new"
        disabled={disabled}
        className="w-40"
      />
      <datalist id="saved-query-folders-new">
        {folders.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <Separator vertical />
      <Button
        size="xs"
        variant="primary"
        icon={<Save className="size-3" />}
        loading={pending}
        disabled={disabled || name.trim() === ''}
        onClick={submit}
      >
        Save current
      </Button>
    </div>
  );
}

function IconAction({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
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

export function SavedQueriesDialog({
  open,
  onClose,
  connectionId,
  currentSql,
  onLoad,
}: {
  open: boolean;
  onClose: () => void;
  connectionId: string | null;
  currentSql: string;
  onLoad: (sql: string, name: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Saved queries" width="lg">
      <div className="h-[60vh]">
        <SavedQueriesPanel
          connectionId={connectionId}
          currentSql={currentSql}
          onLoad={onLoad}
          onPicked={onClose}
        />
      </div>
    </Dialog>
  );
}
