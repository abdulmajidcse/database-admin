'use client';

/**
 * EXPLAIN visualizer (PLAN M6, §6 power tools).
 *
 * Renders the engine-neutral `ExplainPlan` from `src/lib/results.ts` as a
 * collapsible tree with a flame bar per node whose width is `node.share` of
 * total runtime.
 *
 * The opinionated part is the red highlighting. A slow node is usually a
 * *symptom*; the cause is almost always a bad row estimate, because the planner
 * picked a nested loop for 10 rows and got 400 000. So the misestimate ratio —
 * max(actual/estimated, estimated/actual), per loop, which is how both engines
 * report the two numbers — is what gets coloured, and the single worst node is
 * called out in the header where it cannot be missed. `share` still drives the
 * bar, so an expensive-but-correctly-estimated node stays visible too.
 *
 * The raw plan is always one click away (`plan.raw`): every parser drops
 * something, and the text is what you paste into a bug report.
 */

import * as React from 'react';
import { ChevronDown, ChevronRight, Copy, FileText, ListTree, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { ExplainNode, ExplainPlan } from '@/lib/results';
import { Badge, Button, Separator, Toolbar, cn } from '@/components/ui/primitives';

/** Ratios above these are worth colouring. Below 3× the planner did fine. */
const RATIO_WARN = 3;
const RATIO_BAD = 10;

/** Nodes above this share of runtime get a hot bar. */
const SHARE_WARN = 0.2;
const SHARE_BAD = 0.5;

export interface ExplainViewProps {
  plan: ExplainPlan;
  /** Extra controls for the toolbar (e.g. a re-run button from the caller). */
  actions?: React.ReactNode;
  className?: string;
}

interface Row {
  /** Stable path id — `0.2.1` — used as the collapse key and React key. */
  id: string;
  parentId: string | null;
  node: ExplainNode;
  depth: number;
  /** Misestimate ratio, or null when the plan was not analyzed. */
  ratio: number | null;
}

export function ExplainView({ plan, actions, className }: ExplainViewProps) {
  const [raw, setRaw] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const [selected, setSelected] = React.useState<string | null>(null);

  const rows = React.useMemo(() => flatten(plan.root), [plan]);

  // A new plan is a new tree: old collapse keys would land on unrelated nodes.
  React.useEffect(() => {
    setCollapsed(new Set<string>());
    setSelected(null);
  }, [plan]);

  const worst = React.useMemo(() => {
    let found: Row | null = null;
    for (const row of rows) {
      if (row.ratio === null || row.ratio < RATIO_WARN) continue;
      if (!found || row.ratio > (found.ratio ?? 0)) found = row;
    }
    return found;
  }, [rows]);

  const visible = React.useMemo(() => {
    const hidden = new Set<string>();
    const out: Row[] = [];
    for (const row of rows) {
      if (row.parentId !== null && (hidden.has(row.parentId) || collapsed.has(row.parentId))) {
        hidden.add(row.id);
        continue;
      }
      out.push(row);
    }
    return out;
  }, [rows, collapsed]);

  /** Ids that have at least one child — the only rows with a chevron. */
  const branches = React.useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) if (row.parentId !== null) set.add(row.parentId);
    return set;
  }, [rows]);

  const toggle = React.useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Expand every ancestor of a node so it can be selected from the header. */
  const reveal = React.useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const parts = id.split('.');
      for (let i = 1; i <= parts.length; i++) next.delete(parts.slice(0, i).join('.'));
      return next;
    });
    setSelected(id);
  }, []);

  const copyRaw = () => {
    void navigator.clipboard
      .writeText(plan.raw)
      .then(() => toast.success('Plan copied'))
      .catch(() => toast.error('The browser refused clipboard access'));
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-[var(--bg)]', className)}>
      <Toolbar>
        <Badge>{plan.engine}</Badge>
        {plan.analyzed ? <Badge tone="accent">analyzed</Badge> : <Badge>estimates only</Badge>}
        {plan.planningTimeMs !== undefined && (
          <span className="text-[11px] text-[var(--fg-muted)]">planning {formatMs(plan.planningTimeMs)}</span>
        )}
        {plan.totalTimeMs !== undefined && (
          <span className="text-[11px] text-[var(--fg-muted)]">execution {formatMs(plan.totalTimeMs)}</span>
        )}
        <span className="text-[11px] text-[var(--fg-subtle)]">{rows.length} nodes</span>

        <div className="ml-auto flex items-center gap-1">
          {actions}
          {actions && <Separator vertical />}
          <Button
            size="xs"
            variant="ghost"
            icon={<ListTree className="size-3" />}
            onClick={() => setCollapsed(new Set<string>())}
            disabled={raw || collapsed.size === 0}
          >
            Expand all
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setCollapsed(new Set(branches))}
            disabled={raw}
          >
            Collapse all
          </Button>
          <Separator vertical />
          <Button
            size="xs"
            variant={raw ? 'primary' : 'ghost'}
            icon={<FileText className="size-3" />}
            onClick={() => setRaw((v) => !v)}
          >
            Raw plan
          </Button>
        </div>
      </Toolbar>

      {/* The headline finding: the worst estimate, not the slowest node. */}
      {!raw && worst && (
        <button
          type="button"
          onClick={() => reveal(worst.id)}
          className={cn(
            'flex w-full items-center gap-2 border-b px-2 py-1 text-left text-[11px]',
            worst.ratio !== null && worst.ratio >= RATIO_BAD
              ? 'border-[var(--border)] bg-[var(--danger-bg)] text-[var(--danger)]'
              : 'border-[var(--border)] bg-[var(--warn-bg)] text-[var(--warn)]',
          )}
        >
          <TriangleAlert className="size-3 shrink-0" />
          <span className="font-medium">Worst row estimate: {worst.node.label}</span>
          <span className="text-[var(--fg-muted)]">
            planner expected {formatRows(worst.node.estimatedRows)}, got {formatRows(worst.node.actualRows)} (
            {formatRatio(worst.ratio)} out)
          </span>
          <span className="ml-auto text-[var(--fg-subtle)]">show node</span>
        </button>
      )}

      {raw ? (
        <div className="relative min-h-0 flex-1 overflow-auto">
          <Button
            size="xs"
            variant="default"
            className="absolute right-3 top-2"
            icon={<Copy className="size-3" />}
            onClick={copyRaw}
          >
            Copy
          </Button>
          <pre className="mono whitespace-pre-wrap break-words p-2 text-[var(--fg)]">{plan.raw}</pre>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--grid-header)] px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">
            <span className="w-24 shrink-0">Runtime</span>
            <span className="flex-1">Node</span>
            <span className="w-44 shrink-0 text-right">Rows est → actual</span>
            <span className="w-28 shrink-0 text-right">Time × loops</span>
          </div>
          {visible.map((row) => (
            <PlanRow
              key={row.id}
              row={row}
              expandable={branches.has(row.id)}
              collapsed={collapsed.has(row.id)}
              selected={selected === row.id}
              analyzed={plan.analyzed}
              onToggle={toggle}
              onSelect={setSelected}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const PlanRow = React.memo(function PlanRow({
  row,
  expandable,
  collapsed,
  selected,
  analyzed,
  onToggle,
  onSelect,
}: {
  row: Row;
  expandable: boolean;
  collapsed: boolean;
  selected: boolean;
  analyzed: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const { node, depth, ratio } = row;
  const share = clamp01(node.share ?? 0);
  const bad = ratio !== null && ratio >= RATIO_BAD;
  const warn = ratio !== null && ratio >= RATIO_WARN && !bad;
  const extras = node.extra ? Object.entries(node.extra) : [];

  return (
    <div
      onClick={() => onSelect(row.id)}
      className={cn(
        'flex cursor-default items-start gap-2 border-b border-[var(--border)] px-2 py-1 hover:bg-[var(--bg-hover)]',
        selected && 'bg-[var(--selection)]',
        bad && !selected && 'bg-[var(--danger-bg)]',
      )}
    >
      {/* Flame bar: share of total runtime, so the hot node is obvious. */}
      <span className="mt-0.5 flex w-24 shrink-0 items-center gap-1">
        <span className="h-1.5 w-16 bg-[var(--bg-active)]">
          <span
            className="block h-full"
            style={{
              width: `${Math.max(share > 0 ? 2 : 0, Math.round(share * 100))}%`,
              background: share >= SHARE_BAD ? 'var(--danger)' : share >= SHARE_WARN ? 'var(--warn)' : 'var(--accent)',
            }}
          />
        </span>
        <span className="text-[10px] tabular-nums text-[var(--fg-subtle)]">
          {node.share === undefined ? '—' : `${Math.round(share * 100)}%`}
        </span>
      </span>

      <div className="flex min-w-0 flex-1 flex-col" style={{ paddingLeft: depth * 14 }}>
        <div className="flex min-w-0 items-center gap-1.5">
          {expandable ? (
            <button
              type="button"
              aria-label={collapsed ? 'Expand' : 'Collapse'}
              className="shrink-0 rounded text-[var(--fg-subtle)] hover:text-[var(--fg)]"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(row.id);
              }}
            >
              {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <span
            className={cn(
              'truncate text-[12px] font-medium',
              bad ? 'text-[var(--danger)]' : warn ? 'text-[var(--warn)]' : 'text-[var(--fg)]',
            )}
            title={node.label}
          >
            {node.label}
          </span>
          {ratio !== null && ratio >= RATIO_WARN && (
            <Badge tone={bad ? 'danger' : 'warn'} className="shrink-0">
              {formatRatio(ratio)} off
            </Badge>
          )}
          {collapsed && <span className="shrink-0 text-[10px] text-[var(--fg-subtle)]">collapsed</span>}
        </div>
        {node.detail && (
          <p className="mono truncate pl-5 text-[11px] text-[var(--fg-muted)]" title={node.detail}>
            {node.detail}
          </p>
        )}
        {extras.length > 0 && (
          <p className="mono truncate pl-5 text-[10px] text-[var(--fg-subtle)]" title={extras.map(pairText).join('  ')}>
            {extras.map(pairText).join('  ')}
          </p>
        )}
      </div>

      <span className="w-44 shrink-0 text-right text-[11px] tabular-nums">
        {analyzed && node.actualRows !== undefined ? (
          <>
            <span className="text-[var(--fg-subtle)]">{formatRows(node.estimatedRows)}</span>
            <span className="text-[var(--fg-subtle)]"> → </span>
            <span className={cn(bad ? 'text-[var(--danger)]' : warn ? 'text-[var(--warn)]' : 'text-[var(--fg)]')}>
              {formatRows(node.actualRows)}
            </span>
          </>
        ) : (
          <span className="text-[var(--fg-muted)]">
            {node.estimatedRows !== undefined ? `~${formatRows(node.estimatedRows)} rows` : '—'}
          </span>
        )}
        {node.estimatedCost !== undefined && (
          <span className="block text-[10px] text-[var(--fg-subtle)]">cost {formatNumber(node.estimatedCost)}</span>
        )}
      </span>

      <span className="w-28 shrink-0 text-right text-[11px] tabular-nums text-[var(--fg-muted)]">
        {node.actualTimeMs !== undefined ? formatMs(node.actualTimeMs) : '—'}
        {node.loops !== undefined && node.loops > 1 && (
          <span className="block text-[10px] text-[var(--fg-subtle)]">× {formatNumber(node.loops)} loops</span>
        )}
      </span>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Plan maths
// ---------------------------------------------------------------------------

function flatten(root: ExplainNode): Row[] {
  const out: Row[] = [];
  const walk = (node: ExplainNode, id: string, parentId: string | null, depth: number): void => {
    out.push({ id, parentId, node, depth, ratio: estimateRatio(node) });
    node.children.forEach((child, i) => walk(child, `${id}.${i}`, id, depth + 1));
  };
  walk(root, '0', null, 0);
  return out;
}

/**
 * How badly the planner guessed, as a factor ≥ 1 in either direction. Both
 * numbers are per loop on every engine we parse, so they are compared as they
 * arrive; the 1-row floor stops "0 estimated, 3 actual" from reading as ∞.
 */
function estimateRatio(node: ExplainNode): number | null {
  if (node.estimatedRows === undefined || node.actualRows === undefined) return null;
  const est = Math.max(node.estimatedRows, 1);
  const act = Math.max(node.actualRows, 1);
  return act >= est ? act / est : est / act;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function pairText([key, value]: [string, unknown]): string {
  return `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
}

function formatRatio(ratio: number | null): string {
  if (ratio === null) return '—';
  if (ratio >= 100) return `${Math.round(ratio).toLocaleString()}×`;
  return `${ratio.toFixed(ratio >= 10 ? 0 : 1)}×`;
}

function formatRows(rows: number | undefined): string {
  if (rows === undefined) return '—';
  return formatNumber(rows);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export default ExplainView;
