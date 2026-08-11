'use client';

/**
 * Schema compare + migration review (PLAN M8, gated by §9).
 *
 * Pick a reference (source) and a target, POST /api/compare, then review what
 * the differ found and what the generator wants to run. Direction is fixed by
 * the server and repeated everywhere in this UI because it is the one thing
 * people get wrong: **source is the schema you like, target is the database
 * that would be changed**. So `added` means "the script creates it on the
 * target" and `removed` means "the script would drop it from the target".
 *
 * `CompareResponse.diff` is typed `unknown` in the contract, so it is validated
 * here rather than trusted — the shapes below mirror `server/db/schema/differ`
 * without importing it, which keeps a server module out of the client bundle.
 *
 * §9: the generated script arrives in two halves. `migration.statements` is the
 * safe half; `migration.destructive` drops columns, tables and schemas. The
 * destructive half is always *shown* (you cannot review what you cannot read)
 * but it is never copied, downloaded or executed until the opt-in checkbox is
 * ticked, and running anything at all needs the target connection's name typed
 * into the confirm dialog — which is also what /api/ddl/execute demands back.
 */

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Group, Panel, Separator as PanelSeparator } from 'react-resizable-panels';
import { toast } from 'sonner';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  GitCompare,
  Play,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import type { CompareRequest, CompareResponse } from '@/lib/api-types';
import type { ConnectionConfig } from '@/lib/connection';
import { workspaceModeFor } from '@/lib/connection';
import { useWorkspaceStore } from '@/state/workspace-store';
import { useConnections } from '@/components/shell/connection-sidebar';
import { registerTabView, type TabViewProps } from '@/components/shell/workspace';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Select,
  Spinner,
  Toolbar,
  cn,
} from '@/components/ui/primitives';

// ---------------------------------------------------------------------------
// The diff, as this UI needs it (CompareResponse.diff is `unknown`)
// ---------------------------------------------------------------------------

type DiffStatus = 'added' | 'removed' | 'changed' | 'same';

interface FieldDiff {
  field: string;
  source: string | null;
  target: string | null;
}

interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
}

interface DiffGroup {
  id: string;
  label: string;
  entries: DiffEntry[];
}

interface DiffEntry {
  id: string;
  kind: string;
  name: string;
  /** Namespaces may be named differently on the two sides. */
  sourceName: string | null;
  targetName: string | null;
  status: DiffStatus;
  fields: FieldDiff[];
  groups: DiffGroup[];
}

interface DiffView {
  sourceEngine: string;
  targetEngine: string;
  namespaces: DiffEntry[];
  summary: DiffCounts;
  notes: string[];
}

const STATUS_TONE: Record<DiffStatus, 'ok' | 'danger' | 'warn' | 'neutral'> = {
  added: 'ok',
  removed: 'danger',
  changed: 'warn',
  same: 'neutral',
};

const STATUS_TEXT: Record<DiffStatus, string> = {
  added: 'text-[var(--ok)]',
  removed: 'text-[var(--danger)]',
  changed: 'text-[var(--warn)]',
  same: 'text-[var(--fg-muted)]',
};

/** Child collections of a table/view entry, in review order. */
const CHILD_GROUPS: { key: string; label: string }[] = [
  { key: 'columns', label: 'Columns' },
  { key: 'indexes', label: 'Indexes' },
  { key: 'foreignKeys', label: 'Foreign keys' },
  { key: 'checks', label: 'Checks' },
];

/** Namespace-level collections. */
const NAMESPACE_GROUPS: { key: string; label: string }[] = [
  { key: 'tables', label: 'Tables' },
  { key: 'views', label: 'Views' },
  { key: 'routines', label: 'Routines' },
  { key: 'sequences', label: 'Sequences' },
  { key: 'enums', label: 'Enums' },
  { key: 'triggers', label: 'Triggers' },
];

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readStatus(value: unknown): DiffStatus {
  return value === 'added' || value === 'removed' || value === 'changed' ? value : 'same';
}

function readCounts(value: unknown): DiffCounts {
  const r = rec(value);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { added: n(r?.added), removed: n(r?.removed), changed: n(r?.changed) };
}

function readFields(value: unknown): FieldDiff[] {
  if (!Array.isArray(value)) return [];
  const out: FieldDiff[] = [];
  for (const item of value) {
    const r = rec(item);
    if (!r || typeof r.field !== 'string') continue;
    out.push({ field: r.field, source: nullableStr(r.source), target: nullableStr(r.target) });
  }
  return out;
}

function readEntry(value: unknown, id: string, kindFallback: string, groupSpecs: { key: string; label: string }[]): DiffEntry | null {
  const r = rec(value);
  if (!r || typeof r.name !== 'string') return null;
  const groups: DiffGroup[] = [];
  for (const spec of groupSpecs) {
    const raw = r[spec.key];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const entries: DiffEntry[] = [];
    raw.forEach((child, i) => {
      // Only tables and views nest further; everything else is a leaf.
      const nested = spec.key === 'tables' || spec.key === 'views' ? CHILD_GROUPS : [];
      const entry = readEntry(child, `${id}/${spec.key}/${i}`, spec.key, nested);
      if (entry) entries.push(entry);
    });
    if (entries.length > 0) groups.push({ id: `${id}/${spec.key}`, label: spec.label, entries });
  }
  return {
    id,
    kind: str(r.kind, kindFallback),
    name: r.name,
    sourceName: nullableStr(r.sourceName),
    targetName: nullableStr(r.targetName),
    status: readStatus(r.status),
    fields: readFields(r.fields),
    groups,
  };
}

function normalizeDiff(value: unknown): DiffView | null {
  const r = rec(value);
  if (!r || !Array.isArray(r.namespaces)) return null;
  const namespaces: DiffEntry[] = [];
  r.namespaces.forEach((ns, i) => {
    const entry = readEntry(ns, `ns/${i}`, 'namespace', NAMESPACE_GROUPS);
    if (entry) namespaces.push(entry);
  });
  return {
    sourceEngine: str(r.sourceEngine, 'unknown'),
    targetEngine: str(r.targetEngine, 'unknown'),
    namespaces,
    summary: readCounts(r.summary),
    notes: Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === 'string') : [],
  };
}

// ---------------------------------------------------------------------------
// /api/ddl/execute — the same shape the route documents, declared locally so
// this client component never imports a route module.
// ---------------------------------------------------------------------------

interface ExecuteOutcome {
  index: number;
  statement: string;
  status: 'ok' | 'error' | 'skipped';
  durationMs: number;
  destructive: boolean;
  error?: { message: string; code?: string; detail?: string };
}

interface ExecuteResponse {
  executed: boolean;
  transactional: boolean;
  rolledBack: boolean;
  succeeded: number;
  durationMs: number;
  statements: ExecuteOutcome[];
  warnings: string[];
  requiresConfirmation?: { phrase: string; reasons: string[] };
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface CompareOptionsState {
  ignoreCase: boolean;
  ignoreCollation: boolean;
  ignoreComments: boolean;
  ignoreIndexNames: boolean;
}

const DEFAULT_OPTIONS: CompareOptionsState = {
  ignoreCase: false,
  ignoreCollation: false,
  ignoreComments: false,
  ignoreIndexNames: false,
};

export interface SchemaCompareProps {
  sourceConnectionId?: string | null;
  targetConnectionId?: string | null;
  sourceSchemas?: string;
  targetSchemas?: string;
  /** Called when the user changes a setting, so a tab can persist it. */
  onSettingsChange?: (settings: Record<string, unknown>) => void;
  className?: string;
}

export function SchemaCompare({
  sourceConnectionId: initialSource,
  targetConnectionId: initialTarget,
  sourceSchemas: initialSourceSchemas,
  targetSchemas: initialTargetSchemas,
  onSettingsChange,
  className,
}: SchemaCompareProps) {
  const connections = useConnections();
  const queryClient = useQueryClient();

  // Compare is a SQL-engine feature: the migration writer emits DDL.
  const candidates: ConnectionConfig[] = React.useMemo(
    () => (connections.data?.connections ?? []).filter((c) => workspaceModeFor(c.engine) === 'sql'),
    [connections.data],
  );

  const [sourceId, setSourceId] = React.useState(initialSource ?? '');
  const [targetId, setTargetId] = React.useState(initialTarget ?? '');
  const [sourceSchemas, setSourceSchemas] = React.useState(initialSourceSchemas ?? '');
  const [targetSchemas, setTargetSchemas] = React.useState(initialTargetSchemas ?? '');
  const [options, setOptions] = React.useState<CompareOptionsState>(DEFAULT_OPTIONS);

  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [response, setResponse] = React.useState<CompareResponse | null>(null);
  const [diff, setDiff] = React.useState<DiffView | null>(null);

  const [onlyDifferences, setOnlyDifferences] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set<string>());

  const [allowDestructive, setAllowDestructive] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [execution, setExecution] = React.useState<ExecuteResponse | null>(null);
  const [executing, setExecuting] = React.useState(false);

  const source = candidates.find((c) => c.id === sourceId) ?? null;
  const target = candidates.find((c) => c.id === targetId) ?? null;

  const settings = React.useCallback(
    (patch: Record<string, unknown>) => onSettingsChange?.(patch),
    [onSettingsChange],
  );

  const compare = React.useCallback(async () => {
    if (!sourceId || !targetId) return;
    setRunning(true);
    setError(null);
    setExecution(null);
    try {
      const request: CompareRequest = {
        sourceConnectionId: sourceId,
        targetConnectionId: targetId,
        ...(parseSchemas(sourceSchemas) ? { sourceScope: { namespaces: parseSchemas(sourceSchemas) } } : {}),
        ...(parseSchemas(targetSchemas) ? { targetScope: { namespaces: parseSchemas(targetSchemas) } } : {}),
        options,
      };
      const res = await api.post<CompareResponse>('/api/compare', request);
      const view = normalizeDiff(res.diff);
      setResponse(res);
      setDiff(view);
      // Namespaces and their object groups start open; individual objects do not.
      setExpanded(new Set(view ? view.namespaces.flatMap((ns) => [ns.id, ...ns.groups.map((g) => g.id)]) : []));
      // A fresh comparison is a fresh decision about the destructive half.
      setAllowDestructive(false);
    } catch (err) {
      setResponse(null);
      setDiff(null);
      setError(err instanceof Error ? err.message : 'The comparison failed');
    } finally {
      setRunning(false);
    }
  }, [sourceId, targetId, sourceSchemas, targetSchemas, options]);

  const migration = response?.migration ?? null;
  const safeStatements = migration?.statements ?? [];
  const destructiveStatements = migration?.destructive ?? [];
  const statementsToRun = allowDestructive ? [...safeStatements, ...destructiveStatements] : safeStatements;

  const scriptText = React.useMemo(
    () => buildScript(source, target, safeStatements, allowDestructive ? destructiveStatements : []),
    [source, target, safeStatements, destructiveStatements, allowDestructive],
  );

  const run = async (confirmPhrase: string) => {
    if (!target || statementsToRun.length === 0) return;
    setExecuting(true);
    setExecution(null);
    try {
      const res = await api.post<ExecuteResponse>('/api/ddl/execute', {
        connectionId: target.id,
        statements: statementsToRun,
        confirm: confirmPhrase,
      });
      setExecution(res);
      if (res.executed && !res.rolledBack) {
        toast.success(`Applied ${res.succeeded} statement${res.succeeded === 1 ? '' : 's'} to ${target.name}`);
        // The target's shape changed: nothing cached about it is true any more.
        await queryClient.invalidateQueries({ queryKey: ['schema', target.id] });
        await queryClient.invalidateQueries({ queryKey: ['tree', target.id] });
        await compare();
      } else if (res.rolledBack) {
        toast.error('The script failed and was rolled back');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The script could not be run');
    } finally {
      setExecuting(false);
    }
  };

  const copyScript = () => {
    void navigator.clipboard
      .writeText(scriptText)
      .then(() => toast.success(allowDestructive ? 'Script copied, including the destructive half' : 'Script copied'))
      .catch(() => toast.error('The browser refused clipboard access'));
  };

  const downloadScript = () => {
    const blob = new Blob([scriptText], { type: 'application/sql;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `migration-${slug(target?.name ?? 'target')}.sql`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggle = React.useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const canCompare = !!sourceId && !!targetId && !running;

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-[var(--bg)]', className)}>
      <Toolbar className="flex-wrap gap-2 py-1.5">
        <div className="flex items-end gap-2">
          <Field label="Source (reference)" className="w-56">
            <Select
              value={sourceId}
              onChange={(e) => {
                setSourceId(e.target.value);
                settings({ sourceConnectionId: e.target.value });
              }}
            >
              <option value="">Choose a connection…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.engine})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Schemas" className="w-40">
            <Input
              placeholder="all"
              value={sourceSchemas}
              spellCheck={false}
              onChange={(e) => {
                setSourceSchemas(e.target.value);
                settings({ sourceSchemas: e.target.value });
              }}
            />
          </Field>
          <Button
            size="sm"
            variant="ghost"
            className="mb-0.5"
            title="Swap source and target"
            icon={<ArrowLeftRight className="size-3.5" />}
            onClick={() => {
              setSourceId(targetId);
              setTargetId(sourceId);
              setSourceSchemas(targetSchemas);
              setTargetSchemas(sourceSchemas);
              settings({
                sourceConnectionId: targetId,
                targetConnectionId: sourceId,
                sourceSchemas: targetSchemas,
                targetSchemas: sourceSchemas,
              });
            }}
          />
          <Field label="Target (will be changed)" className="w-56">
            <Select
              value={targetId}
              onChange={(e) => {
                setTargetId(e.target.value);
                settings({ targetConnectionId: e.target.value });
              }}
            >
              <option value="">Choose a connection…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.engine})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Schemas" className="w-40">
            <Input
              placeholder="all"
              value={targetSchemas}
              spellCheck={false}
              onChange={(e) => {
                setTargetSchemas(e.target.value);
                settings({ targetSchemas: e.target.value });
              }}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-3">
            <Checkbox
              label="Ignore case"
              className="text-[11px]"
              checked={options.ignoreCase}
              onChange={(e) => setOptions((o) => ({ ...o, ignoreCase: e.target.checked }))}
            />
            <Checkbox
              label="Ignore collation"
              className="text-[11px]"
              checked={options.ignoreCollation}
              onChange={(e) => setOptions((o) => ({ ...o, ignoreCollation: e.target.checked }))}
            />
          </div>
          <div className="flex items-center gap-3">
            <Checkbox
              label="Ignore comments"
              className="text-[11px]"
              checked={options.ignoreComments}
              onChange={(e) => setOptions((o) => ({ ...o, ignoreComments: e.target.checked }))}
            />
            <Checkbox
              label="Ignore index names"
              className="text-[11px]"
              checked={options.ignoreIndexNames}
              onChange={(e) => setOptions((o) => ({ ...o, ignoreIndexNames: e.target.checked }))}
            />
          </div>
        </div>

        <Button
          className="mb-0.5 ml-auto"
          variant="primary"
          size="md"
          loading={running}
          disabled={!canCompare}
          icon={<GitCompare className="size-3.5" />}
          onClick={() => void compare()}
        >
          Compare
        </Button>
      </Toolbar>

      {target?.readOnly && (
        <p className="border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1 text-[11px] text-[var(--fg-muted)]">
          {target.name} is marked read-only, so the script can be copied and downloaded but not run from here.
        </p>
      )}

      {error && (
        <div className="p-2">
          <ErrorBox title="Could not compare these schemas" message={error} />
        </div>
      )}

      {!response && !error && (
        <div className="min-h-0 flex-1">
          {running ? (
            <div className="flex items-center gap-2 p-3 text-xs text-[var(--fg-muted)]">
              <Spinner /> Introspecting both schemas…
            </div>
          ) : (
            <EmptyState
              icon={<GitCompare className="size-5" />}
              title="Compare two schemas"
              description="The source is the schema you want; the target is the database the generated migration would change. Both sides are read through the schema cache, so comparing twice costs nothing."
            />
          )}
        </div>
      )}

      {response && (
        <Group orientation="vertical" className="min-h-0 flex-1">
          <Panel id="diff" minSize="20%" defaultSize="58%" className="min-h-0">
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-2 py-1">
                {diff && (
                  <>
                    <Badge tone="ok">{diff.summary.added} to create</Badge>
                    <Badge tone="warn">{diff.summary.changed} changed</Badge>
                    <Badge tone="danger">{diff.summary.removed} only on target</Badge>
                    <span className="text-[11px] text-[var(--fg-subtle)]">
                      {diff.sourceEngine} → {diff.targetEngine}
                    </span>
                  </>
                )}
                <div className="relative ml-auto w-52">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--fg-subtle)]" />
                  <Input
                    className="h-6 pl-6"
                    placeholder="filter objects"
                    value={search}
                    spellCheck={false}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <Checkbox
                  label="Only differences"
                  className="text-[11px]"
                  checked={onlyDifferences}
                  onChange={(e) => setOnlyDifferences(e.target.checked)}
                />
              </div>

              {diff?.notes.map((note, i) => (
                <p
                  key={i}
                  className="border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1 text-[11px] text-[var(--fg-muted)]"
                >
                  {note}
                </p>
              ))}

              <div className="grid grid-cols-[1fr_7rem_1fr] border-b border-[var(--border)] bg-[var(--grid-header)] px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">
                <span className="truncate">Source · {source?.name ?? '—'}</span>
                <span className="text-center">Status</span>
                <span className="truncate">Target · {target?.name ?? '—'}</span>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                {!diff ? (
                  <p className="p-3 text-xs text-[var(--fg-muted)]">
                    The server returned a diff this build does not recognise; the generated script below is still
                    valid.
                  </p>
                ) : diff.namespaces.length === 0 ? (
                  <EmptyState title="Nothing to compare" description="Neither side reported a namespace." />
                ) : (
                  diff.namespaces.map((ns) => (
                    <EntryRows
                      key={ns.id}
                      entry={ns}
                      depth={0}
                      expanded={expanded}
                      onToggle={toggle}
                      onlyDifferences={onlyDifferences}
                      search={search.trim().toLowerCase()}
                    />
                  ))
                )}
              </div>
            </div>
          </Panel>

          <PanelSeparator className="h-px bg-[var(--border)] transition-colors hover:bg-[var(--accent)] data-[separator]:cursor-row-resize" />

          <Panel id="script" minSize="15%" className="min-h-0">
            <MigrationPanel
              safe={safeStatements}
              destructive={destructiveStatements}
              warnings={migration?.warnings ?? []}
              allowDestructive={allowDestructive}
              onAllowDestructive={setAllowDestructive}
              onCopy={copyScript}
              onDownload={downloadScript}
              onRun={() => setConfirming(true)}
              canRun={!!target && !target.readOnly && statementsToRun.length > 0}
              executing={executing}
              execution={execution}
              targetName={target?.name ?? ''}
            />
          </Panel>
        </Group>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void run(target?.name ?? '')}
        title={`Run the migration against ${target?.name ?? 'the target'}`}
        confirmWord={target?.name}
        message={
          <div className="flex flex-col gap-2">
            <p>
              {statementsToRun.length} statement{statementsToRun.length === 1 ? '' : 's'} will run against{' '}
              <span className="font-medium">{target?.name}</span>
              {target?.envTag === 'prod' && <span className="text-[var(--danger)]"> — this connection is tagged prod</span>}.
            </p>
            {allowDestructive && destructiveStatements.length > 0 && (
              <p className="text-[var(--danger)]">
                {destructiveStatements.length} of them destroy data (dropped columns, tables or schemas). The data they
                remove cannot be recovered from here.
              </p>
            )}
            <p className="text-[var(--fg-muted)]">
              The script runs in one transaction where the engine allows it; MySQL commits each DDL statement as it
              goes, so a failure part-way leaves the earlier ones applied.
            </p>
          </div>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff tree
// ---------------------------------------------------------------------------

/** Does this subtree contain anything worth showing under the current filters? */
function matches(entry: DiffEntry, onlyDifferences: boolean, search: string): boolean {
  const statusOk = !onlyDifferences || entry.status !== 'same';
  const nameOk = search === '' || entry.name.toLowerCase().includes(search);
  if (statusOk && nameOk) return true;
  return entry.groups.some((g) => g.entries.some((e) => matches(e, onlyDifferences, search)));
}

function EntryRows({
  entry,
  depth,
  expanded,
  onToggle,
  onlyDifferences,
  search,
}: {
  entry: DiffEntry;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onlyDifferences: boolean;
  search: string;
}) {
  if (!matches(entry, onlyDifferences, search)) return null;

  const open = expanded.has(entry.id);
  const expandable = entry.fields.length > 0 || entry.groups.length > 0;
  const sourceLabel = entry.status === 'removed' ? null : (entry.sourceName ?? entry.name);
  const targetLabel = entry.status === 'added' ? null : (entry.targetName ?? entry.name);

  return (
    <>
      <div
        onClick={() => expandable && onToggle(entry.id)}
        className={cn(
          'grid grid-cols-[1fr_7rem_1fr] items-center border-b border-[var(--border)] px-2 py-0.5 text-xs',
          expandable && 'cursor-pointer hover:bg-[var(--bg-hover)]',
        )}
      >
        <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 14 }}>
          {expandable ? (
            open ? (
              <ChevronDown className="size-3 shrink-0 text-[var(--fg-subtle)]" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-[var(--fg-subtle)]" />
            )
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className={cn('truncate', sourceLabel ? STATUS_TEXT[entry.status] : 'text-[var(--fg-subtle)]')}>
            {sourceLabel ?? '—'}
          </span>
          {entry.kind !== 'namespace' && (
            <span className="shrink-0 text-[10px] text-[var(--fg-subtle)]">{entry.kind}</span>
          )}
        </span>
        <span className="text-center">
          {entry.status === 'same' ? (
            <span className="text-[10px] text-[var(--fg-subtle)]">same</span>
          ) : (
            <Badge tone={STATUS_TONE[entry.status]}>{entry.status}</Badge>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 14 }}>
          <span className={cn('truncate', targetLabel ? STATUS_TEXT[entry.status] : 'text-[var(--fg-subtle)]')}>
            {targetLabel ?? '—'}
          </span>
        </span>
      </div>

      {open && entry.fields.length > 0 && (
        <div className="border-b border-[var(--border)] bg-[var(--bg-subtle)]">
          {entry.fields.map((f) => (
            <div
              key={f.field}
              className="grid grid-cols-[1fr_7rem_1fr] items-start px-2 py-0.5 text-[11px]"
              style={{ paddingLeft: (depth + 1) * 14 + 8 }}
            >
              <span className="mono truncate text-[var(--fg)]" title={f.source ?? undefined}>
                {f.source ?? <span className="null-cell">not set</span>}
              </span>
              <span className="text-center text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">{f.field}</span>
              <span className="mono truncate text-[var(--fg)]" title={f.target ?? undefined}>
                {f.target ?? <span className="null-cell">not set</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {open &&
        entry.groups.map((group) => {
          const visible = group.entries.filter((e) => matches(e, onlyDifferences, search));
          if (visible.length === 0) return null;
          const groupOpen = expanded.has(group.id);
          return (
            <React.Fragment key={group.id}>
              <div
                onClick={() => onToggle(group.id)}
                className="flex cursor-pointer items-center gap-1 border-b border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
                style={{ paddingLeft: (depth + 1) * 14 + 8 }}
              >
                {groupOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                <span className="font-medium uppercase tracking-wide">{group.label}</span>
                <span className="text-[var(--fg-subtle)]">{visible.length}</span>
              </div>
              {groupOpen &&
                visible.map((child) => (
                  <EntryRows
                    key={child.id}
                    entry={child}
                    depth={depth + 2}
                    expanded={expanded}
                    onToggle={onToggle}
                    onlyDifferences={onlyDifferences}
                    search={search}
                  />
                ))}
            </React.Fragment>
          );
        })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Migration script (§9)
// ---------------------------------------------------------------------------

function MigrationPanel({
  safe,
  destructive,
  warnings,
  allowDestructive,
  onAllowDestructive,
  onCopy,
  onDownload,
  onRun,
  canRun,
  executing,
  execution,
  targetName,
}: {
  safe: string[];
  destructive: string[];
  warnings: string[];
  allowDestructive: boolean;
  onAllowDestructive: (value: boolean) => void;
  onCopy: () => void;
  onDownload: () => void;
  onRun: () => void;
  canRun: boolean;
  executing: boolean;
  execution: ExecuteResponse | null;
  targetName: string;
}) {
  const empty = safe.length === 0 && destructive.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-[var(--border)]">
      <Toolbar>
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">Migration script</span>
        <span className="text-[11px] text-[var(--fg-subtle)]">
          {safe.length} safe · {destructive.length} destructive
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" icon={<Copy className="size-3" />} onClick={onCopy} disabled={empty}>
            Copy
          </Button>
          <Button size="xs" icon={<Download className="size-3" />} onClick={onDownload} disabled={empty}>
            Download
          </Button>
          <Button
            size="xs"
            variant="danger"
            icon={<Play className="size-3" />}
            loading={executing}
            disabled={!canRun}
            onClick={onRun}
            title={canRun ? `Run against ${targetName}` : 'Nothing to run against the target'}
          >
            Run against target
          </Button>
        </div>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto">
        {warnings.length > 0 && (
          <ul className="border-b border-[var(--border)] bg-[var(--warn-bg)] px-3 py-1.5 text-[11px] text-[var(--warn)]">
            {warnings.map((w, i) => (
              <li key={i} className="flex gap-1.5 py-0.5">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}

        {empty ? (
          <EmptyState
            title="No migration needed"
            description="The differ found nothing the target is missing, so there is no DDL to generate."
          />
        ) : (
          <>
            <StatementList title="Safe statements" statements={safe} />

            {destructive.length > 0 && (
              <section className="m-2 border border-[var(--danger)]/50">
                <header className="flex flex-wrap items-center gap-2 border-b border-[var(--danger)]/50 bg-[var(--danger-bg)] px-2 py-1">
                  <TriangleAlert className="size-3.5 text-[var(--danger)]" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--danger)]">
                    Destructive — {destructive.length} statement{destructive.length === 1 ? '' : 's'} that destroy data
                  </span>
                  <Checkbox
                    className="ml-auto text-[11px] text-[var(--danger)]"
                    label="I have read these and want them included"
                    checked={allowDestructive}
                    onChange={(e) => onAllowDestructive(e.target.checked)}
                  />
                </header>
                <ol
                  className={cn(
                    'divide-y divide-[var(--border)]',
                    // Locked until the opt-in: still readable, plainly inert.
                    !allowDestructive && 'opacity-70',
                  )}
                >
                  {destructive.map((s, i) => (
                    <li key={i} className="mono flex gap-2 px-2 py-1 text-[var(--fg)]">
                      <span className="w-6 shrink-0 select-none text-right text-[10px] text-[var(--fg-subtle)]">
                        {i + 1}
                      </span>
                      <span className="whitespace-pre-wrap break-words">{s}</span>
                    </li>
                  ))}
                </ol>
                {!allowDestructive && (
                  <p className="border-t border-[var(--danger)]/50 px-2 py-1 text-[11px] text-[var(--fg-muted)]">
                    These are excluded from Copy, Download and Run until the box above is ticked.
                  </p>
                )}
              </section>
            )}

            {execution && <ExecutionReport execution={execution} />}
          </>
        )}
      </div>
    </div>
  );
}

function StatementList({ title, statements }: { title: string; statements: string[] }) {
  if (statements.length === 0) return null;
  return (
    <section className="m-2 border border-[var(--border)]">
      <header className="border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">
        {title} · {statements.length}
      </header>
      <ol className="divide-y divide-[var(--border)]">
        {statements.map((s, i) => (
          <li key={i} className="mono flex gap-2 px-2 py-1 text-[var(--fg)]">
            <span className="w-6 shrink-0 select-none text-right text-[10px] text-[var(--fg-subtle)]">{i + 1}</span>
            <span className="whitespace-pre-wrap break-words">{s}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ExecutionReport({ execution }: { execution: ExecuteResponse }) {
  const failed = execution.statements.filter((s) => s.status === 'error');
  return (
    <section className="m-2 border border-[var(--border)]">
      <header
        className={cn(
          'flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-2 py-1 text-[11px]',
          execution.rolledBack || !execution.executed ? 'bg-[var(--danger-bg)]' : 'bg-[var(--ok-bg)]',
        )}
      >
        <span className="font-semibold uppercase tracking-wide">
          {!execution.executed ? 'Withheld' : execution.rolledBack ? 'Rolled back' : 'Applied'}
        </span>
        <span className="text-[var(--fg-muted)]">
          {execution.succeeded}/{execution.statements.length} statements · {Math.round(execution.durationMs)} ms
          {execution.transactional ? ' · one transaction' : ''}
        </span>
      </header>
      <div className="flex flex-col gap-1 p-2">
        {execution.requiresConfirmation && (
          <ErrorBox
            title="The server asked for confirmation again"
            message={execution.requiresConfirmation.reasons.join('\n')}
            hint={`Nothing ran. Re-run and type "${execution.requiresConfirmation.phrase}" exactly.`}
          />
        )}
        {failed.map((s) => (
          <ErrorBox
            key={s.index}
            title={`Statement ${s.index + 1} failed`}
            message={`${s.statement}\n\n${s.error?.message ?? 'unknown error'}`}
            hint={s.error?.detail}
          />
        ))}
        {execution.warnings.map((w, i) => (
          <p key={i} className="text-[11px] text-[var(--warn)]">
            {w}
          </p>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSchemas(value: string): string[] | undefined {
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return list.length > 0 ? list : undefined;
}

/** The downloadable/copyable artefact — a plain .sql file with a provenance header. */
function buildScript(
  source: ConnectionConfig | null,
  target: ConnectionConfig | null,
  safe: string[],
  destructive: string[],
): string {
  const lines: string[] = [
    `-- Migration generated by comparing ${source?.name ?? 'source'} (${source?.engine ?? '?'})`,
    `-- against ${target?.name ?? 'target'} (${target?.engine ?? '?'}) on ${new Date().toISOString()}`,
    `-- It runs against ${target?.name ?? 'the target'}. Review every statement before you do.`,
    '',
  ];
  for (const s of safe) lines.push(terminate(s), '');
  if (destructive.length > 0) {
    lines.push(
      '-- ---------------------------------------------------------------------',
      '-- DESTRUCTIVE: the statements below drop objects and the data inside them.',
      '-- ---------------------------------------------------------------------',
      '',
    );
    for (const s of destructive) lines.push(terminate(s), '');
  }
  return lines.join('\n');
}

function terminate(statement: string): string {
  const text = statement.trim();
  return text.endsWith(';') ? text : `${text};`;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'target';
}

// ---------------------------------------------------------------------------
// Tab view
// ---------------------------------------------------------------------------

interface CompareTabState {
  sourceConnectionId?: string;
  targetConnectionId?: string;
  sourceSchemas?: string;
  targetSchemas?: string;
}

function readTabState(state: Record<string, unknown>): CompareTabState {
  return {
    sourceConnectionId: typeof state.sourceConnectionId === 'string' ? state.sourceConnectionId : undefined,
    targetConnectionId: typeof state.targetConnectionId === 'string' ? state.targetConnectionId : undefined,
    sourceSchemas: typeof state.sourceSchemas === 'string' ? state.sourceSchemas : undefined,
    targetSchemas: typeof state.targetSchemas === 'string' ? state.targetSchemas : undefined,
  };
}

export function SchemaCompareTab({ tab }: TabViewProps) {
  const saved = readTabState(tab.state);
  const setTabState = useWorkspaceStore((s) => s.setTabState);
  return (
    <SchemaCompare
      // Remount when the tab is pointed elsewhere, so the form matches the tab.
      key={tab.id}
      sourceConnectionId={saved.sourceConnectionId ?? tab.connectionId}
      targetConnectionId={saved.targetConnectionId}
      sourceSchemas={saved.sourceSchemas}
      targetSchemas={saved.targetSchemas}
      onSettingsChange={(patch) => setTabState(tab.id, patch)}
    />
  );
}

/** Open (or focus) the schema compare tab. */
export function openCompareTab(sourceConnectionId?: string | null): string {
  return useWorkspaceStore.getState().openTab({
    kind: 'compare',
    title: 'Schema compare',
    key: 'compare',
    connectionId: sourceConnectionId ?? null,
    state: sourceConnectionId ? { sourceConnectionId } : {},
  });
}

// The shell imports nothing from feature modules; each attaches itself.
registerTabView('compare', SchemaCompareTab);

export default SchemaCompare;
