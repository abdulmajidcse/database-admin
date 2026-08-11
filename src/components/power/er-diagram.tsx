'use client';

/**
 * ER diagram (PLAN M6, §2 "Diagrams: @xyflow/react + elkjs layout").
 *
 * Built from the canonical `SchemaModel` and nothing else (§4): one node per
 * table listing its columns, one edge per foreign key drawn from the
 * referencing column to the referenced one. The layout is ELK's layered
 * algorithm, which is what makes a real schema readable — a force-directed
 * blob is pretty and useless.
 *
 * Three decisions carry the "100+ tables without freezing" requirement:
 *
 *  1. **Level of detail.** Below `LOD_ZOOM` the column lists are not rendered
 *     at all; the node keeps its box and shows only the table name. At 300
 *     tables that is ~4 000 rows of text the browser never lays out. The box
 *     size does NOT change with zoom, so no layout churn while panning.
 *  2. **Stable arrays.** Focus/dim state lives in React context rather than in
 *     node data, so dragging a node does not rebuild 300 node objects (which
 *     would re-render every node on every pointer move).
 *  3. **Handle switching.** Column handles only exist while columns are drawn,
 *     so at low zoom the edges are re-anchored to a node-level handle. An edge
 *     pointing at a handle that is not in the DOM is an edge React Flow drops.
 *
 * Export is hand-rolled SVG rather than a DOM screenshot: it is the same node
 * geometry the canvas uses, it stays vector, and it embeds no external
 * resources, so rasterising it to PNG through a canvas never taints it.
 */

import * as React from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useNodesState,
  useReactFlow,
  useStore,
  useUpdateNodeInternals,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Crosshair, Image, LayoutGrid, Maximize2, Network, RefreshCw, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import type { SchemaModel, TableKind, TableModel } from '@/lib/schema-model';
import { formatSchemaAge, useSchema } from '@/hooks/use-schema';
import { useWorkspaceStore } from '@/state/workspace-store';
import { registerTabView, type TabViewProps } from '@/components/shell/workspace';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorBox,
  Input,
  Select,
  Separator,
  Spinner,
  Toolbar,
  cn,
} from '@/components/ui/primitives';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const HEADER_H = 26;
const ROW_H = 16;
const BODY_PAD = 6;
const COLLAPSED_H = 40;
const MIN_W = 170;
const MAX_W = 340;
/** Advance widths for the 11px/10px monospace text inside a node. */
const NAME_CHAR_W = 6.3;
const TYPE_CHAR_W = 5.4;
/** Columns beyond this are folded into a "+N more" row so one wide table
 * cannot make a node taller than the viewport. */
const MAX_COLUMNS = 30;
/** Below this zoom the column lists stop being rendered. */
const LOD_ZOOM = 0.55;
/** Nodes above this are dropped from the graph with a banner, not silently. */
const MAX_NODES = 300;
/** React Flow only culls off-screen elements once the graph is big enough. */
const CULL_THRESHOLD = 50;

const NODE_SOURCE = 's:__node';
const NODE_TARGET = 't:__node';

const HANDLE_STYLE: React.CSSProperties = {
  width: 6,
  height: 6,
  minWidth: 6,
  minHeight: 6,
  border: 'none',
  background: 'transparent',
  // Invisible but still measurable — `display:none` would break edge anchoring.
  opacity: 0,
};

// ---------------------------------------------------------------------------
// Graph model
// ---------------------------------------------------------------------------

interface DisplayColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  unique: boolean;
  nullable: boolean;
}

interface TableNodeData extends Record<string, unknown> {
  label: string;
  schema?: string;
  kind: TableKind;
  columns: DisplayColumn[];
  hiddenColumns: number;
  totalColumns: number;
  rowEstimate?: number;
  width: number;
  height: number;
  /** True when the node was pulled in as a neighbour of a filter match. */
  neighbour: boolean;
}

type TableFlowNode = Node<TableNodeData, 'table'>;

interface FkEdgeData extends Record<string, unknown> {
  label: string;
}

type FkFlowEdge = Edge<FkEdgeData, 'fk'>;

interface EdgeSpec {
  id: string;
  source: string;
  target: string;
  sourceColumn: string;
  targetColumn: string;
  name: string;
  columns: string[];
  refColumns: string[];
  onDelete?: string;
}

interface NodeSpec {
  id: string;
  data: TableNodeData;
}

interface GraphSpec {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  /** Tables the current filters removed, for the "showing X of Y" line. */
  totalTables: number;
  /** Set when MAX_NODES kicked in. */
  cappedFrom: number;
}

type ColumnMode = 'all' | 'keys' | 'none';

interface BuildOptions {
  namespace: string;
  filter: string;
  columnMode: ColumnMode;
  showViews: boolean;
}

function nodeIdFor(schema: string | undefined, name: string): string {
  return `${schema ?? ''}.${name}`;
}

function includeKind(kind: TableKind, showViews: boolean): boolean {
  if (kind === 'table') return true;
  if (kind === 'system') return false; // catalog noise: never useful in a diagram
  return showViews;
}

/**
 * Everything the canvas draws, derived from the canonical model in one pass.
 * A filter keeps its matches *and their direct neighbours*: a foreign key with
 * one end hidden tells you nothing, and "what does `orders` touch?" is the
 * question people type a filter to answer.
 */
function buildGraph(model: SchemaModel | null, opts: BuildOptions): GraphSpec {
  if (!model) return { nodes: [], edges: [], totalTables: 0, cappedFrom: 0 };

  interface Candidate {
    id: string;
    table: TableModel;
    schema?: string;
  }

  const candidates: Candidate[] = [];
  for (const namespace of model.namespaces) {
    if (opts.namespace !== '' && namespace.name !== opts.namespace) continue;
    for (const table of namespace.tables) {
      if (!includeKind(table.kind, opts.showViews)) continue;
      const schema = table.schema ?? namespace.name;
      candidates.push({ id: nodeIdFor(schema, table.name), table, schema });
    }
  }

  const byId = new Map<string, Candidate>(candidates.map((c) => [c.id, c] as const));

  // Edges over the whole candidate set: the filter needs them to find neighbours.
  const allEdges: EdgeSpec[] = [];
  for (const candidate of candidates) {
    candidate.table.foreignKeys.forEach((fk, index) => {
      if (fk.columns.length === 0 || fk.refColumns.length === 0) return;
      const targetId = nodeIdFor(fk.refSchema ?? candidate.schema, fk.refTable);
      if (!byId.has(targetId)) return; // points outside the visible scope
      allEdges.push({
        id: `${candidate.id}::${fk.name || 'fk'}::${index}`,
        source: candidate.id,
        target: targetId,
        // Composite keys draw one edge anchored on the first pair; the rest of
        // the pairs live in the label rather than as parallel identical lines.
        sourceColumn: fk.columns[0],
        targetColumn: fk.refColumns[0],
        name: fk.name,
        columns: fk.columns,
        refColumns: fk.refColumns,
        onDelete: fk.onDelete,
      });
    });
  }

  // Which columns other tables point at — they must stay visible in "keys" mode
  // or their edge would lose its anchor.
  const referenced = new Map<string, Set<string>>();
  for (const edge of allEdges) {
    const set = referenced.get(edge.target) ?? new Set<string>();
    for (const column of edge.refColumns) set.add(column);
    referenced.set(edge.target, set);
  }

  const needle = opts.filter.trim().toLowerCase();
  let keep = new Set(candidates.map((c) => c.id));
  const neighbours = new Set<string>();
  if (needle !== '') {
    const matched = new Set<string>();
    for (const c of candidates) {
      const qualified = `${c.schema ? `${c.schema}.` : ''}${c.table.name}`.toLowerCase();
      if (qualified.includes(needle)) matched.add(c.id);
    }
    for (const edge of allEdges) {
      if (matched.has(edge.source) && !matched.has(edge.target)) neighbours.add(edge.target);
      if (matched.has(edge.target) && !matched.has(edge.source)) neighbours.add(edge.source);
    }
    keep = new Set([...matched, ...neighbours]);
  }

  let kept = candidates.filter((c) => keep.has(c.id));
  let cappedFrom = 0;
  if (kept.length > MAX_NODES) {
    // Keep the most connected tables: a hub is what makes a diagram legible.
    const degree = new Map<string, number>();
    for (const edge of allEdges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    cappedFrom = kept.length;
    kept = [...kept]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      .slice(0, MAX_NODES);
    keep = new Set(kept.map((c) => c.id));
  }

  const nodes: NodeSpec[] = kept.map((c) => ({
    id: c.id,
    data: buildNodeData(c.table, c.schema, opts.columnMode, referenced.get(c.id), neighbours.has(c.id)),
  }));

  const edges = allEdges.filter((e) => keep.has(e.source) && keep.has(e.target));
  return { nodes, edges, totalTables: candidates.length, cappedFrom };
}

function buildNodeData(
  table: TableModel,
  schema: string | undefined,
  mode: ColumnMode,
  referenced: Set<string> | undefined,
  neighbour: boolean,
): TableNodeData {
  const pk = new Set(table.primaryKey);
  const fk = new Set(table.foreignKeys.flatMap((f) => f.columns));
  const unique = new Set(
    table.indexes
      .filter((i) => i.unique && !i.primary)
      .flatMap((i) => i.columns.map((c) => c.name).filter((n): n is string => !!n)),
  );

  const ordered = [...table.columns].sort((a, b) => a.position - b.position);
  const all: DisplayColumn[] = ordered.map((c) => ({
    name: c.name,
    type: (c.type.raw || c.type.base).trim(),
    pk: pk.has(c.name),
    fk: fk.has(c.name),
    unique: unique.has(c.name),
    nullable: c.nullable,
  }));

  const isKey = (c: DisplayColumn) => c.pk || c.fk || c.unique || !!referenced?.has(c.name);

  let shown: DisplayColumn[] = [];
  if (mode === 'keys') shown = all.filter(isKey);
  else if (mode === 'all') shown = all;

  let hidden = 0;
  if (shown.length > MAX_COLUMNS) {
    const keys = shown.filter(isKey);
    const budget = Math.max(0, MAX_COLUMNS - keys.length);
    const others = new Set(shown.filter((c) => !isKey(c)).slice(0, budget));
    const next = shown.filter((c) => isKey(c) || others.has(c));
    hidden = shown.length - next.length;
    shown = next;
  }

  const rows = shown.length + (hidden > 0 ? 1 : 0);
  const nameChars = Math.max(table.name.length, ...shown.map((c) => c.name.length), 0);
  const typeChars = Math.max(0, ...shown.map((c) => Math.min(c.type.length, 18)));
  const width = clamp(MIN_W, Math.round(30 + nameChars * NAME_CHAR_W + 10 + typeChars * TYPE_CHAR_W), MAX_W);
  const height = rows === 0 ? COLLAPSED_H : HEADER_H + rows * ROW_H + BODY_PAD;

  return {
    label: table.name,
    schema,
    kind: table.kind,
    columns: shown,
    hiddenColumns: hidden,
    totalColumns: table.columns.length,
    rowEstimate: table.rowEstimate,
    width,
    height,
    neighbour,
  };
}

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Layout (elkjs, layered)
// ---------------------------------------------------------------------------

interface ElkGraph {
  id: string;
  layoutOptions?: Record<string, string>;
  children?: { id: string; width: number; height: number }[];
  edges?: { id: string; sources: string[]; targets: string[] }[];
}

interface ElkResult {
  children?: { id: string; x?: number; y?: number }[];
}

interface ElkInstance {
  layout(graph: ElkGraph): Promise<ElkResult>;
}

const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  // Left-to-right reads like the FK direction: children point at their parents.
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.spacing.nodeNode': '44',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.crossingMinimization.semiInteractive': 'true',
  // Unrelated islands (lookup tables with no FKs) get parked in their own block.
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '60',
};

let elkPromise: Promise<ElkInstance> | null = null;

/** Loaded on demand: the bundled ELK is ~1.6 MB and no other pane needs it. */
async function getElk(): Promise<ElkInstance> {
  if (!elkPromise) {
    elkPromise = import('elkjs/lib/elk.bundled.js').then((mod) => {
      const Ctor = (mod as unknown as { default: new () => ElkInstance }).default;
      return new Ctor();
    });
  }
  return elkPromise;
}

type Positions = Map<string, { x: number; y: number }>;

async function layoutGraph(nodes: NodeSpec[], edges: EdgeSpec[]): Promise<Positions> {
  try {
    const elk = await getElk();
    const result = await elk.layout({
      id: 'root',
      layoutOptions: ELK_OPTIONS,
      children: nodes.map((n) => ({ id: n.id, width: n.data.width, height: n.data.height })),
      edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    });
    const out: Positions = new Map();
    for (const child of result.children ?? []) out.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    if (out.size === nodes.length) return out;
  } catch {
    // ELK failing (a worker-less environment, an OOM on a huge graph) must not
    // leave an empty canvas — a grid is ugly but it is a diagram.
  }
  return gridLayout(nodes);
}

function gridLayout(nodes: NodeSpec[]): Positions {
  const out: Positions = new Map();
  const perRow = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  nodes.forEach((node, i) => {
    if (i % perRow === 0 && i > 0) {
      x = 0;
      y += rowHeight + 60;
      rowHeight = 0;
    }
    out.set(node.id, { x, y });
    x += node.data.width + 70;
    rowHeight = Math.max(rowHeight, node.data.height);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Shared render state — context, so dragging never rebuilds the node array
// ---------------------------------------------------------------------------

interface FocusState {
  focusId: string | null;
  nodes: ReadonlySet<string> | null;
  edges: ReadonlySet<string> | null;
}

const EMPTY_FOCUS: FocusState = { focusId: null, nodes: null, edges: null };
const FocusContext = React.createContext<FocusState>(EMPTY_FOCUS);
/** True while the column lists are drawn (user setting AND zoom above the LOD). */
const ExpandedContext = React.createContext<boolean>(true);

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

function TableNode({ id, data, selected }: NodeProps<TableFlowNode>) {
  const expanded = React.useContext(ExpandedContext);
  const focus = React.useContext(FocusContext);
  const dimmed = focus.nodes !== null && !focus.nodes.has(id);
  const isFocus = focus.focusId === id;
  const showColumns = expanded && data.columns.length > 0;

  return (
    <div
      style={{ width: data.width, height: data.height }}
      className={cn(
        'relative flex flex-col overflow-hidden rounded-sm border bg-[var(--bg-panel)] text-left shadow-[var(--shadow)]',
        isFocus || selected ? 'border-[var(--accent)]' : 'border-[var(--border-strong)]',
        dimmed && 'opacity-25',
        data.neighbour && !isFocus && 'border-dashed',
      )}
    >
      {/* Node-level anchors: the edges fall back to these below the LOD zoom. */}
      <Handle type="target" id={NODE_TARGET} position={Position.Left} isConnectable={false} style={HANDLE_STYLE} />
      <Handle type="source" id={NODE_SOURCE} position={Position.Right} isConnectable={false} style={HANDLE_STYLE} />

      <div
        className={cn(
          'flex shrink-0 items-center gap-1 border-b border-[var(--border)] px-1.5',
          isFocus ? 'bg-[var(--selection)]' : 'bg-[var(--grid-header)]',
        )}
        style={{ height: HEADER_H }}
      >
        <span className="truncate text-[12px] font-semibold text-[var(--fg)]" title={qualified(data)}>
          {data.label}
        </span>
        {data.kind !== 'table' && (
          <span className="shrink-0 text-[9px] uppercase tracking-wide text-[var(--fg-subtle)]">
            {data.kind === 'materialized_view' ? 'matview' : data.kind.replace('_', ' ')}
          </span>
        )}
      </div>

      {showColumns ? (
        <div className="flex flex-col" style={{ paddingTop: 2 }}>
          {data.columns.map((column) => (
            <div key={column.name} className="relative flex items-center gap-1 px-1.5" style={{ height: ROW_H }}>
              <Handle
                type="target"
                id={`t:${column.name}`}
                position={Position.Left}
                isConnectable={false}
                style={HANDLE_STYLE}
              />
              <span
                className={cn(
                  'w-[26px] shrink-0 text-[9px] font-semibold',
                  column.pk ? 'text-[var(--warn)]' : column.fk ? 'text-[var(--accent)]' : 'text-[var(--fg-subtle)]',
                )}
              >
                {column.pk ? 'PK' : column.fk ? 'FK' : column.unique ? 'U' : ''}
              </span>
              <span
                className={cn(
                  'mono truncate text-[11px]',
                  column.pk ? 'font-semibold text-[var(--fg)]' : 'text-[var(--fg)]',
                )}
              >
                {column.name}
              </span>
              <span className="mono ml-auto shrink-0 truncate text-[10px] text-[var(--fg-muted)]">
                {column.type}
                {!column.nullable && <span className="text-[var(--fg-subtle)]"> ·</span>}
              </span>
              <Handle
                type="source"
                id={`s:${column.name}`}
                position={Position.Right}
                isConnectable={false}
                style={HANDLE_STYLE}
              />
            </div>
          ))}
          {data.hiddenColumns > 0 && (
            <div className="px-1.5 text-[10px] text-[var(--fg-subtle)]" style={{ height: ROW_H }}>
              +{data.hiddenColumns} more columns
            </div>
          )}
        </div>
      ) : (
        // Below the LOD zoom the box keeps its size and drops its contents, so
        // panning a 300-table diagram costs no text layout.
        <div className="flex flex-1 items-center justify-center px-2">
          <span className="truncate text-[11px] text-[var(--fg-muted)]">
            {data.totalColumns} column{data.totalColumns === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </div>
  );
}

function qualified(data: TableNodeData): string {
  return data.schema ? `${data.schema}.${data.label}` : data.label;
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

function FkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
}: EdgeProps<FkFlowEdge>) {
  const focus = React.useContext(FocusContext);
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const related = focus.edges === null || focus.edges.has(id);

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      interactionWidth={12}
      style={{
        stroke: focus.edges !== null && related ? 'var(--accent)' : 'var(--border-strong)',
        strokeWidth: focus.edges !== null && related ? 2 : 1.2,
        opacity: related ? 1 : 0.12,
      }}
    />
  );
}

const nodeTypes: NodeTypes = { table: TableNode };
const edgeTypes: EdgeTypes = { fk: FkEdge };

// ---------------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------------

export interface ErDiagramProps {
  connectionId: string;
  /** Namespace to open on; empty means every namespace in the model. */
  schema?: string;
  /** Table to focus once the model arrives. */
  focusTable?: string;
  onSettingsChange?: (patch: Record<string, unknown>) => void;
  className?: string;
}

export function ErDiagram(props: ErDiagramProps) {
  return (
    <ReactFlowProvider>
      <DiagramCanvas {...props} />
    </ReactFlowProvider>
  );
}

function DiagramCanvas({ connectionId, schema, focusTable, onSettingsChange, className }: ErDiagramProps) {
  // Opening a diagram is an explicit request for the model, so this hook is one
  // of the few that enables introspection on mount.
  const { model, ageMs, isPending, isRefreshing, error, refresh } = useSchema(connectionId, { enabled: true });

  const [namespace, setNamespace] = React.useState(schema ?? '');
  const [filter, setFilter] = React.useState('');
  const [columnMode, setColumnMode] = React.useState<ColumnMode>('all');
  const [showViews, setShowViews] = React.useState(true);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const [layoutNonce, setLayoutNonce] = React.useState(0);
  const [laying, setLaying] = React.useState(false);
  const [fitPending, setFitPending] = React.useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<TableFlowNode>([]);
  const { fitView, getNodes, setCenter } = useReactFlow<TableFlowNode, FkFlowEdge>();
  const updateNodeInternals = useUpdateNodeInternals();

  // Zoom-driven level of detail. A boolean selector only re-renders on the
  // crossing, not on every wheel tick.
  const zoomedIn = useStore((s) => s.transform[2] >= LOD_ZOOM);
  const expanded = columnMode !== 'none' && zoomedIn;

  const namespaces = React.useMemo(() => (model ? model.namespaces.map((n) => n.name) : []), [model]);

  // Every graph change re-runs ELK, so the filter is debounced: laying out 300
  // tables on each keystroke would make the box unusable.
  const debouncedFilter = useDebounced(filter, 180);

  const graph = React.useMemo(
    () => buildGraph(model, { namespace, filter: debouncedFilter, columnMode, showViews }),
    [model, namespace, debouncedFilter, columnMode, showViews],
  );

  // Layout: ELK runs off the render path and the token drops stale results.
  const layoutToken = React.useRef(0);
  React.useEffect(() => {
    const token = ++layoutToken.current;
    if (graph.nodes.length === 0) {
      setNodes([]);
      setLaying(false);
      return;
    }
    setLaying(true);
    void layoutGraph(graph.nodes, graph.edges).then((positions) => {
      if (token !== layoutToken.current) return;
      setNodes(
        graph.nodes.map((spec) => ({
          id: spec.id,
          type: 'table' as const,
          position: positions.get(spec.id) ?? { x: 0, y: 0 },
          data: spec.data,
          width: spec.data.width,
          height: spec.data.height,
          draggable: true,
        })),
      );
      setLaying(false);
      setFitPending(true);
    });
    // `layoutNonce` is the "re-layout" button: same graph, fresh positions.
  }, [graph, layoutNonce, setNodes]);

  const edges = React.useMemo<FkFlowEdge[]>(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: expanded ? `s:${e.sourceColumn}` : NODE_SOURCE,
        targetHandle: expanded ? `t:${e.targetColumn}` : NODE_TARGET,
        type: 'fk' as const,
        markerEnd: 'url(#er-arrow)',
        data: { label: describeEdge(e) },
      })),
    [graph.edges, expanded],
  );

  // Handles appear and disappear with the LOD, and React Flow caches their
  // positions until it is told otherwise.
  const nodeIds = React.useMemo(() => graph.nodes.map((n) => n.id), [graph.nodes]);
  React.useEffect(() => {
    if (nodeIds.length > 0) updateNodeInternals(nodeIds);
  }, [expanded, nodeIds, updateNodeInternals]);

  React.useEffect(() => {
    if (!fitPending || nodes.length === 0) return;
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.14, duration: 220 });
      setFitPending(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [fitPending, nodes.length, fitView]);

  // The tree opens the diagram on a table: focus it once, when it first exists.
  const appliedFocus = React.useRef(false);
  React.useEffect(() => {
    if (appliedFocus.current || !focusTable || graph.nodes.length === 0) return;
    const match = graph.nodes.find((n) => n.data.label === focusTable);
    if (!match) return;
    appliedFocus.current = true;
    setFocusId(match.id);
  }, [focusTable, graph.nodes]);

  const focus = React.useMemo<FocusState>(() => {
    if (!focusId || !graph.nodes.some((n) => n.id === focusId)) return EMPTY_FOCUS;
    const relatedNodes = new Set<string>([focusId]);
    const relatedEdges = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.source !== focusId && edge.target !== focusId) continue;
      relatedEdges.add(edge.id);
      relatedNodes.add(edge.source);
      relatedNodes.add(edge.target);
    }
    return { focusId, nodes: relatedNodes, edges: relatedEdges };
  }, [focusId, graph]);

  const focusNode = focusId ? graph.nodes.find((n) => n.id === focusId) ?? null : null;
  const outgoing = React.useMemo(
    () => (focusId ? graph.edges.filter((e) => e.source === focusId) : []),
    [graph.edges, focusId],
  );
  const incoming = React.useMemo(
    () => (focusId ? graph.edges.filter((e) => e.target === focusId) : []),
    [graph.edges, focusId],
  );

  const centreOn = React.useCallback(
    (id: string) => {
      const node = getNodes().find((n) => n.id === id);
      if (!node) return;
      setCenter(node.position.x + node.data.width / 2, node.position.y + node.data.height / 2, {
        zoom: Math.max(0.8, LOD_ZOOM + 0.2),
        duration: 250,
      });
    },
    [getNodes, setCenter],
  );

  const exportDiagram = React.useCallback(
    async (format: 'svg' | 'png') => {
      const current = getNodes();
      if (current.length === 0) {
        toast.error('There is nothing to export yet');
        return;
      }
      const palette = readPalette();
      const drawing = buildSvg(current, graph.edges, expanded, palette);
      const name = `er-${slug(namespace || model?.database || 'schema')}`;
      try {
        if (format === 'svg') {
          downloadBlob(new Blob([drawing.svg], { type: 'image/svg+xml;charset=utf-8' }), `${name}.svg`);
        } else {
          const png = await svgToPng(drawing.svg, drawing.width, drawing.height, 2, palette.bg);
          downloadBlob(png, `${name}.png`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'The diagram could not be exported');
      }
    },
    [getNodes, graph.edges, expanded, namespace, model?.database],
  );

  const settings = onSettingsChange;

  if (error) {
    return (
      <div className="p-3">
        <ErrorBox title="Could not read the schema" message={error.message} />
      </div>
    );
  }

  if (!model && isPending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-[var(--fg-muted)]">
        <Spinner /> Introspecting the schema…
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-[var(--bg)]', className)}>
      <Toolbar>
        <Select
          className="w-44"
          value={namespace}
          onChange={(e) => {
            setNamespace(e.target.value);
            settings?.({ schema: e.target.value || undefined });
          }}
        >
          <option value="">All schemas</option>
          {namespaces.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>

        <div className="relative w-52">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            className="h-7 pl-6"
            placeholder="filter tables"
            value={filter}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        <Select className="w-32" value={columnMode} onChange={(e) => setColumnMode(e.target.value as ColumnMode)}>
          <option value="all">All columns</option>
          <option value="keys">Keys only</option>
          <option value="none">No columns</option>
        </Select>

        <Checkbox
          label="Views"
          className="text-[11px]"
          checked={showViews}
          onChange={(e) => setShowViews(e.target.checked)}
        />

        <Separator vertical />

        <Button
          size="xs"
          variant="ghost"
          icon={<LayoutGrid className="size-3" />}
          loading={laying}
          onClick={() => setLayoutNonce((n) => n + 1)}
        >
          Auto-layout
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<Maximize2 className="size-3" />}
          onClick={() => void fitView({ padding: 0.14, duration: 220 })}
        >
          Zoom to fit
        </Button>
        <Button size="xs" variant="ghost" icon={<Image className="size-3" />} onClick={() => void exportDiagram('svg')}>
          SVG
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void exportDiagram('png')}>
          PNG
        </Button>

        <div className="ml-auto flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
          <span className="tabular-nums">
            {graph.nodes.length} table{graph.nodes.length === 1 ? '' : 's'} · {graph.edges.length} FK
          </span>
          {!zoomedIn && columnMode !== 'none' && <Badge tone="neutral">columns hidden at this zoom</Badge>}
          <span className="text-[var(--fg-subtle)]">schema {formatSchemaAge(ageMs)}</span>
          <Button
            size="xs"
            variant="ghost"
            title="Re-introspect"
            icon={<RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />}
            onClick={() => void refresh()}
          />
        </div>
      </Toolbar>

      {graph.cappedFrom > 0 && (
        <p className="border-b border-[var(--border)] bg-[var(--warn-bg)] px-2 py-1 text-[11px] text-[var(--warn)]">
          Showing the {MAX_NODES} most connected of {graph.cappedFrom} tables — filter or pick a single schema to see
          the rest.
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {graph.nodes.length === 0 ? (
          <EmptyState
            icon={<Network className="size-5" />}
            title={graph.totalTables === 0 ? 'No tables in this scope' : 'Nothing matches the filter'}
            description={
              graph.totalTables === 0
                ? 'This schema has no tables, or every one of them is a view and views are hidden.'
                : `${graph.totalTables} tables are in scope; none match "${debouncedFilter}".`
            }
          />
        ) : (
          <div className="flex h-full min-h-0">
            <div className="relative min-w-0 flex-1">
              {/* Own marker defs: a token-coloured arrowhead that follows the theme. */}
              <svg width="0" height="0" className="absolute" aria-hidden="true">
                <defs>
                  <marker
                    id="er-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="5"
                    markerHeight="5"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 9 5 L 0 9 z" style={{ fill: 'var(--border-strong)' }} />
                  </marker>
                </defs>
              </svg>

              <ExpandedContext.Provider value={expanded}>
                <FocusContext.Provider value={focus}>
                  <ReactFlow<TableFlowNode, FkFlowEdge>
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    onNodeClick={(_, node) => setFocusId((prev) => (prev === node.id ? null : node.id))}
                    onPaneClick={() => setFocusId(null)}
                    nodesConnectable={false}
                    nodesDraggable
                    elevateNodesOnSelect
                    minZoom={0.05}
                    maxZoom={2.5}
                    onlyRenderVisibleElements={nodes.length > CULL_THRESHOLD}
                    proOptions={{ hideAttribution: true }}
                    className="bg-[var(--bg-subtle)]"
                  >
                    <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border)" />
                    <Controls showInteractive={false} />
                    {nodes.length > 12 && (
                      <MiniMap
                        pannable
                        zoomable
                        bgColor="var(--bg-panel)"
                        maskColor="var(--bg-hover)"
                        nodeColor="var(--border-strong)"
                        nodeStrokeColor="var(--border-strong)"
                      />
                    )}
                  </ReactFlow>
                </FocusContext.Provider>
              </ExpandedContext.Provider>

              {laying && (
                <div className="absolute left-2 top-2 flex items-center gap-2 border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[11px] text-[var(--fg-muted)]">
                  <Spinner className="size-3" /> Laying out {graph.nodes.length} tables…
                </div>
              )}
            </div>

            {focusNode && (
              <aside className="flex w-64 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-panel)]">
                <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1">
                  <span className="truncate text-[12px] font-semibold" title={qualified(focusNode.data)}>
                    {focusNode.data.label}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="ml-auto"
                    title="Centre on this table"
                    icon={<Crosshair className="size-3" />}
                    onClick={() => centreOn(focusNode.id)}
                  />
                  <Button
                    size="xs"
                    variant="ghost"
                    title="Clear focus"
                    icon={<X className="size-3" />}
                    onClick={() => setFocusId(null)}
                  />
                </div>
                <div className="border-b border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-muted)]">
                  {focusNode.data.schema && <span className="mono">{focusNode.data.schema}</span>}
                  <span className="ml-1">
                    {focusNode.data.totalColumns} columns
                    {focusNode.data.rowEstimate !== undefined && ` · ~${focusNode.data.rowEstimate.toLocaleString()} rows`}
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <RelationList
                    title={`References (${outgoing.length})`}
                    empty="This table has no foreign keys."
                    items={outgoing.map((e) => ({
                      id: e.id,
                      other: e.target,
                      text: `${e.columns.join(', ')} → ${labelFor(graph, e.target)}(${e.refColumns.join(', ')})`,
                      name: e.name,
                    }))}
                    onSelect={(id) => {
                      setFocusId(id);
                      centreOn(id);
                    }}
                  />
                  <RelationList
                    title={`Referenced by (${incoming.length})`}
                    empty="No table points at this one."
                    items={incoming.map((e) => ({
                      id: e.id,
                      other: e.source,
                      text: `${labelFor(graph, e.source)}(${e.columns.join(', ')}) → ${e.refColumns.join(', ')}`,
                      name: e.name,
                    }))}
                    onSelect={(id) => {
                      setFocusId(id);
                      centreOn(id);
                    }}
                  />
                </div>
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

function RelationList({
  title,
  empty,
  items,
  onSelect,
}: {
  title: string;
  empty: string;
  items: { id: string; other: string; text: string; name: string }[];
  onSelect: (nodeId: string) => void;
}) {
  return (
    <section>
      <h3 className="border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="px-2 py-1 text-[11px] text-[var(--fg-subtle)]">{empty}</p>
      ) : (
        items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.other)}
            className="block w-full border-b border-[var(--border)] px-2 py-1 text-left hover:bg-[var(--bg-hover)]"
          >
            <span className="mono block truncate text-[11px] text-[var(--fg)]" title={item.text}>
              {item.text}
            </span>
            {item.name && <span className="block truncate text-[10px] text-[var(--fg-subtle)]">{item.name}</span>}
          </button>
        ))
      )}
    </section>
  );
}

function labelFor(graph: GraphSpec, id: string): string {
  return graph.nodes.find((n) => n.id === id)?.data.label ?? id;
}

function describeEdge(edge: EdgeSpec): string {
  return `${edge.name}: ${edge.columns.join(', ')} → ${edge.target}(${edge.refColumns.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Export (SVG / PNG)
// ---------------------------------------------------------------------------

interface Palette {
  bg: string;
  panel: string;
  border: string;
  borderStrong: string;
  fg: string;
  muted: string;
  subtle: string;
  accent: string;
  warn: string;
  header: string;
}

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: read('--bg', '#ffffff'),
    panel: read('--bg-panel', '#ffffff'),
    border: read('--border', '#dfe3e8'),
    borderStrong: read('--border-strong', '#c5ccd6'),
    fg: read('--fg', '#1a1d21'),
    muted: read('--fg-muted', '#626a75'),
    subtle: read('--fg-subtle', '#8a929c'),
    accent: read('--accent', '#2563eb'),
    warn: read('--warn', '#b45309'),
    header: read('--grid-header', '#f2f4f7'),
  };
}

const SVG_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * The diagram as standalone SVG, drawn from the same geometry the canvas uses.
 * No `foreignObject`, no external font, no remote image — which is what keeps
 * the PNG conversion from tainting the canvas.
 */
function buildSvg(
  nodes: TableFlowNode[],
  edgeSpecs: EdgeSpec[],
  expanded: boolean,
  palette: Palette,
): { svg: string; width: number; height: number } {
  const pad = 40;
  const byId = new Map<string, TableFlowNode>(nodes.map((n) => [n.id, n] as const));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + node.data.width);
    maxY = Math.max(maxY, node.position.y + node.data.height);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 100;
    maxY = 100;
  }

  const width = Math.round(maxX - minX + pad * 2);
  const height = Math.round(maxY - minY + pad * 2);
  const ox = pad - minX;
  const oy = pad - minY;

  const anchorY = (node: TableFlowNode, column: string): number => {
    if (!expanded) return node.position.y + node.data.height / 2;
    const index = node.data.columns.findIndex((c) => c.name === column);
    if (index < 0) return node.position.y + node.data.height / 2;
    return node.position.y + HEADER_H + 2 + index * ROW_H + ROW_H / 2;
  };

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="${palette.borderStrong}"/></marker></defs>`,
    `<rect width="${width}" height="${height}" fill="${palette.bg}"/>`,
    `<g stroke="${palette.borderStrong}" fill="none" stroke-width="1.2">`,
  );

  for (const spec of edgeSpecs) {
    const source = byId.get(spec.source);
    const target = byId.get(spec.target);
    if (!source || !target) continue;
    const sx = source.position.x + source.data.width + ox;
    const sy = anchorY(source, spec.sourceColumn) + oy;
    const tx = target.position.x + ox;
    const ty = anchorY(target, spec.targetColumn) + oy;
    const dx = Math.max(40, Math.abs(tx - sx) / 2);
    parts.push(
      `<path d="M ${round(sx)} ${round(sy)} C ${round(sx + dx)} ${round(sy)}, ${round(tx - dx)} ${round(ty)}, ${round(tx)} ${round(ty)}" marker-end="url(#arrow)"><title>${escapeXml(describeEdge(spec))}</title></path>`,
    );
  }
  parts.push('</g>');

  for (const node of nodes) {
    const x = node.position.x + ox;
    const y = node.position.y + oy;
    const { width: w, height: h, columns, label, hiddenColumns, totalColumns } = node.data;
    parts.push(`<g>`);
    parts.push(
      `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="2" fill="${palette.panel}" stroke="${palette.borderStrong}"/>`,
      `<path d="M ${round(x)} ${round(y + HEADER_H)} h ${round(w)}" stroke="${palette.border}"/>`,
      `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${HEADER_H}" rx="2" fill="${palette.header}"/>`,
      `<text x="${round(x + 6)}" y="${round(y + 17)}" font-family="${SVG_FONT}" font-size="12" font-weight="600" fill="${palette.fg}">${escapeXml(clip(label, Math.floor((w - 12) / NAME_CHAR_W)))}</text>`,
    );

    if (expanded && columns.length > 0) {
      columns.forEach((column, i) => {
        const ty = y + HEADER_H + 2 + i * ROW_H + ROW_H - 4;
        const marker = column.pk ? 'PK' : column.fk ? 'FK' : column.unique ? 'U' : '';
        if (marker) {
          parts.push(
            `<text x="${round(x + 6)}" y="${round(ty)}" font-family="${SVG_FONT}" font-size="9" font-weight="600" fill="${column.pk ? palette.warn : column.fk ? palette.accent : palette.subtle}">${marker}</text>`,
          );
        }
        parts.push(
          `<text x="${round(x + 32)}" y="${round(ty)}" font-family="${SVG_FONT}" font-size="11" fill="${palette.fg}">${escapeXml(clip(column.name, 22))}</text>`,
          `<text x="${round(x + w - 6)}" y="${round(ty)}" text-anchor="end" font-family="${SVG_FONT}" font-size="10" fill="${palette.muted}">${escapeXml(clip(column.type, 16))}</text>`,
        );
      });
      if (hiddenColumns > 0) {
        const ty = y + HEADER_H + 2 + columns.length * ROW_H + ROW_H - 4;
        parts.push(
          `<text x="${round(x + 6)}" y="${round(ty)}" font-family="${SVG_FONT}" font-size="10" fill="${palette.subtle}">+${hiddenColumns} more columns</text>`,
        );
      }
    } else {
      parts.push(
        `<text x="${round(x + w / 2)}" y="${round(y + HEADER_H + (h - HEADER_H) / 2 + 4)}" text-anchor="middle" font-family="${SVG_FONT}" font-size="11" fill="${palette.muted}">${totalColumns} columns</text>`,
      );
    }
    parts.push('</g>');
  }

  parts.push('</svg>');
  return { svg: parts.join(''), width, height };
}

function svgToPng(svg: string, width: number, height: number, scale: number, background: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new window.Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('This browser gave no 2D canvas to draw on');
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('The browser could not encode the PNG'));
        }, 'image/png');
      } catch (err) {
        reject(err instanceof Error ? err : new Error('The diagram could not be rasterised'));
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The diagram could not be rasterised'));
    };
    img.src = url;
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&apos;',
  );
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schema';
}

// ---------------------------------------------------------------------------
// Tab view
// ---------------------------------------------------------------------------

export function ErDiagramTab({ tab }: TabViewProps) {
  const setTabState = useWorkspaceStore((s) => s.setTabState);
  const schema = typeof tab.state.schema === 'string' ? tab.state.schema : undefined;
  const focusTable = typeof tab.state.focusTable === 'string' ? tab.state.focusTable : undefined;

  if (!tab.connectionId) {
    return (
      <EmptyState
        icon={<Network className="size-5" />}
        title="No connection for this diagram"
        description="Close the tab and open the diagram from a schema in the object tree."
      />
    );
  }

  return (
    <ErDiagram
      key={`${tab.id}:${tab.connectionId}`}
      connectionId={tab.connectionId}
      schema={schema}
      focusTable={focusTable}
      onSettingsChange={(patch) => setTabState(tab.id, patch)}
    />
  );
}

// The shell imports nothing from feature modules; each attaches itself.
registerTabView('diagram', ErDiagramTab);

export default ErDiagram;
