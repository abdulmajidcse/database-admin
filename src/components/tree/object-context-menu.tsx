'use client';

/**
 * Right-click actions for a tree object (PLAN §1 Navigation, §6, §9).
 *
 * The item list is derived from `TreeNode.kind`, so a Redis key and a Postgres
 * table each get exactly the verbs that mean something for them — a menu full
 * of greyed-out entries is worse than a short one.
 *
 * Two of the verbs belong to panes this file does not own (Export and Import
 * have their own wizards in §7). They are dispatched on a small action bus:
 * whichever pane is mounted takes them and opens its wizard prefilled. Nothing
 * mounted means nothing is lost — the built-in fallbacks here do the real work
 * (a streaming CSV download, a compact import that posts a §7.3 job), so the
 * menu is never a dead end.
 *
 * Drop is §9: a typed confirmation naming the object, then /api/ddl/execute,
 * which itself demands the connection name back before it will run anything
 * destructive. Both gates are deliberate.
 */

import * as React from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Braces,
  Copy,
  Download,
  FileCode,
  Network,
  RefreshCw,
  Table2,
  Trash2,
  Upload,
} from 'lucide-react';
import { api, downloadExport } from '@/lib/api-client';
import type { DdlResponse, ExportRequest } from '@/lib/api-types';
import type { ConnectionConfig } from '@/lib/connection';
import type { TreeNode, TreeNodeKind } from '@/lib/results';
import type { EngineKind, SchemaModel, TableModel } from '@/lib/schema-model';
import { findTable } from '@/lib/schema-model';
import { Button, Checkbox, Dialog, ConfirmDialog, Field, Input, Select, cn } from '@/components/ui/primitives';
import { fetchSchema } from '@/hooks/use-schema';
import { useWorkspaceStore } from '@/state/workspace-store';

// ---------------------------------------------------------------------------
// Target description
// ---------------------------------------------------------------------------

export interface ObjectTarget {
  connectionId: string;
  connection: ConnectionConfig | null;
  node: TreeNode;
  /** The node's tree path, so Refresh can invalidate exactly this subtree. */
  segments: string[];
}

export interface ObjectRef {
  /** Namespace: a Postgres schema, a MySQL database, a Mongo database. */
  schema?: string;
  /** The object's own name. */
  name: string;
  /** Owning table, for a column / index / trigger / foreign key. */
  table?: string;
}

function metaString(node: TreeNode, key: string): string | undefined {
  const value = node.meta?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function metaNumber(node: TreeNode, key: string): number | undefined {
  const value = node.meta?.[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Connectors label their `meta` with the vocabulary of their engine — Postgres
 * sends `{database, schema, table}`, MySQL `{database, table}`, SQLite
 * `{schema, table}`, Mongo `{database, collection}`. This collapses all of them
 * onto one namespace + name pair.
 */
export function objectRef(node: TreeNode): ObjectRef {
  const namespace = metaString(node, 'schema') ?? metaString(node, 'database');
  const table = metaString(node, 'table') ?? metaString(node, 'collection');

  switch (node.kind) {
    case 'database':
      return { name: metaString(node, 'database') ?? node.label };
    case 'schema':
      return { name: metaString(node, 'schema') ?? node.label };
    case 'table':
    case 'view':
    case 'materialized-view':
      return { schema: namespace, name: table ?? node.label };
    case 'collection':
      return { schema: metaString(node, 'database'), name: table ?? node.label };
    case 'key':
      return { name: metaString(node, 'key') ?? node.label };
    case 'column':
      return { schema: namespace, name: metaString(node, 'column') ?? node.label, table };
    case 'index':
    case 'mongo-index':
      return {
        schema: namespace,
        name: metaString(node, 'index') ?? metaString(node, 'name') ?? node.label,
        table,
      };
    case 'trigger':
      return {
        schema: namespace,
        name: metaString(node, 'trigger') ?? metaString(node, 'name') ?? node.label,
        table,
      };
    case 'foreign-key':
      return {
        schema: namespace,
        name: metaString(node, 'foreignKey') ?? metaString(node, 'name') ?? node.label,
        table,
      };
    default:
      return { schema: namespace, name: metaString(node, 'name') ?? node.label };
  }
}

/** `schema.table`, or `schema.table.column` for a column. */
export function qualifiedFor(node: TreeNode): string {
  const ref = objectRef(node);
  if (node.kind === 'column') {
    return [ref.schema, ref.table, ref.name].filter((p): p is string => !!p).join('.');
  }
  return ref.schema ? `${ref.schema}.${ref.name}` : ref.name;
}

const DATA_KINDS: TreeNodeKind[] = ['table', 'view', 'materialized-view'];

// ---------------------------------------------------------------------------
// Opening things (shared with double-click / Enter in the tree)
// ---------------------------------------------------------------------------

/**
 * The default action for a node. Returns false when the kind has no editor of
 * its own, which is the tree's cue to expand it instead.
 */
export function openObjectTab(target: ObjectTarget): boolean {
  const { node, connectionId } = target;
  const openTab = useWorkspaceStore.getState().openTab;
  const ref = objectRef(node);

  if (DATA_KINDS.includes(node.kind)) {
    openTab({
      kind: 'table',
      title: ref.name,
      key: `table:${qualifiedFor(node)}`,
      connectionId,
      state: {
        schema: ref.schema,
        table: ref.name,
        tableKind: node.kind === 'table' ? 'table' : node.kind === 'view' ? 'view' : 'materialized_view',
      },
    });
    return true;
  }

  if (node.kind === 'column' && ref.table) {
    openTab({
      kind: 'table',
      title: ref.table,
      key: `table:${ref.schema ? `${ref.schema}.${ref.table}` : ref.table}`,
      connectionId,
      state: { schema: ref.schema, table: ref.table, focusColumn: ref.name },
    });
    return true;
  }

  if (node.kind === 'collection') {
    openTab({
      kind: 'mongo',
      title: ref.name,
      key: `mongo:${ref.schema ?? ''}.${ref.name}`,
      connectionId,
      state: { database: ref.schema, collection: ref.name },
    });
    return true;
  }

  if (node.kind === 'key' || node.kind === 'keyspace') {
    const db = metaNumber(node, 'db') ?? 0;
    const prefix = metaString(node, 'prefix');
    openTab({
      kind: 'redis',
      title: node.kind === 'key' ? ref.name : `${node.label}*`,
      key: `redis:${db}:${node.id}`,
      connectionId,
      state:
        node.kind === 'key'
          ? { db, key: metaString(node, 'key') ?? node.label }
          : { db, match: `${prefix ?? ''}*` },
    });
    return true;
  }

  return false;
}

function openDiagram(target: ObjectTarget): void {
  const ref = objectRef(target.node);
  const scope = ref.schema ?? (target.node.kind === 'schema' || target.node.kind === 'database' ? ref.name : '');
  useWorkspaceStore.getState().openTab({
    kind: 'diagram',
    title: `ER: ${scope || (target.connection?.name ?? 'schema')}`,
    key: `diagram:${scope}`,
    connectionId: target.connectionId,
    state: { schema: scope || undefined, focusTable: DATA_KINDS.includes(target.node.kind) ? ref.name : undefined },
  });
}

// ---------------------------------------------------------------------------
// Action bus — Export/Import wizards live in §7 and take over when mounted
// ---------------------------------------------------------------------------

export type ObjectActionRequest =
  | { type: 'export'; connectionId: string; schema?: string; table: string }
  | { type: 'import'; connectionId: string; schema?: string; table: string };

/** Return false to decline; anything else counts as "handled". */
export type ObjectActionHandler = (request: ObjectActionRequest) => boolean | void;

const actionHandlers = new Set<ObjectActionHandler>();

export function onObjectAction(handler: ObjectActionHandler): () => void {
  actionHandlers.add(handler);
  return () => {
    actionHandlers.delete(handler);
  };
}

function dispatchObjectAction(request: ObjectActionRequest): boolean {
  for (const handler of [...actionHandlers]) {
    if (handler(request) !== false) return true;
  }
  return false;
}

/** §7.4: the browser owns the transfer, so nothing is buffered in the tab. */
function downloadTableCsv(connectionId: string, schema: string | undefined, table: string): void {
  const request: ExportRequest = {
    connectionId,
    source: { kind: 'table', schema, table },
    format: 'csv',
    destination: { kind: 'download' },
    options: {
      structure: 'data-only',
      binaryEncoding: 'base64',
      nullLiteral: '',
      header: true,
      compression: 'none',
    },
  };
  downloadExport('/api/export/download', request);
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

function quoteIdent(engine: EngineKind | undefined, name: string): string {
  // split/join rather than a regex so the backtick never has to be escaped
  // inside a template literal.
  if (engine === 'mysql' || engine === 'mariadb') return '`' + name.split('`').join('``') + '`';
  return `"${name.split('"').join('""')}"`;
}

function quoteQualified(engine: EngineKind | undefined, schema: string | undefined, name: string): string {
  return schema ? `${quoteIdent(engine, schema)}.${quoteIdent(engine, name)}` : quoteIdent(engine, name);
}

function terminate(statements: string[]): string {
  return statements
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => (s.endsWith(';') ? s : `${s};`))
    .join('\n\n');
}

function namespaceOf(model: SchemaModel, name: string | undefined) {
  if (name) {
    const exact = model.namespaces.find((n) => n.name === name);
    if (exact) return exact;
  }
  return model.namespaces.length === 1 ? model.namespaces[0] : undefined;
}

function indexDdl(engine: EngineKind | undefined, table: TableModel, name: string): string | null {
  const index = table.indexes.find((i) => i.name === name);
  if (!index) return null;
  if (index.primary) {
    return `ALTER TABLE ${quoteQualified(engine, table.schema, table.name)} ADD CONSTRAINT ${quoteIdent(
      engine,
      index.name,
    )} PRIMARY KEY (${index.columns.map((c) => quoteIdent(engine, c.name ?? '')).join(', ')});`;
  }
  const columns = index.columns
    .map((c) => `${c.name ? quoteIdent(engine, c.name) : (c.expression ?? '')}${c.order === 'desc' ? ' DESC' : ''}`)
    .join(', ');
  const method = index.method && engine === 'postgres' ? ` USING ${index.method}` : '';
  const where = index.predicate ? ` WHERE ${index.predicate}` : '';
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(engine, index.name)} ON ${quoteQualified(
    engine,
    table.schema,
    table.name,
  )}${method} (${columns})${where};`;
}

/**
 * "Open DDL" — the model already holds view bodies, routine sources and enum
 * values, so only a real table needs the connector's generator (/api/ddl/plan
 * with `current: null` is exactly "create this table").
 */
async function ddlForTarget(client: QueryClient, target: ObjectTarget): Promise<{ title: string; sql: string }> {
  const { node, connectionId } = target;
  const engine = target.connection?.engine;
  const ref = objectRef(node);
  const { model } = await fetchSchema(client, connectionId);

  const tableName = DATA_KINDS.includes(node.kind) ? ref.name : ref.table;
  const table = tableName ? findTable(model, ref.schema, tableName) : undefined;

  if (node.kind === 'column' || DATA_KINDS.includes(node.kind)) {
    if (!table) throw new Error(`${ref.name} is not in the introspected schema — refresh and try again.`);
    if ((table.kind === 'view' || table.kind === 'materialized_view') && table.definition) {
      const keyword = table.kind === 'view' ? 'VIEW' : 'MATERIALIZED VIEW';
      const body = table.definition.trim().replace(/;$/, '');
      return {
        title: table.name,
        sql: `CREATE ${keyword} ${quoteQualified(engine, table.schema, table.name)} AS\n${body};\n`,
      };
    }
    const plan = await api.post<DdlResponse>('/api/ddl/plan', { connectionId, current: null, desired: table });
    return { title: table.name, sql: terminate(plan.statements) };
  }

  const ns = namespaceOf(model, ref.schema);

  if (node.kind === 'index') {
    // Postgres hands us pg_get_indexdef in the node's meta, which beats anything
    // reconstructed from the model.
    const authoritative = metaString(node, 'definition');
    if (authoritative) return { title: ref.name, sql: terminate([authoritative]) };
    const sql = table ? indexDdl(engine, table, ref.name) : null;
    if (!sql) throw new Error(`Index ${ref.name} is not in the introspected schema.`);
    return { title: ref.name, sql };
  }

  if (node.kind === 'foreign-key' && table) {
    const fk = table.foreignKeys.find((f) => f.name === ref.name);
    if (!fk) throw new Error(`Foreign key ${ref.name} is not in the introspected schema.`);
    const actions = [
      fk.onDelete ? ` ON DELETE ${fk.onDelete.toUpperCase()}` : '',
      fk.onUpdate ? ` ON UPDATE ${fk.onUpdate.toUpperCase()}` : '',
    ].join('');
    return {
      title: ref.name,
      sql:
        `ALTER TABLE ${quoteQualified(engine, table.schema, table.name)}\n` +
        `  ADD CONSTRAINT ${quoteIdent(engine, fk.name)} FOREIGN KEY (${fk.columns
          .map((c) => quoteIdent(engine, c))
          .join(', ')})\n` +
        `  REFERENCES ${quoteQualified(engine, fk.refSchema ?? table.schema, fk.refTable)} (${fk.refColumns
          .map((c) => quoteIdent(engine, c))
          .join(', ')})${actions};`,
    };
  }

  if (node.kind === 'routine') {
    const routine = ns?.routines.find((r) => r.name === ref.name);
    if (!routine?.definition) throw new Error(`No source is available for ${ref.name}.`);
    return { title: ref.name, sql: terminate([routine.definition]) };
  }

  if (node.kind === 'trigger') {
    const trigger = ns?.triggers.find((t) => t.name === ref.name);
    if (!trigger) throw new Error(`Trigger ${ref.name} is not in the introspected schema.`);
    if (trigger.statement) return { title: ref.name, sql: terminate([trigger.statement]) };
    return {
      title: ref.name,
      sql:
        `CREATE TRIGGER ${quoteIdent(engine, trigger.name)} ${trigger.timing.toUpperCase()} ` +
        `${trigger.events.map((e) => e.toUpperCase()).join(' OR ')} ON ${quoteQualified(
          engine,
          trigger.schema,
          trigger.table,
        )}\n  FOR EACH ${(trigger.orientation ?? 'row').toUpperCase()}${
          trigger.condition ? ` WHEN (${trigger.condition})` : ''
        };`,
    };
  }

  if (node.kind === 'sequence') {
    const sequence = ns?.sequences.find((s) => s.name === ref.name);
    if (!sequence) throw new Error(`Sequence ${ref.name} is not in the introspected schema.`);
    const parts = [
      sequence.start ? `  START WITH ${sequence.start}` : '',
      sequence.increment ? `  INCREMENT BY ${sequence.increment}` : '',
      sequence.minValue ? `  MINVALUE ${sequence.minValue}` : '',
      sequence.maxValue ? `  MAXVALUE ${sequence.maxValue}` : '',
      sequence.cycle ? '  CYCLE' : '',
    ].filter((p) => p !== '');
    return {
      title: ref.name,
      sql: `CREATE SEQUENCE ${quoteQualified(engine, sequence.schema, sequence.name)}\n${parts.join('\n')};`,
    };
  }

  if (node.kind === 'enum') {
    const enumType = ns?.enums.find((e) => e.name === ref.name);
    if (!enumType) throw new Error(`Type ${ref.name} is not in the introspected schema.`);
    return {
      title: ref.name,
      sql: `CREATE TYPE ${quoteQualified(engine, enumType.schema, enumType.name)} AS ENUM (\n${enumType.values
        .map((v) => `  '${v.replace(/'/g, "''")}'`)
        .join(',\n')}\n);`,
    };
  }

  throw new Error(`There is no DDL to show for a ${node.kind.replace('-', ' ')}.`);
}

// ---------------------------------------------------------------------------
// Drop (§9)
// ---------------------------------------------------------------------------

interface DdlExecuteLike {
  executed: boolean;
  succeeded: number;
  statements: { status: 'ok' | 'error' | 'skipped'; error?: { message: string } }[];
  requiresConfirmation?: { phrase: string; reasons: string[] };
}

function dropSql(target: ObjectTarget): string | null {
  const engine = target.connection?.engine;
  const { node } = target;
  const ref = objectRef(node);
  const qualified = quoteQualified(engine, ref.schema, ref.name);

  switch (node.kind) {
    case 'table':
      return `DROP TABLE ${qualified}`;
    case 'view':
      return `DROP VIEW ${qualified}`;
    case 'materialized-view':
      return `DROP MATERIALIZED VIEW ${qualified}`;
    case 'sequence':
      return `DROP SEQUENCE ${qualified}`;
    case 'enum':
      return `DROP TYPE ${qualified}`;
    case 'schema':
      return `DROP SCHEMA ${quoteIdent(engine, ref.name)}`;
    case 'database':
      return `DROP DATABASE ${quoteIdent(engine, ref.name)}`;
    case 'routine': {
      const kind = (metaString(node, 'routineType') ?? '').toUpperCase() === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION';
      return `DROP ${kind} ${qualified}`;
    }
    case 'index':
      // MySQL has no standalone index namespace; the others do.
      return engine === 'mysql' || engine === 'mariadb'
        ? ref.table
          ? `DROP INDEX ${quoteIdent(engine, ref.name)} ON ${quoteQualified(engine, ref.schema, ref.table)}`
          : null
        : `DROP INDEX ${qualified}`;
    case 'trigger':
      return engine === 'postgres'
        ? ref.table
          ? `DROP TRIGGER ${quoteIdent(engine, ref.name)} ON ${quoteQualified(engine, ref.schema, ref.table)}`
          : null
        : `DROP TRIGGER ${qualified}`;
    case 'foreign-key':
      // MySQL spells this DROP FOREIGN KEY; DROP CONSTRAINT only arrived in 8.0.19.
      return ref.table
        ? `ALTER TABLE ${quoteQualified(engine, ref.schema, ref.table)} DROP ${
            engine === 'mysql' || engine === 'mariadb' ? 'FOREIGN KEY' : 'CONSTRAINT'
          } ${quoteIdent(engine, ref.name)}`
        : null;
    default:
      return null;
  }
}

/** Which kinds can be dropped at all — the menu hides the verb for the rest. */
function canDrop(target: ObjectTarget): boolean {
  const { node } = target;
  if (node.kind === 'key' || node.kind === 'mongo-index') return true;
  if (target.connection?.readOnly) return false;
  return dropSql(target) !== null;
}

async function performDrop(target: ObjectTarget): Promise<string> {
  const { node, connectionId } = target;
  const ref = objectRef(node);

  if (node.kind === 'key') {
    await api.post('/api/redis/key/delete', { connectionId, key: metaString(node, 'key') ?? node.label });
    return `Deleted ${ref.name}`;
  }

  if (node.kind === 'mongo-index') {
    await api.post('/api/mongo/index/drop', {
      connectionId,
      database: metaString(node, 'database'),
      collection: metaString(node, 'collection'),
      name: ref.name,
    });
    return `Dropped index ${ref.name}`;
  }

  const sql = dropSql(target);
  if (!sql) throw new Error(`Dropping a ${node.kind.replace('-', ' ')} is not supported here.`);

  // The first POST is the §9 dry run: the route answers with the phrase it
  // wants echoed rather than running anything destructive unprompted.
  let result = await api.post<DdlExecuteLike>('/api/ddl/execute', { connectionId, sql });
  if (result.requiresConfirmation) {
    result = await api.post<DdlExecuteLike>('/api/ddl/execute', {
      connectionId,
      sql,
      confirm: result.requiresConfirmation.phrase,
    });
  }
  const failed = result.statements.find((s) => s.status === 'error');
  if (failed) throw new Error(failed.error?.message ?? 'The DROP statement failed.');
  if (!result.executed) throw new Error('The server withheld the statement.');
  return `Dropped ${ref.name}`;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

interface MenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
  /** Draw a divider above this entry. */
  divider?: boolean;
  run: () => void | Promise<void>;
}

export interface ObjectContextMenuProps {
  target: ObjectTarget | null;
  x: number;
  y: number;
  onClose: () => void;
  /** Invalidate this subtree — the tree owns the query cache. */
  onRefresh: (segments: string[]) => void;
}

const MENU_WIDTH = 220;

export function ObjectContextMenu({ target, x, y, onClose, onRefresh }: ObjectContextMenuProps) {
  const client = useQueryClient();
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [active, setActive] = React.useState(0);
  const [position, setPosition] = React.useState({ left: x, top: y });
  // Captured copies: these dialogs outlive the menu, which closes on pick.
  const [dropping, setDropping] = React.useState<ObjectTarget | null>(null);
  const [importing, setImporting] = React.useState<ObjectTarget | null>(null);

  React.useEffect(() => {
    setActive(0);
    setPosition({ left: x, top: y });
  }, [target, x, y]);

  // Flip the menu back inside the viewport when it opens near an edge.
  React.useLayoutEffect(() => {
    if (!target || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const left = x + rect.width > window.innerWidth - 4 ? Math.max(4, x - rect.width) : x;
    const top = y + rect.height > window.innerHeight - 4 ? Math.max(4, y - rect.height) : y;
    setPosition({ left, top });
  }, [target, x, y]);

  React.useEffect(() => {
    if (!target) return;
    const dismiss = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [target, onClose]);

  async function copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${what}`);
    } catch {
      toast.error('The browser refused clipboard access.');
    }
  }

  async function showDdl(current: ObjectTarget): Promise<void> {
    try {
      const { title, sql } = await ddlForTarget(client, current);
      useWorkspaceStore.getState().openTab({
        kind: 'sql',
        title: `DDL: ${title}`,
        key: `ddl:${current.node.id}`,
        connectionId: current.connectionId,
        state: { sql },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not build the DDL.');
    }
  }

  const items = React.useMemo<MenuItem[]>(() => {
    if (!target) return [];
    const node = target.node;
    const ref = objectRef(node);
    const list: MenuItem[] = [];
    const isData = DATA_KINDS.includes(node.kind);

    if (isData || node.kind === 'collection' || node.kind === 'key' || node.kind === 'column') {
      list.push({
        id: 'open',
        label:
          node.kind === 'collection' ? 'Open documents' : node.kind === 'key' ? 'Open value' : 'Open data',
        icon: node.kind === 'collection' ? <Braces className="size-3.5" /> : <Table2 className="size-3.5" />,
        run: () => {
          openObjectTab(target);
        },
      });
    }

    if (target.connection && target.connection.engine !== 'redis' && target.connection.engine !== 'mongodb') {
      const ddlKinds: TreeNodeKind[] = [
        'table',
        'view',
        'materialized-view',
        'column',
        'index',
        'foreign-key',
        'routine',
        'trigger',
        'sequence',
        'enum',
      ];
      if (ddlKinds.includes(node.kind)) {
        list.push({
          id: 'ddl',
          label: 'Open DDL',
          icon: <FileCode className="size-3.5" />,
          run: () => showDdl(target),
        });
      }
    }

    list.push({
      id: 'copy-name',
      label: 'Copy name',
      icon: <Copy className="size-3.5" />,
      divider: list.length > 0,
      run: () => copy(node.label, 'name'),
    });
    list.push({
      id: 'copy-qualified',
      label: 'Copy qualified name',
      icon: <Copy className="size-3.5" />,
      run: () => copy(qualifiedFor(node), 'qualified name'),
    });

    if (isData) {
      list.push({
        id: 'export',
        label: 'Export table…',
        icon: <Download className="size-3.5" />,
        divider: true,
        run: () => {
          const request: ObjectActionRequest = {
            type: 'export',
            connectionId: target.connectionId,
            schema: ref.schema,
            table: ref.name,
          };
          if (!dispatchObjectAction(request)) downloadTableCsv(target.connectionId, ref.schema, ref.name);
        },
      });
    }

    // §8.5: a read-only connection is never offered a way to write to it.
    if (node.kind === 'table' && !target.connection?.readOnly) {
      list.push({
        id: 'import',
        label: 'Import into table…',
        icon: <Upload className="size-3.5" />,
        run: () => {
          const request: ObjectActionRequest = {
            type: 'import',
            connectionId: target.connectionId,
            schema: ref.schema,
            table: ref.name,
          };
          if (!dispatchObjectAction(request)) setImporting(target);
        },
      });
    }

    if (isData || node.kind === 'schema' || node.kind === 'database') {
      const sqlEngine = target.connection && target.connection.engine !== 'redis';
      if (sqlEngine) {
        list.push({
          id: 'diagram',
          label: 'Show ER diagram',
          icon: <Network className="size-3.5" />,
          run: () => openDiagram(target),
        });
      }
    }

    list.push({
      id: 'refresh',
      label: 'Refresh',
      icon: <RefreshCw className="size-3.5" />,
      divider: true,
      run: () => onRefresh(target.segments),
    });

    if (canDrop(target)) {
      list.push({
        id: 'drop',
        label: node.kind === 'key' ? 'Delete key…' : `Drop ${node.kind.replace('-', ' ')}…`,
        icon: <Trash2 className="size-3.5" />,
        danger: true,
        divider: true,
        run: () => setDropping(target),
      });
    }

    return list;
    // `showDdl`/`copy` are stable closures over refs that never change identity
    // in a way that matters here; the target is what drives the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, onRefresh]);

  // Capture phase + stopPropagation: while the menu is open the tree behind it
  // must not also act on the same arrow or Enter press.
  React.useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => (i + 1) % Math.max(1, items.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => (i - 1 + items.length) % Math.max(1, items.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const item = items[active];
        if (item) {
          onClose();
          void item.run();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [target, items, active, onClose]);

  return (
    <>
      {target && items.length > 0 && (
        <div
          ref={menuRef}
          role="menu"
          style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          className="fixed z-[70] border border-[var(--border)] bg-[var(--bg-panel)] py-1 shadow-[var(--shadow)]"
        >
          <div className="truncate border-b border-[var(--border)] px-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]">
            {target.node.label}
          </div>
          {items.map((item, index) => (
            <React.Fragment key={item.id}>
              {item.divider && <div className="my-1 h-px bg-[var(--border)]" />}
              <button
                type="button"
                role="menuitem"
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  onClose();
                  void item.run();
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1 text-left text-[13px]',
                  item.danger ? 'text-[var(--danger)]' : 'text-[var(--fg)]',
                  active === index && 'bg-[var(--bg-hover)]',
                )}
              >
                <span className={item.danger ? 'text-[var(--danger)]' : 'text-[var(--fg-muted)]'}>{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      <DropDialog
        target={dropping}
        onClose={() => setDropping(null)}
        onDropped={(t) => {
          // The object is gone: its parent level and the cached model both lie.
          onRefresh(t.segments.slice(0, -1));
          void client.invalidateQueries({ queryKey: ['schema', t.connectionId] });
        }}
      />

      <ImportDialog target={importing} onClose={() => setImporting(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Drop confirmation (§9: type the object's own name)
// ---------------------------------------------------------------------------

function DropDialog({
  target,
  onClose,
  onDropped,
}: {
  target: ObjectTarget | null;
  onClose: () => void;
  onDropped: (target: ObjectTarget) => void;
}) {
  if (!target) return null;
  const ref = objectRef(target.node);
  const sql = target.node.kind === 'key' || target.node.kind === 'mongo-index' ? null : dropSql(target);

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={target.node.kind === 'key' ? 'Delete key' : `Drop ${target.node.kind.replace('-', ' ')}`}
      confirmWord={target.node.label}
      onConfirm={() => {
        void performDrop(target)
          .then((message) => {
            toast.success(message);
            onDropped(target);
          })
          .catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'The drop failed.'));
      }}
      message={
        <div className="flex flex-col gap-2">
          <span>
            This permanently removes <strong>{ref.schema ? `${ref.schema}.${ref.name}` : ref.name}</strong> from{' '}
            <strong>{target.connection?.name ?? 'this connection'}</strong>. It cannot be undone.
          </span>
          {sql && <pre className="mono overflow-x-auto bg-[var(--bg-subtle)] p-2 text-[var(--fg-muted)]">{sql}</pre>}
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Built-in import fallback (§7.3/§7.4) — used when no wizard is mounted
// ---------------------------------------------------------------------------

const IMPORT_KINDS = ['csv', 'json', 'ndjson', 'sql', 'dump'] as const;
type ImportKind = (typeof IMPORT_KINDS)[number];

function kindFromPath(value: string): ImportKind {
  const ext = value.slice(value.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'tsv' || ext === 'csv') return 'csv';
  if (ext === 'ndjson' || ext === 'jsonl') return 'ndjson';
  if (ext === 'json') return 'json';
  if (ext === 'sql') return 'sql';
  return 'dump';
}

function ImportDialog({ target, onClose }: { target: ObjectTarget | null; onClose: () => void }) {
  const [path, setPath] = React.useState('');
  const [kind, setKind] = React.useState<ImportKind>('csv');
  const [onConflict, setOnConflict] = React.useState<'insert' | 'upsert' | 'replace' | 'ignore'>('insert');
  const [truncateFirst, setTruncate] = React.useState(false);
  const [dryRun, setDryRun] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (target) {
      setPath('');
      setKind('csv');
      setOnConflict('insert');
      setTruncate(false);
      setDryRun(false);
    }
  }, [target]);

  if (!target) return null;
  const ref = objectRef(target.node);

  async function start(): Promise<void> {
    if (!target) return;
    setBusy(true);
    try {
      const res = await api.post<{ jobId: string }>('/api/import', {
        connectionId: target.connectionId,
        source: { kind, path },
        target: { schema: ref.schema, table: ref.name },
        options: { onConflict, truncateFirst, dryRun },
      });
      // §7.3: it is a job, so progress belongs to the drawer, not to a spinner.
      useWorkspaceStore.getState().setBottomTab('jobs');
      toast.success(`Import started (job ${res.jobId.slice(0, 8)})`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the import.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      width="sm"
      title={`Import into ${ref.schema ? `${ref.schema}.${ref.name}` : ref.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={path.trim() === ''} onClick={() => void start()}>
            Start import
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="File on the server"
          hint="A path inside the configured exports/SQLite directory — the file is streamed straight into the engine, never uploaded through the browser."
        >
          <Input
            autoFocus
            value={path}
            placeholder="/data/exports/users.csv"
            onChange={(e) => {
              setPath(e.target.value);
              setKind(kindFromPath(e.target.value));
            }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Format">
            <Select value={kind} onChange={(e) => setKind(e.target.value as ImportKind)}>
              {IMPORT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="On conflict">
            <Select
              value={onConflict}
              onChange={(e) => setOnConflict(e.target.value as typeof onConflict)}
              disabled={kind === 'sql' || kind === 'dump'}
            >
              <option value="insert">insert</option>
              <option value="upsert">upsert</option>
              <option value="replace">replace</option>
              <option value="ignore">ignore</option>
            </Select>
          </Field>
        </div>
        <Checkbox
          label="Truncate the table first"
          checked={truncateFirst}
          onChange={(e) => setTruncate(e.target.checked)}
        />
        <Checkbox label="Dry run (parse only, write nothing)" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
      </div>
    </Dialog>
  );
}
