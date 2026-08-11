/**
 * The canonical, engine-neutral schema model (PLAN §4).
 *
 * Everything downstream — the tree, autocomplete, ER diagram, schema diff, DDL
 * generation, export — reads ONLY this model. Engine quirks stop at the
 * connector boundary. This is the single highest-leverage type in the project;
 * changing it after M1 means touching every connector.
 *
 * Shared by client and server: no Node, no React imports.
 */

import type { BaseType } from './wire';

export type EngineKind = 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'redis' | 'mongodb';

export const SQL_ENGINES: EngineKind[] = ['mysql', 'mariadb', 'postgres', 'sqlite'];

export interface TypeDescriptor {
  /** The engine's own spelling, e.g. `varchar(255)`, `numeric(10,2)`, `int8[]`. */
  raw: string;
  base: BaseType;
  length?: number;
  precision?: number;
  scale?: number;
  unsigned?: boolean;
  /** With timezone, for timestamp/time. */
  withTimezone?: boolean;
  /** For enum/set. */
  values?: string[];
  /** For arrays. */
  elementType?: TypeDescriptor;
  /** Postgres array dimensionality. */
  dimensions?: number;
}

export interface ColumnModel {
  name: string;
  position: number;
  type: TypeDescriptor;
  nullable: boolean;
  /** Raw default expression as the engine reports it, or null. */
  defaultValue: string | null;
  autoIncrement?: boolean;
  generated?: 'stored' | 'virtual';
  generatedExpression?: string;
  collation?: string;
  charset?: string;
  comment?: string;
}

export interface IndexColumn {
  /** Column name, or undefined when this part is an expression. */
  name?: string;
  expression?: string;
  order?: 'asc' | 'desc';
  /** Prefix length (MySQL). */
  length?: number;
  nulls?: 'first' | 'last';
}

export interface IndexModel {
  name: string;
  columns: IndexColumn[];
  unique: boolean;
  primary: boolean;
  /** btree | hash | gin | gist | fulltext | spatial | … engine-specific. */
  method?: string;
  /** Partial-index predicate (Postgres/SQLite). */
  predicate?: string;
  comment?: string;
}

export type ReferentialAction =
  | 'no action'
  | 'restrict'
  | 'cascade'
  | 'set null'
  | 'set default';

export interface ForeignKeyModel {
  name: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onUpdate?: ReferentialAction;
  onDelete?: ReferentialAction;
  deferrable?: boolean;
}

export interface CheckModel {
  name: string;
  expression: string;
}

export type TableKind = 'table' | 'view' | 'materialized_view' | 'foreign_table' | 'system';

export interface TableModel {
  name: string;
  schema?: string;
  kind: TableKind;
  columns: ColumnModel[];
  indexes: IndexModel[];
  foreignKeys: ForeignKeyModel[];
  checks: CheckModel[];
  /** Column names composing the primary key, in order. Empty when there is none. */
  primaryKey: string[];
  primaryKeyName?: string;
  comment?: string;
  /** Approximate row count from catalog statistics — never a COUNT(*). */
  rowEstimate?: number;
  sizeBytes?: number;
  /** MySQL storage engine, Postgres access method, etc. */
  engine?: string;
  collation?: string;
  /** View/materialized-view body. */
  definition?: string;
  partitioning?: string;
}

export interface RoutineModel {
  name: string;
  schema?: string;
  kind: 'function' | 'procedure';
  language?: string;
  returnType?: string;
  /** Rendered signature, e.g. `(a integer, b text)`. */
  arguments?: string;
  definition?: string;
  deterministic?: boolean;
  comment?: string;
}

export interface SequenceModel {
  name: string;
  schema?: string;
  start?: string;
  increment?: string;
  minValue?: string;
  maxValue?: string;
  cycle?: boolean;
  lastValue?: string;
  ownedBy?: string;
}

export interface TriggerModel {
  name: string;
  schema?: string;
  table: string;
  timing: 'before' | 'after' | 'instead of';
  events: ('insert' | 'update' | 'delete' | 'truncate')[];
  orientation?: 'row' | 'statement';
  condition?: string;
  statement?: string;
}

export interface EnumTypeModel {
  name: string;
  schema?: string;
  values: string[];
}

export interface SchemaNamespace {
  /** Postgres schema, MySQL database, SQLite attached-db alias, Mongo database. */
  name: string;
  owner?: string;
  comment?: string;
  tables: TableModel[];
  routines: RoutineModel[];
  sequences: SequenceModel[];
  triggers: TriggerModel[];
  enums: EnumTypeModel[];
}

export interface SchemaModel {
  engine: EngineKind;
  /** Server version string as reported. */
  serverVersion?: string;
  /** The database this model was introspected from, when the engine has one. */
  database?: string;
  namespaces: SchemaNamespace[];
  fetchedAt: number;
  /** Round trips the introspection actually took — asserted by the latency tests (§8.3). */
  roundTrips?: number;
}

/** Scope of an introspection request. */
export interface IntrospectScope {
  database?: string;
  /** When present, restrict to these namespaces. */
  namespaces?: string[];
  /** Skip routines/triggers/sequences for a fast tree-only pass. */
  shallow?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers used across the tree, autocomplete, ER diagram and differ.
// ---------------------------------------------------------------------------

export function findNamespace(model: SchemaModel, name: string): SchemaNamespace | undefined {
  return model.namespaces.find((n) => n.name === name);
}

export function findTable(
  model: SchemaModel,
  namespace: string | undefined,
  table: string,
): TableModel | undefined {
  for (const ns of model.namespaces) {
    if (namespace !== undefined && ns.name !== namespace) continue;
    const t = ns.tables.find((x) => x.name === table);
    if (t) return t;
  }
  return undefined;
}

export function allTables(model: SchemaModel): TableModel[] {
  return model.namespaces.flatMap((n) => n.tables);
}

/**
 * The unique key the grid needs to be editable (PLAN §6 "Grid editing").
 * Falls back to the first unique index with no nullable member.
 */
export function uniqueKeyFor(table: TableModel): string[] | null {
  if (table.primaryKey.length > 0) return table.primaryKey;
  const nullable = new Set(table.columns.filter((c) => c.nullable).map((c) => c.name));
  for (const idx of table.indexes) {
    if (!idx.unique) continue;
    const names = idx.columns.map((c) => c.name).filter((n): n is string => !!n);
    if (names.length !== idx.columns.length) continue; // expression index
    if (names.some((n) => nullable.has(n))) continue;
    return names;
  }
  return null;
}

export function qualifiedName(t: Pick<TableModel, 'name' | 'schema'>): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/** Stable identity for diffing and React keys. */
export function tableId(engine: EngineKind, schema: string | undefined, name: string): string {
  return `${engine}:${schema ?? ''}:${name}`;
}
