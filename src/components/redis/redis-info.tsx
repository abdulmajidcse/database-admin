'use client';

/**
 * INFO + database list (PLAN M4).
 *
 * `INFO` is a wall of `key:value` under `# Section` headers; the connector has
 * already parsed it into sections, and this panel turns the handful of fields
 * that answer real questions ("is it swapping?", "is the replica caught up?",
 * "did the last BGSAVE work?") into readable tiles. Every remaining field stays
 * reachable in a raw table per section, so the panel never hides anything.
 *
 * The database list comes from `/api/redis/databases` (INFO keyspace plus
 * CONFIG GET databases where that is allowed) and doubles as the db switcher.
 * Under Redis Cluster there is one logical database and SELECT does not exist,
 * which the API reports as `selectable: false`.
 */

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Database, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api-client';
import { Badge, Button, Checkbox, ErrorBox, Spinner, Toolbar, cn } from '../ui/primitives';
import { formatBytes, formatCount, formatDurationMs } from './keyspace-browser';

/** Shape returned by GET /api/redis/info. */
interface RedisInfoResponse {
  sections: Record<string, Record<string, string>>;
  version: string | null;
}

/** Shape returned by GET /api/redis/databases. */
interface RedisDatabasesResponse {
  databases: { index: number; keys: number }[];
  selectable: boolean;
}

type TileFormat = 'text' | 'number' | 'bytes' | 'limit' | 'seconds' | 'ratio' | 'status' | 'bool' | 'epoch';

interface TileSpec {
  label: string;
  field: string;
  format: TileFormat;
  /** Fields whose "bad" value should read as a warning rather than a fact. */
  warnWhen?: (raw: string) => boolean;
}

interface GroupSpec {
  id: string;
  title: string;
  section: string;
  tiles: TileSpec[];
}

const GROUPS: GroupSpec[] = [
  {
    id: 'memory',
    title: 'Memory',
    section: 'memory',
    tiles: [
      { label: 'Used', field: 'used_memory', format: 'bytes' },
      { label: 'RSS', field: 'used_memory_rss', format: 'bytes' },
      { label: 'Peak', field: 'used_memory_peak', format: 'bytes' },
      { label: 'Max', field: 'maxmemory', format: 'limit' },
      { label: 'Policy', field: 'maxmemory_policy', format: 'text' },
      {
        label: 'Fragmentation',
        field: 'mem_fragmentation_ratio',
        format: 'ratio',
        // Above ~1.5 the allocator is holding far more than Redis asked for.
        warnWhen: (raw) => Number(raw) > 1.5,
      },
    ],
  },
  {
    id: 'clients',
    title: 'Clients',
    section: 'clients',
    tiles: [
      { label: 'Connected', field: 'connected_clients', format: 'number' },
      { label: 'Blocked', field: 'blocked_clients', format: 'number', warnWhen: (raw) => Number(raw) > 0 },
      { label: 'Watching', field: 'watching_clients', format: 'number' },
      { label: 'Max input buffer', field: 'client_recent_max_input_buffer', format: 'bytes' },
    ],
  },
  {
    id: 'persistence',
    title: 'Persistence',
    section: 'persistence',
    tiles: [
      { label: 'Loading', field: 'loading', format: 'bool', warnWhen: (raw) => raw === '1' },
      {
        label: 'Last BGSAVE',
        field: 'rdb_last_bgsave_status',
        format: 'status',
        warnWhen: (raw) => raw.toLowerCase() !== 'ok',
      },
      { label: 'Saved at', field: 'rdb_last_save_time', format: 'epoch' },
      { label: 'Changes since save', field: 'rdb_changes_since_last_save', format: 'number' },
      { label: 'AOF', field: 'aof_enabled', format: 'bool' },
      {
        label: 'Last AOF write',
        field: 'aof_last_write_status',
        format: 'status',
        warnWhen: (raw) => raw.toLowerCase() !== 'ok',
      },
    ],
  },
  {
    id: 'stats',
    title: 'Stats',
    section: 'stats',
    tiles: [
      { label: 'Ops/sec', field: 'instantaneous_ops_per_sec', format: 'number' },
      { label: 'Commands', field: 'total_commands_processed', format: 'number' },
      { label: 'Expired keys', field: 'expired_keys', format: 'number' },
      { label: 'Evicted keys', field: 'evicted_keys', format: 'number', warnWhen: (raw) => Number(raw) > 0 },
      { label: 'Connections', field: 'total_connections_received', format: 'number' },
      {
        label: 'Rejected',
        field: 'rejected_connections',
        format: 'number',
        warnWhen: (raw) => Number(raw) > 0,
      },
    ],
  },
  {
    id: 'replication',
    title: 'Replication',
    section: 'replication',
    tiles: [
      { label: 'Role', field: 'role', format: 'text' },
      { label: 'Replicas', field: 'connected_slaves', format: 'number' },
      {
        label: 'Link to master',
        field: 'master_link_status',
        format: 'status',
        warnWhen: (raw) => raw.toLowerCase() !== 'up',
      },
      { label: 'Repl offset', field: 'master_repl_offset', format: 'number' },
    ],
  },
];

const GROUPED_SECTIONS = new Set(GROUPS.map((g) => g.section).concat(['server']));

export interface RedisInfoProps {
  connectionId: string;
  db: number | undefined;
  onSelectDb: (db: number) => void;
}

export function RedisInfo({ connectionId, db, onSelectDb }: RedisInfoProps) {
  const [live, setLive] = React.useState(false);
  const client = useQueryClient();

  const info = useQuery<RedisInfoResponse>({
    queryKey: ['redis-info', connectionId],
    queryFn: () => api.get<RedisInfoResponse>(`/api/redis/info?connectionId=${encodeURIComponent(connectionId)}`),
    refetchInterval: live ? 5000 : false,
    staleTime: 2000,
  });

  const databases = useQuery<RedisDatabasesResponse>({
    queryKey: ['redis-databases', connectionId],
    queryFn: () =>
      api.get<RedisDatabasesResponse>(`/api/redis/databases?connectionId=${encodeURIComponent(connectionId)}`),
    refetchInterval: live ? 5000 : false,
    staleTime: 2000,
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['redis-info', connectionId] });
    void client.invalidateQueries({ queryKey: ['redis-databases', connectionId] });
  };

  const sections = info.data?.sections ?? {};
  const server = sections.server ?? {};
  const uptimeSeconds = Number(server.uptime_in_seconds);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <Database className="size-3.5 text-[var(--fg-muted)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">Server</span>
        {info.data?.version && <Badge tone="accent">v{info.data.version}</Badge>}
        {server.redis_mode && <Badge>{server.redis_mode}</Badge>}
        {Number.isFinite(uptimeSeconds) && server.uptime_in_seconds !== undefined && (
          <span className="text-[11px] text-[var(--fg-muted)]">up {formatDurationMs(uptimeSeconds * 1000)}</span>
        )}
        <Checkbox
          className="ml-auto text-[11px]"
          label="Live"
          checked={live}
          onChange={(e) => setLive(e.target.checked)}
        />
        <Button size="xs" variant="ghost" onClick={refresh} title="Refresh">
          <RefreshCw className={cn('size-3.5', (info.isFetching || databases.isFetching) && 'animate-spin')} />
        </Button>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {info.isPending && (
          <div className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
            <Spinner /> Reading INFO…
          </div>
        )}
        {info.isError && (
          <ErrorBox
            title="INFO failed"
            message={info.error instanceof Error ? info.error.message : 'Could not read INFO'}
          />
        )}

        {info.data && (
          <div className="flex flex-col gap-3">
            <DatabaseList
              data={databases.data}
              error={databases.error}
              current={db}
              onSelectDb={onSelectDb}
              hits={sections.stats}
            />

            {GROUPS.map((group) => {
              const values = sections[group.section];
              if (!values) return null;
              return <GroupCard key={group.id} group={group} values={values} />;
            })}

            {Object.entries(sections)
              .filter(([name]) => !GROUPED_SECTIONS.has(name))
              .map(([name, values]) => (
                <RawSection key={name} title={name} values={values} defaultOpen={false} />
              ))}

            {sections.server && <RawSection title="server" values={sections.server} defaultOpen={false} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

function DatabaseList({
  data,
  error,
  current,
  onSelectDb,
  hits,
}: {
  data: RedisDatabasesResponse | undefined;
  error: unknown;
  current: number | undefined;
  onSelectDb: (db: number) => void;
  hits: Record<string, string> | undefined;
}) {
  const hitRate = ratioOf(hits?.keyspace_hits, hits?.keyspace_misses);

  return (
    <section className="surface">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">Databases</h3>
        {data && !data.selectable && (
          <Badge tone="warn">single logical database — SELECT is not available in cluster mode</Badge>
        )}
        {hitRate !== null && (
          <span className="ml-auto text-[11px] text-[var(--fg-muted)]">
            keyspace hit rate <span className="tabular-nums text-[var(--fg)]">{(hitRate * 100).toFixed(1)}%</span>
          </span>
        )}
      </header>

      {error !== null && error !== undefined && (
        <p className="px-2 py-1 text-[11px] text-[var(--danger)]">
          {error instanceof Error ? error.message : 'Could not list databases'}
        </p>
      )}

      {data && data.databases.length === 0 && (
        <p className="px-2 py-2 text-xs text-[var(--fg-subtle)]">No database reported any keys.</p>
      )}

      {data && data.databases.length > 0 && (
        <div className="flex flex-wrap gap-1 p-2">
          {data.databases.map((entry) => {
            const active = current === entry.index;
            return (
              <button
                key={entry.index}
                type="button"
                disabled={!data.selectable && entry.index !== 0}
                onClick={() => onSelectDb(entry.index)}
                className={cn(
                  'flex min-w-[5.5rem] flex-col items-start gap-0.5 border px-2 py-1 text-left',
                  active
                    ? 'border-[var(--accent)] bg-[var(--selection)]'
                    : 'border-[var(--border)] hover:bg-[var(--bg-hover)]',
                  !data.selectable && entry.index !== 0 && 'opacity-45',
                )}
              >
                <span className="mono text-[11px] text-[var(--fg)]">db{entry.index}</span>
                <span className="text-[10px] tabular-nums text-[var(--fg-muted)]">{formatCount(entry.keys)} keys</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function GroupCard({ group, values }: { group: GroupSpec; values: Record<string, string> }) {
  const tiles = group.tiles.filter((tile) => values[tile.field] !== undefined);
  if (tiles.length === 0) return null;

  return (
    <section className="surface">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">{group.title}</h3>
      </header>
      <div className="grid grid-cols-2 gap-px bg-[var(--border)] sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((tile) => (
          <Tile key={tile.field} tile={tile} raw={values[tile.field]} />
        ))}
      </div>
      <RawSection title={`all ${group.section} fields`} values={values} defaultOpen={false} nested />
    </section>
  );
}

function Tile({ tile, raw }: { tile: TileSpec; raw: string }) {
  const warn = tile.warnWhen?.(raw) ?? false;
  return (
    <div className="bg-[var(--bg-panel)] px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]">{tile.label}</p>
      <p
        className={cn(
          'mono truncate text-[13px] tabular-nums',
          warn ? 'text-[var(--warn)]' : 'text-[var(--fg)]',
        )}
        title={raw}
      >
        {formatTile(raw, tile.format)}
      </p>
    </div>
  );
}

function formatTile(raw: string, format: TileFormat): string {
  const numeric = Number(raw);
  switch (format) {
    case 'bytes':
      return Number.isFinite(numeric) ? formatBytes(numeric) : raw;
    case 'limit':
      // maxmemory 0 means "no limit", not "no memory" — a distinction only the
      // limit fields make, which is why it is not folded into 'bytes'.
      if (!Number.isFinite(numeric)) return raw;
      return numeric === 0 ? 'unlimited' : formatBytes(numeric);
    case 'number':
      return Number.isFinite(numeric) ? formatCount(numeric) : raw;
    case 'seconds':
      return Number.isFinite(numeric) ? formatDurationMs(numeric * 1000) : raw;
    case 'epoch':
      if (!Number.isFinite(numeric) || numeric <= 0) return 'never';
      return `${formatDurationMs(Date.now() - numeric * 1000)} ago`;
    case 'ratio':
      return Number.isFinite(numeric) ? numeric.toFixed(2) : raw;
    case 'bool':
      return raw === '1' ? 'yes' : raw === '0' ? 'no' : raw;
    case 'status':
    case 'text':
    default:
      return raw;
  }
}

function ratioOf(hits: string | undefined, misses: string | undefined): number | null {
  const h = Number(hits);
  const m = Number(misses);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h + m === 0) return null;
  return h / (h + m);
}

// ---------------------------------------------------------------------------
// Raw section tables
// ---------------------------------------------------------------------------

function RawSection({
  title,
  values,
  defaultOpen,
  nested,
}: {
  title: string;
  values: Record<string, string>;
  defaultOpen: boolean;
  nested?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const entries = Object.entries(values);
  if (entries.length === 0) return null;

  return (
    <div className={nested ? 'border-t border-[var(--border)]' : 'surface'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="uppercase tracking-wide">{title}</span>
        <span className="ml-auto tabular-nums text-[var(--fg-subtle)]">{entries.length}</span>
      </button>
      {open && (
        <table className="w-full text-xs">
          <tbody>
            {entries.map(([field, value]) => (
              <tr key={field} className="border-t border-[var(--border)] even:bg-[var(--row-alt)]">
                <td className="mono w-1/2 px-2 py-0.5 text-[var(--fg-muted)]">{field}</td>
                <td className="mono break-all px-2 py-0.5 text-[var(--fg)]">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
