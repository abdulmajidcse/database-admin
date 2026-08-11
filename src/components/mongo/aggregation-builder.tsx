'use client';

/**
 * The aggregation pipeline builder (PLAN M5).
 *
 * A pipeline is an ordered list of stages, so that is exactly what the editor
 * is: one small JSON editor per stage, with add / remove / reorder and a
 * template picker. Each stage is parsed on its own, which is what lets a
 * mistake be reported as "stage 3 is not valid JSON" instead of one opaque
 * error for the whole pipeline.
 *
 * The assembled pipeline is sent to `/api/mongo/aggregate` as Extended JSON
 * **text** and parsed server-side with `EJSON.parse` — the array is built by
 * composing parsed values, never by concatenating strings, and nothing is ever
 * evaluated. The connector appends its own `$limit` guard (PLAN §6 "Big
 * results") and refuses `$out`/`$merge` on a read-only connection (§8.5).
 *
 * Explain hits `/api/mongo/explain`, which explains a **find**. A pipeline is
 * not a find, so the button maps the leading `$match`/`$sort`/`$skip`/`$limit`
 * stages — the part the server can push into a query plan — and says how many
 * stages the plan covers. Showing the plan for a different query would be worse
 * than showing none.
 */

import * as React from 'react';
import { Group, Panel, Separator as PanelSeparator } from 'react-resizable-panels';
import { ChevronDown, ChevronUp, Gauge, Play, Plus, Trash2, Workflow } from 'lucide-react';
import { api } from '../../lib/api-client';
import type { ResultSet } from '../../lib/results';
import { Button, Checkbox, EmptyState, Input, Select, Toolbar, cn } from '../ui/primitives';
import { DocumentView, type DocumentViewMode } from './document-view';
import { ExplainDialog, JsonEditor, prettyJson, type MongoExplainRequest } from './query-bar';

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export interface PipelineStage {
  id: string;
  /** The stage operator, e.g. `$match`. */
  op: string;
  /** The operator's argument, as JSON text. */
  body: string;
  /** Disabled stages stay in the list but are left out of the run. */
  enabled: boolean;
}

interface StageTemplate {
  op: string;
  body: string;
  hint: string;
}

export const STAGE_TEMPLATES: StageTemplate[] = [
  { op: '$match', body: '{\n  "status": "active"\n}', hint: 'Filter documents. Put it first so an index can serve it.' },
  {
    op: '$group',
    body: '{\n  "_id": "$status",\n  "count": { "$sum": 1 }\n}',
    hint: 'Group by an expression and accumulate.',
  },
  { op: '$sort', body: '{\n  "createdAt": -1\n}', hint: 'Sort. Before $limit it is a top-k, after it is not.' },
  { op: '$limit', body: '20', hint: 'Stop after n documents.' },
  { op: '$skip', body: '0', hint: 'Discard the first n documents; the server still walks them.' },
  {
    op: '$lookup',
    body: '{\n  "from": "other",\n  "localField": "_id",\n  "foreignField": "refId",\n  "as": "joined"\n}',
    hint: 'Left outer join to another collection in the same database.',
  },
  { op: '$unwind', body: '"$items"', hint: 'One output document per element of an array field.' },
  { op: '$project', body: '{\n  "_id": 1,\n  "name": 1\n}', hint: 'Choose or compute the output fields.' },
  {
    op: '$facet',
    body: '{\n  "byStatus": [\n    { "$group": { "_id": "$status", "n": { "$sum": 1 } } }\n  ]\n}',
    hint: 'Run several sub-pipelines over the same input.',
  },
  { op: '$count', body: '"total"', hint: 'Replace the stream with a single count document.' },
];

let stageSeq = 0;

export function makeStage(op: string): PipelineStage {
  const template = STAGE_TEMPLATES.find((t) => t.op === op);
  stageSeq += 1;
  return { id: `stage-${stageSeq}`, op, body: template?.body ?? '{}', enabled: true };
}

export function defaultPipeline(): PipelineStage[] {
  return [makeStage('$match'), makeStage('$limit')];
}

interface BuildResult {
  pipeline: unknown[];
  /** Stage id → parser message, for the stages that did not parse. */
  errors: Record<string, string>;
}

/** Parse every enabled stage on its own and compose the array. */
function buildPipeline(stages: PipelineStage[]): BuildResult {
  const pipeline: unknown[] = [];
  const errors: Record<string, string> = {};
  for (const stage of stages) {
    if (!stage.enabled) continue;
    const text = stage.body.trim();
    if (text === '') {
      errors[stage.id] = `${stage.op} needs an argument.`;
      continue;
    }
    try {
      pipeline.push({ [stage.op]: JSON.parse(text) as unknown });
    } catch (err) {
      errors[stage.id] = (err as Error).message;
    }
  }
  return { pipeline, errors };
}

/**
 * The prefix of the pipeline that a `find` can express, which is the part
 * `/api/mongo/explain` can produce a plan for.
 */
function findEquivalent(stages: PipelineStage[]): {
  filter: string;
  sort?: string;
  limit?: number;
  skip?: number;
  covered: number;
} {
  let filter = '{}';
  let sort: string | undefined;
  let limit: number | undefined;
  let skip: number | undefined;
  let covered = 0;

  for (const stage of stages) {
    if (!stage.enabled) continue;
    const text = stage.body.trim();
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      break;
    }
    if (stage.op === '$match' && covered === 0 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      filter = JSON.stringify(value);
    } else if (stage.op === '$sort' && sort === undefined && value !== null && typeof value === 'object') {
      sort = JSON.stringify(value);
    } else if (stage.op === '$skip' && skip === undefined && typeof value === 'number') {
      skip = Math.max(0, Math.trunc(value));
    } else if (stage.op === '$limit' && limit === undefined && typeof value === 'number') {
      // The explain route validates 1…10 000; a bigger $limit is still a legal
      // stage, so it is clamped here rather than turned into a 400.
      limit = Math.max(1, Math.min(10_000, Math.trunc(value)));
    } else {
      break;
    }
    covered += 1;
  }
  return { filter, sort, limit, skip, covered };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface AggregationBuilderProps {
  connectionId: string;
  database: string;
  collection: string;
  stages: PipelineStage[];
  onStagesChange: (stages: PipelineStage[]) => void;
  limit: number;
  onLimitChange: (limit: number) => void;
  docMode: DocumentViewMode;
  onDocModeChange: (mode: DocumentViewMode) => void;
}

export function AggregationBuilder({
  connectionId,
  database,
  collection,
  stages,
  onStagesChange,
  limit,
  onLimitChange,
  docMode,
  onDocModeChange,
}: AggregationBuilderProps) {
  const [result, setResult] = React.useState<ResultSet | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [template, setTemplate] = React.useState(STAGE_TEMPLATES[0].op);
  const [explain, setExplain] = React.useState<MongoExplainRequest | null>(null);

  const build = React.useMemo(() => buildPipeline(stages), [stages]);
  const hasErrors = Object.keys(build.errors).length > 0;
  const runnable = connectionId.length > 0 && collection.length > 0 && !hasErrors && build.pipeline.length > 0;

  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const run = React.useCallback(async () => {
    const { pipeline, errors } = buildPipeline(stages);
    if (Object.keys(errors).length > 0 || pipeline.length === 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    try {
      const body = {
        connectionId,
        database,
        collection,
        // Extended JSON text; EJSON.parse decodes it server-side.
        pipeline: JSON.stringify(pipeline),
        limit,
      };
      setResult(await api.post<ResultSet>('/api/mongo/aggregate', body, controller.signal));
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Aggregation failed');
      setResult(null);
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }, [stages, connectionId, database, collection, limit]);

  function patch(id: string, values: Partial<PipelineStage>): void {
    onStagesChange(stages.map((s) => (s.id === id ? { ...s, ...values } : s)));
  }

  function move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= stages.length) return;
    const next = [...stages];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onStagesChange(next);
  }

  if (!collection) {
    return (
      <EmptyState
        icon={<Workflow className="size-5" />}
        title="Pick a collection"
        description="An aggregation runs against one collection; choose one on the left."
      />
    );
  }

  const equivalent = findEquivalent(stages);

  return (
    <Group orientation="vertical" className="h-full min-h-0">
      <Panel id="pipeline" minSize="20%" defaultSize="45%" className="min-h-0">
        <div className="flex h-full min-h-0 flex-col">
          <Toolbar>
            <Button
              variant="primary"
              size="xs"
              icon={<Play className="size-3" />}
              onClick={() => void run()}
              loading={running}
              disabled={!runnable}
              title="Run the pipeline (⌘↵)"
            >
              Run
            </Button>
            <Button
              size="xs"
              icon={<Gauge className="size-3" />}
              disabled={hasErrors}
              onClick={() =>
                setExplain({
                  connectionId,
                  database,
                  collection,
                  filter: equivalent.filter,
                  sort: equivalent.sort,
                  limit: equivalent.limit,
                  skip: equivalent.skip,
                })
              }
            >
              Explain
            </Button>
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
              Limit
              <Input
                type="number"
                min={1}
                max={10000}
                value={String(limit)}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (Number.isFinite(next)) onLimitChange(Math.max(1, Math.min(10_000, Math.trunc(next))));
                }}
                className="h-6 w-20 py-0 tabular-nums"
                title="Documents to keep; the connector adds its own guard on top."
              />
            </label>
            <div className="ml-auto flex items-center gap-1.5">
              <Select className="h-6 w-36 py-0" value={template} onChange={(e) => setTemplate(e.target.value)}>
                {STAGE_TEMPLATES.map((t) => (
                  <option key={t.op} value={t.op}>
                    {t.op}
                  </option>
                ))}
              </Select>
              <Button
                size="xs"
                icon={<Plus className="size-3" />}
                onClick={() => onStagesChange([...stages, makeStage(template)])}
              >
                Add stage
              </Button>
            </div>
          </Toolbar>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {stages.length === 0 ? (
              <EmptyState
                icon={<Workflow className="size-5" />}
                title="Empty pipeline"
                description="Add a stage to start. A $match first lets an index do the work."
                action={
                  <Button size="sm" onClick={() => onStagesChange(defaultPipeline())}>
                    Add $match and $limit
                  </Button>
                }
              />
            ) : (
              <div className="flex flex-col gap-2">
                {stages.map((stage, index) => (
                  <StageCard
                    key={stage.id}
                    stage={stage}
                    index={index}
                    total={stages.length}
                    error={build.errors[stage.id]}
                    onPatch={(values) => patch(stage.id, values)}
                    onMove={(delta) => move(index, delta)}
                    onRemove={() => onStagesChange(stages.filter((s) => s.id !== stage.id))}
                    onSubmit={() => void run()}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </Panel>

      <PanelSeparator className="h-px bg-[var(--border)] transition-colors hover:bg-[var(--accent)] data-[separator]:cursor-row-resize" />

      <Panel id="output" minSize="20%" className="min-h-0">
        <DocumentView
          connectionId={connectionId}
          database={database}
          collection={collection}
          result={result}
          loading={running}
          error={error}
          onRefresh={() => void run()}
          mode={docMode}
          onModeChange={onDocModeChange}
          // The output of a pipeline is computed, not a stored document.
          editable={false}
        />
      </Panel>

      <ExplainDialog
        open={explain !== null}
        onClose={() => setExplain(null)}
        title={`Explain · ${database}.${collection}`}
        note={
          equivalent.covered === 0
            ? 'Mongo explains a find. No leading $match/$sort/$skip/$limit stage could be mapped, so this is the plan for reading the collection unfiltered — the input your first stage receives.'
            : `Mongo explains a find, so this plan covers the first ${equivalent.covered} stage${
                equivalent.covered === 1 ? '' : 's'
              } of the pipeline. Later stages run after this plan produces its documents.`
        }
        request={explain}
      />
    </Group>
  );
}

function StageCard({
  stage,
  index,
  total,
  error,
  onPatch,
  onMove,
  onRemove,
  onSubmit,
}: {
  stage: PipelineStage;
  index: number;
  total: number;
  error: string | undefined;
  onPatch: (values: Partial<PipelineStage>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onSubmit: () => void;
}) {
  const known = STAGE_TEMPLATES.find((t) => t.op === stage.op);
  return (
    <div
      className={cn(
        'border border-[var(--border)] bg-[var(--bg-panel)]',
        error && 'border-[var(--danger)]',
        !stage.enabled && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-1">
        <span className="mono w-5 shrink-0 text-[10px] text-[var(--fg-subtle)]">{index + 1}</span>
        <Select
          className="mono h-6 w-36 py-0"
          value={stage.op}
          onChange={(e) => onPatch({ op: e.target.value })}
          title="Stage operator"
        >
          {/* A pipeline restored from a saved tab may use an operator that is
              not in the template list; keep it selectable rather than silently
              rewriting the user's stage. */}
          {!known && <option value={stage.op}>{stage.op}</option>}
          {STAGE_TEMPLATES.map((t) => (
            <option key={t.op} value={t.op}>
              {t.op}
            </option>
          ))}
        </Select>
        <span className="truncate text-[11px] text-[var(--fg-subtle)]">{known?.hint}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Checkbox
            className="text-[11px]"
            label="on"
            checked={stage.enabled}
            onChange={(e) => onPatch({ enabled: e.target.checked })}
          />
          <Button size="xs" variant="ghost" onClick={() => onPatch({ body: prettyJson(stage.body) })} title="Format">
            {'{ }'}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={<ChevronUp className="size-3" />}
            aria-label="Move up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <Button
            size="xs"
            variant="ghost"
            icon={<ChevronDown className="size-3" />}
            aria-label="Move down"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          />
          <Button size="xs" variant="ghost" icon={<Trash2 className="size-3" />} aria-label="Remove" onClick={onRemove} />
        </div>
      </div>
      <JsonEditor
        className="border-0"
        height={112}
        value={stage.body}
        onChange={(body) => onPatch({ body })}
        onSubmit={onSubmit}
      />
      {error && <p className="mono border-t border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--danger)]">{error}</p>}
    </div>
  );
}
