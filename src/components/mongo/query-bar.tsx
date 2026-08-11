'use client';

/**
 * The find bar of the MongoDB workspace (PLAN M5), plus the three small pieces
 * every Mongo pane shares: the JSON editor, the explain dialog and two
 * formatters. They live in this leaf module — it imports none of the other
 * Mongo files — so the browser, the document view, the pipeline builder and the
 * index pane can all use them without importing each other.
 *
 * The filter is edited as text and sent as text. `POST /api/mongo/find` parses
 * it with `EJSON.parse` server-side (PLAN §6 "Type fidelity"), which is what
 * makes `{"_id": {"$oid": "…"}}` arrive as a real ObjectId. Nothing here
 * concatenates a query or evaluates user input: the only thing this module does
 * with the text is check that it parses as JSON, so a typo is a message under
 * the editor instead of a 400 from the server.
 */

import * as React from 'react';
import { json } from '@codemirror/lang-json';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import CodeMirror, { type BasicSetupOptions } from '@uiw/react-codemirror';
import { Gauge, Hash, Play, Sigma } from 'lucide-react';
import { api } from '../../lib/api-client';
import type { TableCountResponse } from '../../lib/api-types';
import type { ExplainNode, ExplainPlan } from '../../lib/results';
import { Badge, Button, Dialog, ErrorBox, Input, Spinner, cn } from '../ui/primitives';
import { useTheme } from '../shell/theme';

// ---------------------------------------------------------------------------
// Shared formatters
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function formatCount(count: number | undefined): string {
  return count === undefined ? '—' : count.toLocaleString();
}

// ---------------------------------------------------------------------------
// JSON editor
// ---------------------------------------------------------------------------

const BASE_SETUP: BasicSetupOptions = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  searchKeymap: false,
  lintKeymap: false,
  // Nothing here knows the collection's fields, so a completion popup would
  // only ever suggest JSON punctuation — off is less noise.
  autocompletion: false,
  closeBrackets: true,
  bracketMatching: true,
  indentOnInput: true,
  tabSize: 2,
};

export interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Pixel height of the box. The pane owns layout; CodeMirror fills what it is given. */
  height?: number;
  placeholder?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  lineNumbers?: boolean;
  /** Cmd/Ctrl+Enter inside the editor. */
  onSubmit?: () => void;
  className?: string;
}

/**
 * A compact CodeMirror bound to `@codemirror/lang-json`. Extended JSON *is*
 * JSON, so the JSON grammar highlights and bracket-matches it correctly.
 */
export function JsonEditor({
  value,
  onChange,
  height = 96,
  placeholder,
  readOnly,
  autoFocus,
  lineNumbers = false,
  onSubmit,
  className,
}: JsonEditorProps) {
  const { resolved } = useTheme();

  // The submit handler is read through a ref so a new closure on every render
  // does not tear down and rebuild the editor's extensions.
  const submitRef = React.useRef(onSubmit);
  React.useEffect(() => {
    submitRef.current = onSubmit;
  }, [onSubmit]);

  const extensions = React.useMemo(
    () => [
      json(),
      EditorView.lineWrapping,
      // Highest precedence: the default keymap binds Mod-Enter to
      // "insert blank line", which would otherwise swallow Run.
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              const submit = submitRef.current;
              if (!submit) return false;
              submit();
              return true;
            },
          },
        ]),
      ),
    ],
    [],
  );

  const setup = React.useMemo<BasicSetupOptions>(() => ({ ...BASE_SETUP, lineNumbers }), [lineNumbers]);

  return (
    <div
      className={cn('overflow-hidden border border-[var(--border)] bg-[var(--bg)]', className)}
      style={{ height }}
    >
      <CodeMirror
        className="h-full text-[12px]"
        height="100%"
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme={resolved === 'dark' ? githubDark : githubLight}
        basicSetup={setup}
        placeholder={placeholder}
        readOnly={readOnly}
        autoFocus={autoFocus}
        indentWithTab={false}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON text helpers
// ---------------------------------------------------------------------------

/**
 * Validate a JSON *object* literal without executing it. Returns null when the
 * text is acceptable (empty counts as `{}`), otherwise the message to show.
 */
export function validateJsonObject(text: string, label: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (err) {
    return `${label}: ${(err as Error).message}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `${label} must be a JSON object, e.g. {"status": "active"}.`;
  }
  return null;
}

/** Re-indent JSON text, leaving it untouched when it does not parse. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Find parameters
// ---------------------------------------------------------------------------

export interface FindParams {
  /** Extended JSON text. */
  filter: string;
  projection: string;
  sort: string;
  limit: number;
  skip: number;
}

export const DEFAULT_FIND_PARAMS: FindParams = {
  filter: '{}',
  projection: '',
  sort: '',
  limit: 50,
  skip: 0,
};

export interface QueryBarProps {
  connectionId: string;
  database: string;
  collection: string;
  params: FindParams;
  onChange: (params: FindParams) => void;
  onRun: () => void;
  running: boolean;
  /** Error from the last run, owned by the workspace. */
  error?: string | null;
}

export function QueryBar({
  connectionId,
  database,
  collection,
  params,
  onChange,
  onRun,
  running,
  error,
}: QueryBarProps) {
  const [count, setCount] = React.useState<TableCountResponse | null>(null);
  const [counting, setCounting] = React.useState(false);
  const [countError, setCountError] = React.useState<string | null>(null);
  const [explainOpen, setExplainOpen] = React.useState(false);

  const filterError = validateJsonObject(params.filter, 'Filter');
  const projectionError = validateJsonObject(params.projection, 'Projection');
  const sortError = validateJsonObject(params.sort, 'Sort');
  const inputError = filterError ?? projectionError ?? sortError;

  // A count belongs to the filter it was measured with.
  React.useEffect(() => {
    setCount(null);
    setCountError(null);
  }, [connectionId, database, collection, params.filter]);

  const patch = (values: Partial<FindParams>) => onChange({ ...params, ...values });

  const run = React.useCallback(() => {
    if (validateJsonObject(params.filter, 'Filter')) return;
    onRun();
  }, [onRun, params.filter]);

  async function runCount(): Promise<void> {
    setCounting(true);
    setCountError(null);
    try {
      const query = new URLSearchParams({ connectionId, database, collection, filter: params.filter.trim() || '{}' });
      setCount(await api.get<TableCountResponse>(`/api/mongo/count?${query.toString()}`));
    } catch (err) {
      setCountError(err instanceof Error ? err.message : 'Count failed');
    } finally {
      setCounting(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1.5">
      <div className="flex items-start gap-1.5">
        <div className="flex w-14 shrink-0 flex-col pt-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">Filter</span>
          <span className="mono text-[10px] text-[var(--fg-subtle)]">EJSON</span>
        </div>
        <JsonEditor
          className="flex-1"
          height={72}
          value={params.filter}
          onChange={(filter) => patch({ filter })}
          onSubmit={run}
          placeholder='{ "status": "active", "_id": { "$oid": "…" } }'
        />
        <div className="flex w-24 shrink-0 flex-col gap-1">
          <Button
            variant="primary"
            size="sm"
            icon={<Play className="size-3.5" />}
            onClick={run}
            loading={running}
            disabled={!!filterError}
            title="Run find (⌘↵)"
          >
            Run
          </Button>
          <Button
            size="sm"
            icon={<Sigma className="size-3.5" />}
            onClick={() => void runCount()}
            loading={counting}
            disabled={!!filterError}
            title="Count matching documents"
          >
            Count
          </Button>
          <Button
            size="sm"
            icon={<Gauge className="size-3.5" />}
            onClick={() => setExplainOpen(true)}
            disabled={!!inputError}
            title="Explain this find (executionStats)"
          >
            Explain
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <LabelledInput
          label="Projection"
          className="min-w-[10rem] flex-1"
          value={params.projection}
          onChange={(projection) => patch({ projection })}
          placeholder='{ "name": 1, "_id": 0 }'
          invalid={!!projectionError}
        />
        <LabelledInput
          label="Sort"
          className="min-w-[9rem] flex-1"
          value={params.sort}
          onChange={(sort) => patch({ sort })}
          placeholder='{ "createdAt": -1 }'
          invalid={!!sortError}
        />
        <LabelledNumber
          label="Limit"
          value={params.limit}
          min={1}
          max={10000}
          onChange={(limit) => patch({ limit })}
        />
        <LabelledNumber label="Skip" value={params.skip} min={0} onChange={(skip) => patch({ skip })} />
        {count && (
          <span className="ml-1 flex items-center gap-1 text-[11px] text-[var(--fg-muted)]">
            <Hash className="size-3" />
            {/* PLAN §8.3: an unfiltered count reads collection metadata and is
                therefore an estimate; a filtered one is exact but costs a scan. */}
            {count.estimated ? '~' : ''}
            {formatCount(count.count)} documents
            {count.estimated && <Badge>estimated</Badge>}
          </span>
        )}
      </div>

      {(inputError || error || countError) && (
        <p className="mono text-[11px] text-[var(--danger)]">{inputError ?? error ?? countError}</p>
      )}

      <ExplainDialog
        open={explainOpen}
        onClose={() => setExplainOpen(false)}
        title={`Explain · ${database}.${collection}`}
        request={{
          connectionId,
          database,
          collection,
          filter: params.filter.trim() || '{}',
          projection: params.projection.trim() || undefined,
          sort: params.sort.trim() || undefined,
          limit: params.limit,
          skip: params.skip,
        }}
      />
    </div>
  );
}

function LabelledInput({
  label,
  value,
  onChange,
  placeholder,
  className,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  invalid?: boolean;
}) {
  return (
    <label className={cn('flex items-center gap-1.5', className)}>
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">{label}</span>
      <Input
        className={cn('mono h-6 py-0', invalid && 'border-[var(--danger)]')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
    </label>
  );
}

function LabelledNumber({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max?: number;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">{label}</span>
      <Input
        type="number"
        className="h-6 w-20 py-0 tabular-nums"
        value={String(value)}
        min={min}
        max={max}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (!Number.isFinite(next)) return;
          const clamped = Math.max(min, max === undefined ? next : Math.min(max, next));
          onChange(Math.trunc(clamped));
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Explain (PLAN §6 power tools)
// ---------------------------------------------------------------------------

export interface MongoExplainRequest {
  connectionId: string;
  database: string;
  collection: string;
  /** Extended JSON text. */
  filter: string;
  projection?: string;
  sort?: string;
  limit?: number;
  skip?: number;
}

/**
 * `POST /api/mongo/explain` runs `executionStats` for a **find** and maps it
 * onto the same `ExplainPlan` the SQL engines produce. The plan loads when the
 * dialog opens, and reloads when the request it was opened with changes.
 */
export function ExplainDialog({
  open,
  onClose,
  title,
  note,
  request,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  note?: React.ReactNode;
  request: MongoExplainRequest | null;
}) {
  const [plan, setPlan] = React.useState<ExplainPlan | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showRaw, setShowRaw] = React.useState(false);

  // The serialized request is both the effect's dependency and its payload, so
  // the plan reloads when the *values* change rather than on every re-render
  // that hands the dialog a freshly built object.
  const requestKey = request ? JSON.stringify(request) : '';

  React.useEffect(() => {
    if (!open || !requestKey) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPlan(null);
    api
      .post<ExplainPlan>('/api/mongo/explain', JSON.parse(requestKey) as MongoExplainRequest, controller.signal)
      .then((result) => setPlan(result))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Explain failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, requestKey]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width="lg"
      footer={
        <>
          <Button onClick={() => setShowRaw((v) => !v)}>{showRaw ? 'Show tree' : 'Show raw'}</Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {note && <p className="text-[11px] text-[var(--fg-muted)]">{note}</p>}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
            <Spinner className="size-3.5" /> Running explain…
          </div>
        )}
        {error && <ErrorBox title="Explain failed" message={error} />}
        {plan && !showRaw && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--fg-muted)]">
              <Badge tone={plan.analyzed ? 'ok' : 'neutral'}>
                {plan.analyzed ? 'executionStats' : 'queryPlanner'}
              </Badge>
              {plan.totalTimeMs !== undefined && <span>{plan.totalTimeMs.toFixed(1)} ms total</span>}
              {plan.planningTimeMs !== undefined && <span>{plan.planningTimeMs.toFixed(1)} ms planning</span>}
            </div>
            <div className="border border-[var(--border)]">
              <PlanNodeRow node={plan.root} depth={0} />
            </div>
          </>
        )}
        {plan && showRaw && (
          <pre className="mono max-h-[55vh] overflow-auto border border-[var(--border)] bg-[var(--bg)] p-2 text-[11px] leading-snug">
            {plan.raw}
          </pre>
        )}
      </div>
    </Dialog>
  );
}

function PlanNodeRow({ node, depth }: { node: ExplainNode; depth: number }) {
  const share = node.share === undefined ? null : Math.max(0, Math.min(1, node.share));
  return (
    <>
      <div
        className="flex items-start gap-2 border-b border-[var(--border)] px-2 py-1 last:border-0"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <div className="min-w-0 flex-1">
          <p className="mono text-[12px] text-[var(--fg)]">{node.label}</p>
          {node.detail && <p className="mono text-[11px] text-[var(--fg-muted)]">{node.detail}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-[var(--fg-muted)]">
          {node.estimatedRows !== undefined && <span title="Estimated rows">est {formatCount(node.estimatedRows)}</span>}
          {node.actualRows !== undefined && <span title="Actual rows">act {formatCount(node.actualRows)}</span>}
          {node.actualTimeMs !== undefined && <span>{node.actualTimeMs.toFixed(1)} ms</span>}
          {share !== null && (
            <span className="flex items-center gap-1" title={`${Math.round(share * 100)}% of runtime`}>
              <span className="h-1 w-12 bg-[var(--bg-active)]">
                <span className="block h-full bg-[var(--accent)]" style={{ width: `${share * 100}%` }} />
              </span>
            </span>
          )}
        </div>
      </div>
      {node.children.map((child, i) => (
        <PlanNodeRow key={`${child.label}-${i}`} node={child} depth={depth + 1} />
      ))}
    </>
  );
}
