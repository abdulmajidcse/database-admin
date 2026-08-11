'use client';

/**
 * Read-only DDL for one database object (PLAN §1 "Open DDL", M3).
 *
 * The tree's context menu already knows how to turn a node into SQL — view
 * bodies, routine sources and enum values are in the canonical model, and a real
 * table goes through /api/ddl/plan with `current: null`, which is exactly
 * "create this table". This component is the surface for that text: highlighted,
 * selectable, searchable, copyable, downloadable, and one click from the SQL
 * editor.
 *
 * When the caller has no SQL yet it can hand over a `load` function, or nothing
 * at all — for a table or a view the component resolves the DDL itself from the
 * shared schema query, so it never has to be fed to be useful.
 */

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, Download, FileCode, RefreshCw, SquareArrowOutUpRight, WrapText } from 'lucide-react';

import { api } from '@/lib/api-client';
import type { DdlResponse } from '@/lib/api-types';
import type { EngineKind } from '@/lib/schema-model';
import { findTable } from '@/lib/schema-model';
import { quoteQualified } from '@/server/db/sql/quote';
import { fetchSchema } from '@/hooks/use-schema';
import { useWorkspaceStore } from '@/state/workspace-store';
import { Badge, Button, Dialog, ErrorBox, Spinner, Toolbar, cn } from '@/components/ui/primitives';
import { SqlView, scriptFrom } from './ddl-preview';

export interface DdlObjectRef {
  /** `table`, `view`, `materialized view`, `routine`, `index`, `trigger`, … */
  kind: string;
  schema?: string;
  name: string;
  /** Owning table, for an index / trigger / foreign key. */
  table?: string;
}

export function qualifiedLabel(object: DdlObjectRef): string {
  return object.schema ? `${object.schema}.${object.name}` : object.name;
}

export interface ObjectDdlViewProps {
  connectionId: string;
  engine: EngineKind | null;
  object: DdlObjectRef;
  /** DDL the caller already has (what the tree's "Open DDL" produces). */
  sql?: string;
  /** Produce the DDL on demand. Ignored when `sql` is given. */
  load?: () => Promise<string>;
  className?: string;
}

export function ObjectDdlView({ connectionId, engine, object, sql, load, className }: ObjectDdlViewProps) {
  const queryClient = useQueryClient();
  const [wrap, setWrap] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const resolve = React.useCallback(async (): Promise<string> => {
    if (load) return load();

    // The fallback path: only the model-backed kinds, because everything else
    // arrives pre-rendered from the caller that knows the node's `meta`.
    const kind = object.kind.toLowerCase();
    if (!['table', 'view', 'materialized view', 'materialized_view'].includes(kind)) {
      throw new Error(`Nothing supplied the DDL for this ${object.kind}.`);
    }

    const { model } = await fetchSchema(queryClient, connectionId);
    const table = findTable(model, object.schema, object.table ?? object.name);
    if (!table) {
      throw new Error(`${qualifiedLabel(object)} is not in the introspected schema — refresh and try again.`);
    }

    if ((table.kind === 'view' || table.kind === 'materialized_view') && table.definition) {
      const keyword = table.kind === 'view' ? 'VIEW' : 'MATERIALIZED VIEW';
      const target = quoteQualified([table.schema, table.name], model.engine);
      return `CREATE ${keyword} ${target} AS\n${table.definition.trim().replace(/;$/, '')};\n`;
    }

    // §9: identifiers we build go through the server's generator, never a
    // client-side concatenation — so a table's DDL is a plan with no `current`.
    const plan = await api.post<DdlResponse>('/api/ddl/plan', {
      connectionId,
      current: null,
      desired: table,
    });
    return scriptFrom(plan.statements);
  }, [connectionId, load, object, queryClient]);

  const query = useQuery<string>({
    queryKey: ['object-ddl', connectionId, object.kind, object.schema ?? '', object.table ?? '', object.name],
    queryFn: resolve,
    // A caller-supplied string needs no request at all.
    enabled: sql === undefined,
    retry: false,
    staleTime: 60_000,
  });

  const text = sql ?? query.data ?? '';
  const error = sql === undefined && query.error instanceof Error ? query.error.message : null;
  // A disabled query reports status 'pending' forever in TanStack v5, so the
  // spinner keys off actual fetching rather than off `isPending`.
  const loading = sql === undefined && query.isFetching;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error('The browser refused clipboard access.');
    }
  }

  /** Client-side save: the text is already here, so nothing goes to the server. */
  function download(): void {
    const filename = `${qualifiedLabel(object).replace(/[^\w.-]+/g, '_') || 'object'}.sql`;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/sql;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function openInEditor(): void {
    useWorkspaceStore.getState().openTab({
      kind: 'sql',
      title: `DDL: ${object.name}`,
      key: `ddl:${object.kind}:${qualifiedLabel(object)}`,
      connectionId,
      state: { sql: text, schema: object.schema },
    });
  }

  const lines = text === '' ? 0 : text.split('\n').length;

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <Toolbar>
        <FileCode className="size-3.5 text-[var(--fg-subtle)]" />
        <span className="mono text-[12px]">{qualifiedLabel(object)}</span>
        <Badge>{object.kind}</Badge>
        {loading && <Spinner className="size-3" />}
        {lines > 0 && <span className="text-[11px] text-[var(--fg-subtle)]">{lines} lines</span>}

        <span className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            icon={<WrapText className="size-3.5" />}
            onClick={() => setWrap((w) => !w)}
            title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
            className={cn(wrap && 'text-[var(--accent)]')}
          />
          {sql === undefined && (
            <Button
              size="xs"
              variant="ghost"
              icon={<RefreshCw className="size-3.5" />}
              onClick={() => void query.refetch()}
              title="Read the object again"
            />
          )}
          <Button
            size="xs"
            variant="ghost"
            icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            disabled={text === ''}
            onClick={() => void copy()}
            title="Copy the DDL"
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={<Download className="size-3.5" />}
            disabled={text === ''}
            onClick={download}
            title="Save as .sql"
          />
          <Button
            size="xs"
            variant="ghost"
            icon={<SquareArrowOutUpRight className="size-3.5" />}
            disabled={text === ''}
            onClick={openInEditor}
            title="Open in a SQL tab"
          >
            Edit
          </Button>
        </span>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <div className="p-3">
            <ErrorBox title="No DDL for this object" message={error} />
          </div>
        ) : text === '' && loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <SqlView sql={text} engine={engine} wrap={wrap} />
        )}
      </div>
    </div>
  );
}

export interface ObjectDdlDialogProps extends ObjectDdlViewProps {
  open: boolean;
  onClose: () => void;
}

export function ObjectDdlDialog({ open, onClose, ...props }: ObjectDdlDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`DDL · ${qualifiedLabel(props.object)}`}
      width="xl"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="h-[62vh] min-h-0 overflow-hidden rounded border border-[var(--border)]">
        <ObjectDdlView {...props} />
      </div>
    </Dialog>
  );
}
