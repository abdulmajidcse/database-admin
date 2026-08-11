'use client';

/**
 * Index management for a collection (PLAN M5).
 *
 * Lists what `/api/mongo/indexes` reports — keys, unique/sparse/TTL and the
 * size from `$collStats` when the server grants it — and builds new ones with a
 * key builder rather than a JSON box, because the shape of an index key is
 * small and fixed: a field plus a direction (1 / -1) or a special type the
 * connector accepts (`text`, `hashed`, `2dsphere`, `2d`).
 *
 * Dropping is confirmed by typing the index name (PLAN §9): rebuilding a large
 * index on a busy collection is expensive, so it is not a one-click mistake.
 * `_id_` cannot be dropped at all, which the server enforces too.
 */

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Hash, KeyRound, Plus, RefreshCw, Trash2, Type } from 'lucide-react';
import { api } from '../../lib/api-client';
import type { MongoIndexesResponse } from '../../lib/api-types';
import type { IndexInfo } from '../../lib/results';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Select,
  Spinner,
  Toolbar,
  cn,
} from '../ui/primitives';
import { formatBytes } from './query-bar';

const INDEXES_KEY = 'mongo-indexes';

/** What the connector accepts; anything else comes back as a 400 naming these. */
const KEY_TYPES: { value: string; label: string }[] = [
  { value: '1', label: 'Ascending (1)' },
  { value: '-1', label: 'Descending (-1)' },
  { value: 'text', label: 'Text' },
  { value: 'hashed', label: 'Hashed' },
  { value: '2dsphere', label: '2dsphere' },
  { value: '2d', label: '2d' },
];

export interface MongoIndexesProps {
  connectionId: string;
  database: string;
  collection: string;
}

export function MongoIndexes({ connectionId, database, collection }: MongoIndexesProps) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [dropTarget, setDropTarget] = React.useState<IndexInfo | null>(null);
  const [busy, setBusy] = React.useState(false);

  const queryKey = [INDEXES_KEY, connectionId, database, collection];
  const indexes = useQuery<MongoIndexesResponse>({
    queryKey,
    queryFn: () =>
      api.get<MongoIndexesResponse>(
        `/api/mongo/indexes?connectionId=${encodeURIComponent(connectionId)}&database=${encodeURIComponent(
          database,
        )}&collection=${encodeURIComponent(collection)}`,
      ),
    enabled: connectionId.length > 0 && database.length > 0 && collection.length > 0,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  async function dropIndex(name: string): Promise<void> {
    setBusy(true);
    try {
      await api.post('/api/mongo/index/drop', { connectionId, database, collection, name });
      toast.success(`Dropped ${name}`);
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not drop the index');
    } finally {
      setBusy(false);
    }
  }

  const list = indexes.data?.indexes ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="mono text-[11px] text-[var(--fg-muted)]">
          {database}.{collection}
        </span>
        <Button
          size="xs"
          variant="ghost"
          icon={<RefreshCw className={cn('size-3', indexes.isFetching && 'animate-spin')} />}
          onClick={() => void invalidate()}
        >
          Refresh
        </Button>
        <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={() => setCreateOpen(true)}>
          Create index
        </Button>
        <span className="ml-auto text-[11px] text-[var(--fg-muted)]">
          {list.length} index{list.length === 1 ? '' : 'es'}
        </span>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto">
        {indexes.isLoading && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
        {indexes.error && (
          <div className="p-3">
            <ErrorBox
              title="Could not list indexes"
              message={indexes.error instanceof Error ? indexes.error.message : 'Request failed'}
            />
          </div>
        )}
        {!indexes.isLoading && !indexes.error && list.length === 0 && (
          <EmptyState
            icon={<KeyRound className="size-5" />}
            title="No indexes"
            description="Every collection has at least an _id index; this one reported none."
          />
        )}
        {list.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--grid-header)] text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Name</th>
                <th className="px-2 py-1 text-left font-medium">Keys</th>
                <th className="px-2 py-1 text-left font-medium">Properties</th>
                <th className="px-2 py-1 text-right font-medium">Size</th>
                <th className="w-8 px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {list.map((index) => (
                <tr key={index.name} className="border-b border-[var(--border)] last:border-0 even:bg-[var(--row-alt)]">
                  <td className="mono px-2 py-1 align-top">{index.name}</td>
                  <td className="px-2 py-1 align-top">
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(index.keys).map(([field, direction]) => (
                        <span
                          key={field}
                          className="mono inline-flex items-center gap-1 rounded bg-[var(--bg-active)] px-1 py-0.5 text-[11px]"
                        >
                          {field}
                          <KeyDirection direction={direction} />
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-1 align-top">
                    <div className="flex flex-wrap gap-1">
                      {index.name === '_id_' && <Badge tone="accent">primary</Badge>}
                      {index.unique && <Badge tone="ok">unique</Badge>}
                      {index.sparse && <Badge>sparse</Badge>}
                      {index.ttlSeconds !== undefined && <Badge tone="warn">TTL {index.ttlSeconds}s</Badge>}
                    </div>
                  </td>
                  <td className="px-2 py-1 text-right align-top tabular-nums text-[var(--fg-muted)]">
                    {formatBytes(index.sizeBytes)}
                  </td>
                  <td className="px-2 py-1 text-right align-top">
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={<Trash2 className="size-3" />}
                      disabled={index.name === '_id_' || busy}
                      title={index.name === '_id_' ? 'The _id index cannot be dropped' : `Drop ${index.name}`}
                      aria-label={`Drop ${index.name}`}
                      onClick={() => setDropTarget(index)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <CreateIndexDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        connectionId={connectionId}
        database={database}
        collection={collection}
        onCreated={() => void invalidate()}
      />

      <ConfirmDialog
        open={dropTarget !== null}
        onClose={() => setDropTarget(null)}
        onConfirm={() => {
          if (dropTarget) void dropIndex(dropTarget.name);
        }}
        title="Drop index"
        confirmWord={dropTarget?.name}
        message={
          <div className="flex flex-col gap-2">
            <p>
              Dropping <span className="mono">{dropTarget?.name}</span> from{' '}
              <span className="mono">
                {database}.{collection}
              </span>{' '}
              is immediate. Rebuilding it later reads the whole collection.
            </p>
            {dropTarget && (
              <p className="mono text-[var(--fg-muted)]">{JSON.stringify(dropTarget.keys)}</p>
            )}
          </div>
        }
      />
    </div>
  );
}

function KeyDirection({ direction }: { direction: 1 | -1 | string }) {
  if (direction === 1) return <ArrowUp className="size-3 text-[var(--fg-subtle)]" />;
  if (direction === -1) return <ArrowDown className="size-3 text-[var(--fg-subtle)]" />;
  if (direction === 'text') return <Type className="size-3 text-[var(--fg-subtle)]" />;
  if (direction === 'hashed') return <Hash className="size-3 text-[var(--fg-subtle)]" />;
  return <span className="text-[10px] text-[var(--fg-subtle)]">{direction}</span>;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

interface KeyRow {
  field: string;
  type: string;
}

function CreateIndexDialog({
  open,
  onClose,
  connectionId,
  database,
  collection,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  connectionId: string;
  database: string;
  collection: string;
  onCreated: () => void;
}) {
  const [keys, setKeys] = React.useState<KeyRow[]>([{ field: '', type: '1' }]);
  const [name, setName] = React.useState('');
  const [unique, setUnique] = React.useState(false);
  const [sparse, setSparse] = React.useState(false);
  const [ttl, setTtl] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setKeys([{ field: '', type: '1' }]);
    setName('');
    setUnique(false);
    setSparse(false);
    setTtl('');
    setError(null);
  }, [open]);

  const filled = keys.filter((k) => k.field.trim().length > 0);
  // Mongo's own naming convention, so the placeholder matches what the server
  // would choose if the name is left blank.
  const defaultName = filled.map((k) => `${k.field.trim()}_${k.type}`).join('_');

  async function create(): Promise<void> {
    if (filled.length === 0) {
      setError('An index needs at least one key.');
      return;
    }
    const fields = new Set(filled.map((k) => k.field.trim()));
    if (fields.size !== filled.length) {
      setError('The same field cannot appear twice in one index.');
      return;
    }
    const ttlSeconds = ttl.trim() === '' ? undefined : Number(ttl);
    if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 0)) {
      setError('TTL must be a whole number of seconds.');
      return;
    }
    if (ttlSeconds !== undefined && filled.length !== 1) {
      setError('A TTL index expires documents from a single date field, so it must have exactly one key.');
      return;
    }

    const keySpec: Record<string, 1 | -1 | string> = {};
    for (const row of filled) {
      keySpec[row.field.trim()] = row.type === '1' ? 1 : row.type === '-1' ? -1 : row.type;
    }

    setBusy(true);
    setError(null);
    try {
      await api.post('/api/mongo/index/create', {
        connectionId,
        database,
        collection,
        index: {
          name: name.trim() || undefined,
          keys: keySpec,
          unique,
          sparse,
          ttlSeconds,
        },
      });
      toast.success(`Created ${name.trim() || defaultName}`);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the index');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Create index · ${database}.${collection}`}
      width="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Keys" hint="Order matters: a compound index serves prefixes of its key list, not any subset.">
          <div className="flex flex-col gap-1">
            {keys.map((row, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  className="mono flex-1"
                  value={row.field}
                  placeholder="field.path"
                  spellCheck={false}
                  onChange={(e) =>
                    setKeys((prev) => prev.map((k, j) => (j === i ? { ...k, field: e.target.value } : k)))
                  }
                />
                <Select
                  className="w-44"
                  value={row.type}
                  onChange={(e) => setKeys((prev) => prev.map((k, j) => (j === i ? { ...k, type: e.target.value } : k)))}
                >
                  {KEY_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
                <Button
                  size="xs"
                  variant="ghost"
                  icon={<Trash2 className="size-3" />}
                  aria-label="Remove key"
                  disabled={keys.length === 1}
                  onClick={() => setKeys((prev) => prev.filter((_, j) => j !== i))}
                />
              </div>
            ))}
            <div>
              <Button
                size="xs"
                icon={<Plus className="size-3" />}
                onClick={() => setKeys((prev) => [...prev, { field: '', type: '1' }])}
              >
                Add key
              </Button>
            </div>
          </div>
        </Field>

        <Field label="Name" hint={defaultName ? `Blank uses Mongo's own name: ${defaultName}` : undefined}>
          <Input className="mono" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </Field>

        <div className="flex flex-wrap items-center gap-4">
          <Checkbox label="Unique" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
          <Checkbox label="Sparse" checked={sparse} onChange={(e) => setSparse(e.target.checked)} />
          <label className="flex items-center gap-1.5 text-[13px]">
            <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">TTL seconds</span>
            <Input
              className="h-7 w-28 tabular-nums"
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              placeholder="none"
              inputMode="numeric"
            />
          </label>
        </div>

        <p className="text-[11px] text-[var(--fg-subtle)]">
          Building an index reads the whole collection. On a large collection this holds resources for as long as it
          takes, so prefer a quiet moment on a busy server.
        </p>

        {error && <ErrorBox title="Not created" message={error} />}
      </div>
    </Dialog>
  );
}
