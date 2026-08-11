'use client';

/**
 * Databases → collections, the navigator of the MongoDB workspace (PLAN M5).
 *
 * Two endpoints, both cheap on purpose: `/api/mongo/databases` is one
 * `listDatabases` (which carries each database's size), and
 * `/api/mongo/collections` lists one database's collections with the metadata
 * `estimatedDocumentCount` the connector fans out only for a tree-sized list
 * (PLAN §8.3) — so opening a database never turns into thousands of counts.
 * Collections are therefore listed with a document count; the byte size shown
 * is the database's, because that is what the server reports without a
 * privileged `$collStats` on every namespace.
 *
 * Collections load per database, on expand, so a server with fifty databases
 * costs exactly one request until you open one.
 */

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Database, Eye, RefreshCw, Search, Table2 } from 'lucide-react';
import { api } from '../../lib/api-client';
import { Button, ErrorBox, Input, Spinner, Toolbar, cn } from '../ui/primitives';
import { formatBytes, formatCount } from './query-bar';

interface MongoDatabaseEntry {
  name: string;
  sizeBytes?: number;
}

interface MongoCollectionEntry {
  name: string;
  type: string;
  count?: number;
}

interface DatabasesResponse {
  databases: MongoDatabaseEntry[];
}

interface CollectionsResponse {
  database: string;
  collections: MongoCollectionEntry[];
}

export const MONGO_DATABASES_KEY = 'mongo-databases';
export const MONGO_COLLECTIONS_KEY = 'mongo-collections';

export function useMongoDatabases(connectionId: string) {
  return useQuery<DatabasesResponse>({
    queryKey: [MONGO_DATABASES_KEY, connectionId],
    queryFn: () => api.get<DatabasesResponse>(`/api/mongo/databases?connectionId=${encodeURIComponent(connectionId)}`),
    enabled: connectionId.length > 0,
    staleTime: 30_000,
  });
}

export function useMongoCollections(connectionId: string, database: string, enabled: boolean) {
  return useQuery<CollectionsResponse>({
    queryKey: [MONGO_COLLECTIONS_KEY, connectionId, database],
    queryFn: () =>
      api.get<CollectionsResponse>(
        `/api/mongo/collections?connectionId=${encodeURIComponent(connectionId)}&database=${encodeURIComponent(database)}`,
      ),
    enabled: enabled && connectionId.length > 0 && database.length > 0,
    staleTime: 30_000,
  });
}

export interface CollectionBrowserProps {
  connectionId: string;
  database: string | null;
  collection: string | null;
  onSelect: (database: string, collection: string) => void;
}

export function CollectionBrowser({ connectionId, database, collection, onSelect }: CollectionBrowserProps) {
  const queryClient = useQueryClient();
  const databases = useMongoDatabases(connectionId);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set(database ? [database] : []));
  const [filter, setFilter] = React.useState('');

  // Opening a collection from elsewhere (a restored tab, the object tree)
  // should reveal it here rather than leave the tree closed on a stale name.
  React.useEffect(() => {
    if (!database) return;
    setExpanded((prev) => (prev.has(database) ? prev : new Set(prev).add(database)));
  }, [database]);

  const needle = filter.trim().toLowerCase();
  const entries = React.useMemo(() => {
    const list = [...(databases.data?.databases ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    // A database whose own name does not match stays visible while it is open,
    // because the filter also applies to the collections inside it.
    return needle ? list.filter((d) => d.name.toLowerCase().includes(needle) || expanded.has(d.name)) : list;
  }, [databases.data, needle, expanded]);

  function toggle(name: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: [MONGO_DATABASES_KEY, connectionId] });
    void queryClient.invalidateQueries({ queryKey: [MONGO_COLLECTIONS_KEY, connectionId] });
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-[var(--border)] bg-[var(--bg-panel)]">
      <Toolbar>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            className="h-6 pl-6"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            spellCheck={false}
          />
        </div>
        <Button
          size="xs"
          variant="ghost"
          icon={<RefreshCw className={cn('size-3', databases.isFetching && 'animate-spin')} />}
          onClick={refresh}
          title="Reload databases and collections"
          aria-label="Reload"
        />
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto py-0.5">
        {databases.isLoading && (
          <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-[var(--fg-muted)]">
            <Spinner className="size-3" /> Loading databases…
          </div>
        )}
        {databases.error && (
          <div className="p-2">
            <ErrorBox
              title="Could not list databases"
              message={databases.error instanceof Error ? databases.error.message : 'Request failed'}
            />
          </div>
        )}
        {!databases.isLoading && !databases.error && entries.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-[var(--fg-subtle)]">
            {needle ? 'No database matches the filter.' : 'This server reports no databases.'}
          </p>
        )}

        {entries.map((entry) => {
          const open = expanded.has(entry.name);
          return (
            <div key={entry.name}>
              <button
                type="button"
                onClick={() => toggle(entry.name)}
                className={cn(
                  'flex w-full items-center gap-1 px-1.5 py-0.5 text-left text-xs hover:bg-[var(--bg-hover)]',
                  database === entry.name && 'text-[var(--fg)]',
                )}
              >
                {open ? (
                  <ChevronDown className="size-3 shrink-0 text-[var(--fg-subtle)]" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-[var(--fg-subtle)]" />
                )}
                <Database className="size-3 shrink-0 text-[var(--fg-subtle)]" />
                <span className="truncate">{entry.name}</span>
                <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-[var(--fg-subtle)]">
                  {formatBytes(entry.sizeBytes)}
                </span>
              </button>
              {open && (
                <CollectionList
                  connectionId={connectionId}
                  database={entry.name}
                  needle={needle}
                  activeCollection={database === entry.name ? collection : null}
                  onSelect={onSelect}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CollectionList({
  connectionId,
  database,
  needle,
  activeCollection,
  onSelect,
}: {
  connectionId: string;
  database: string;
  needle: string;
  activeCollection: string | null;
  onSelect: (database: string, collection: string) => void;
}) {
  const collections = useMongoCollections(connectionId, database, true);

  const list = React.useMemo(() => {
    const all = [...(collections.data?.collections ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    return needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all;
  }, [collections.data, needle]);

  if (collections.isLoading) {
    return (
      <div className="flex items-center gap-2 py-0.5 pl-7 text-[11px] text-[var(--fg-muted)]">
        <Spinner className="size-3" /> Loading…
      </div>
    );
  }
  if (collections.error) {
    return (
      <p className="mono py-0.5 pl-7 text-[11px] text-[var(--danger)]">
        {collections.error instanceof Error ? collections.error.message : 'Request failed'}
      </p>
    );
  }
  if (list.length === 0) {
    return (
      <p className="py-0.5 pl-7 text-[11px] text-[var(--fg-subtle)]">
        {needle ? 'No collection matches.' : 'No collections.'}
      </p>
    );
  }

  return (
    <>
      {list.map((entry) => {
        const isView = entry.type !== 'collection';
        return (
          <button
            key={entry.name}
            type="button"
            onClick={() => onSelect(database, entry.name)}
            title={isView ? `${entry.name} (${entry.type})` : entry.name}
            className={cn(
              'flex w-full items-center gap-1 py-0.5 pl-7 pr-1.5 text-left text-xs hover:bg-[var(--bg-hover)]',
              activeCollection === entry.name && 'bg-[var(--selection)] text-[var(--fg)]',
            )}
          >
            {isView ? (
              <Eye className="size-3 shrink-0 text-[var(--fg-subtle)]" />
            ) : (
              <Table2 className="size-3 shrink-0 text-[var(--fg-subtle)]" />
            )}
            <span className="truncate">{entry.name}</span>
            <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-[var(--fg-subtle)]">
              {/* Views have no metadata count, so they show their kind instead.
                  A count from collection metadata is an estimate — hence the ~. */}
              {isView ? entry.type : entry.count === undefined ? '—' : `~${formatCount(entry.count)}`}
            </span>
          </button>
        );
      })}
    </>
  );
}
