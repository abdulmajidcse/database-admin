'use client';

/**
 * Native dump/restore tools (PLAN §7.2 "still probe PATH at startup and record
 * versions", §10.1 "the image bakes every tool in").
 *
 * Because we ship in Docker, the normal state of this panel is "everything
 * present, with versions" — so a missing binary is worth saying loudly, while
 * being clear that it is not fatal: the built-in streaming engine covers every
 * export, it just cannot reproduce definers, collations and partitions with the
 * fidelity of `mysqldump`/`pg_dump`.
 */

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, TriangleAlert, Wrench } from 'lucide-react';
import { api } from '@/lib/api-client';
import type { NativeToolsResponse } from '@/lib/api-types';
import type { EngineKind } from '@/lib/schema-model';
import { Badge, Button, EmptyState, ErrorBox, Spinner, Toolbar, cn } from '@/components/ui/primitives';

export type NativeTool = NativeToolsResponse['tools'][number];

export const NATIVE_TOOLS_QUERY_KEY = ['native-tools'] as const;

/**
 * Mirrors ENGINE_TOOLS in server/transfer/native/detect.ts. Duplicated rather
 * than imported because that module spawns child processes and reads the
 * filesystem — it cannot cross into the browser bundle. §7.5: SQLite's best
 * export is the online backup API, so `sqlite3` is genuinely optional there.
 */
export const ENGINE_TOOLS: Record<EngineKind, { dump: string[]; restore: string[] }> = {
  mysql: { dump: ['mysqldump'], restore: ['mysql'] },
  mariadb: { dump: ['mysqldump'], restore: ['mysql'] },
  postgres: { dump: ['pg_dump', 'pg_dumpall'], restore: ['pg_restore', 'psql'] },
  sqlite: { dump: [], restore: [] },
  redis: { dump: ['redis-cli'], restore: [] },
  mongodb: { dump: ['mongodump'], restore: ['mongorestore'] },
};

export function useNativeTools(enabled = true) {
  return useQuery<NativeToolsResponse>({
    queryKey: NATIVE_TOOLS_QUERY_KEY,
    queryFn: () => api.get<NativeToolsResponse>('/api/native-tools'),
    enabled,
    // Detection is cached server-side and only changes when a binary is
    // installed, which the refresh button handles explicitly.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function toolByName(tools: NativeTool[] | undefined, name: string): NativeTool | undefined {
  return tools?.find((t) => t.name === name);
}

/** Which of the binaries this engine's native dump path needs are absent. */
export function missingDumpTools(engine: EngineKind | null | undefined, tools: NativeTool[] | undefined): string[] {
  if (!engine || !tools) return [];
  // pg_dumpall only matters for a whole-server dump, so a missing one is not
  // enough on its own to call the native path unavailable.
  const required = ENGINE_TOOLS[engine].dump.filter((n) => n !== 'pg_dumpall');
  return required.filter((name) => (toolByName(tools, name)?.path ?? null) === null);
}

export interface NativeToolsPanelProps {
  /** Highlight (and check) only the binaries this engine needs. */
  engine?: EngineKind | null;
  /** One-line summary for an dialog's advanced section instead of the table. */
  compact?: boolean;
  className?: string;
}

export function NativeToolsPanel({ engine, compact, className }: NativeToolsPanelProps) {
  const client = useQueryClient();
  const query = useNativeTools();
  const [refreshing, setRefreshing] = React.useState(false);

  const rescan = React.useCallback(async () => {
    setRefreshing(true);
    try {
      // ?refresh=1 re-probes PATH — for a tool installed after startup.
      const fresh = await api.get<NativeToolsResponse>('/api/native-tools?refresh=1');
      client.setQueryData(NATIVE_TOOLS_QUERY_KEY, fresh);
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  const tools = query.data?.tools;
  // With an engine the question is "can this engine's native dump run?"; without
  // one it is "is anything missing at all?" — and in the image the answer to
  // both should be no (§10.1), so either way a gap is worth naming.
  const missing = React.useMemo(
    () => (engine ? missingDumpTools(engine, tools) : (tools ?? []).filter((t) => t.path === null).map((t) => t.name)),
    [engine, tools],
  );
  const relevant = React.useMemo(() => {
    if (!tools) return [];
    if (!engine) return tools;
    const wanted = new Set([...ENGINE_TOOLS[engine].dump, ...ENGINE_TOOLS[engine].restore]);
    // Versioned Postgres clients arrive as "pg_dump (16)" and are the reason the
    // §7.2 version rule is satisfiable, so keep them next to their base binary.
    return tools.filter((t) => wanted.has(t.name) || [...wanted].some((w) => t.name.startsWith(`${w} (`)));
  }, [engine, tools]);

  if (compact) {
    return (
      <div className={cn('flex items-center gap-2 text-[11px] text-[var(--fg-muted)]', className)}>
        {query.isPending && <Spinner className="size-3" />}
        {query.error && <span className="text-[var(--danger)]">Tool detection failed.</span>}
        {tools && missing.length === 0 && (
          <span className="flex items-center gap-1">
            <Check className="size-3 text-[var(--ok)]" />
            {relevant
              .filter((t) => t.path !== null)
              .slice(0, 3)
              .map((t) => `${t.name}${t.version ? ` ${shortVersion(t.version)}` : ''}`)
              .join(' · ') || 'no native tool needed for this engine'}
          </span>
        )}
        {tools && missing.length > 0 && (
          <span className="flex items-center gap-1 text-[var(--warn)]">
            <TriangleAlert className="size-3" />
            {missing.join(', ')} not found — the built-in engine will be used instead.
          </span>
        )}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          loading={refreshing}
          icon={<RefreshCw className="size-3" />}
          onClick={() => void rescan()}
        >
          Rescan
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full flex-col overflow-hidden', className)}>
      <Toolbar>
        <Wrench className="size-3.5 text-[var(--fg-subtle)]" />
        <span className="text-xs font-medium">Native tools</span>
        {engine && <Badge tone="accent">{engine}</Badge>}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          loading={refreshing}
          icon={<RefreshCw className="size-3" />}
          onClick={() => void rescan()}
        >
          Rescan PATH
        </Button>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto">
        {query.isPending && (
          <div className="flex items-center gap-2 p-3 text-xs text-[var(--fg-muted)]">
            <Spinner /> Probing PATH…
          </div>
        )}

        {query.error && (
          <div className="p-3">
            <ErrorBox
              title="Could not read the tool list"
              message={query.error instanceof Error ? query.error.message : 'Unknown error'}
            />
          </div>
        )}

        {tools && tools.length === 0 && (
          <EmptyState
            icon={<Wrench className="size-5" />}
            title="No native tools detected"
            description="Exports and imports still work: the built-in streaming engine covers every format, it just cannot match mysqldump/pg_dump on definers, collations and partitions."
          />
        )}

        {relevant.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--grid-header)] text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Tool</th>
                <th className="px-2 py-1 text-left font-medium">Path</th>
                <th className="px-2 py-1 text-left font-medium">Version</th>
                <th className="px-2 py-1 text-right font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {relevant.map((tool) => (
                <tr key={tool.name} className="border-b border-[var(--border)] last:border-0 even:bg-[var(--row-alt)]">
                  <td className="mono px-2 py-1">{tool.name}</td>
                  <td className="mono max-w-[22rem] truncate px-2 py-1 text-[var(--fg-muted)]" title={tool.path ?? ''}>
                    {tool.path ?? '—'}
                  </td>
                  <td className="px-2 py-1 text-[var(--fg-muted)]">{tool.version ?? '—'}</td>
                  <td className="px-2 py-1 text-right">
                    {tool.path ? <Badge tone="ok">present</Badge> : <Badge tone="warn">missing</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tools && (
          <div className="flex flex-col gap-2 p-2">
            {missing.length > 0 && (
              <div className="flex items-start gap-2 border border-[var(--warn)]/40 bg-[var(--warn-bg)] p-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--warn)]" />
                <p className="text-[11px] leading-snug text-[var(--fg)]">
                  <span className="font-medium">{missing.join(', ')}</span> {missing.length > 1 ? 'are' : 'is'} not on
                  PATH. The container image bundles every dump tool, so this almost always means the app is running
                  outside the container. Exports still run on the built-in streaming engine — only the &ldquo;use the
                  bundled native tool&rdquo; option is unavailable.
                </p>
              </div>
            )}
            <p className="text-[11px] leading-snug text-[var(--fg-subtle)]">
              Full-database dumps prefer the native tool when one is present; everything else (filtered exports, format
              conversion, cross-engine copy) uses the built-in engine. pg_dump must be at least the server&apos;s major
              version, which is why several Postgres client majors are shipped.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** `psql (PostgreSQL) 16.3` → `16.3`; anything unparsed is shown verbatim. */
function shortVersion(version: string): string {
  const match = /(\d+(?:\.\d+)*)/.exec(version);
  return match ? match[1] : version;
}
