/**
 * MySQL / MariaDB introspection into the canonical SchemaModel (PLAN §4, §8.3).
 *
 * THE RULE (PLAN §8.3): a *fixed* number of round trips, independent of table
 * count. A per-table `SHOW CREATE TABLE` loop is ~500 round trips on a 500-table
 * schema — under 2 s locally, over 90 s on a 180 ms link. So we issue exactly
 * one query per catalog view (TABLES, COLUMNS, STATISTICS, KEY_COLUMN_USAGE ⋈
 * REFERENTIAL_CONSTRAINTS, CHECK_CONSTRAINTS, ROUTINES, TRIGGERS) and assemble
 * the model in JS. `SchemaModel.roundTrips` reports what we actually spent; the
 * latency tests assert it does not grow with the schema.
 *
 * Every query runs against the same schema predicate, so they can be issued
 * concurrently — the wall clock is one RTT, not seven.
 */

import type {
  ColumnModel,
  ForeignKeyModel,
  IndexColumn,
  IndexModel,
  IntrospectScope,
  ReferentialAction,
  RoutineModel,
  SchemaModel,
  SchemaNamespace,
  TableKind,
  TableModel,
  TriggerModel,
} from '../../../../lib/schema-model';
import type { FlavorInfo } from './types';
import { isMariaJsonCheck, mysqlTypeDescriptor } from './types';

/** Catalog schemas we hide unless the user asks for them by name. */
export const SYSTEM_SCHEMAS = ['information_schema', 'performance_schema', 'mysql', 'sys'];

export interface IntrospectDeps {
  /** Runs one statement and returns object rows. Counts as one round trip. */
  query: <T>(sql: string, params: unknown[]) => Promise<T[]>;
  flavor: FlavorInfo;
  /** Used when the scope names no database. */
  defaultDatabase?: string;
}

// --- raw catalog row shapes ------------------------------------------------

interface TableRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  TABLE_TYPE: string;
  ENGINE: string | null;
  TABLE_ROWS: string | number | null;
  DATA_LENGTH: string | number | null;
  INDEX_LENGTH: string | number | null;
  TABLE_COLLATION: string | null;
  TABLE_COMMENT: string | null;
  CREATE_OPTIONS: string | null;
}

interface ColumnRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: number | string;
  COLUMN_DEFAULT: string | null;
  IS_NULLABLE: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string;
  CHARACTER_MAXIMUM_LENGTH: string | number | null;
  NUMERIC_PRECISION: string | number | null;
  NUMERIC_SCALE: string | number | null;
  DATETIME_PRECISION: string | number | null;
  CHARACTER_SET_NAME: string | null;
  COLLATION_NAME: string | null;
  COLUMN_KEY: string | null;
  EXTRA: string | null;
  COLUMN_COMMENT: string | null;
  GENERATION_EXPRESSION?: string | null;
}

interface StatisticRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: number | string;
  SEQ_IN_INDEX: number | string;
  COLUMN_NAME: string | null;
  COLLATION: string | null;
  SUB_PART: number | string | null;
  NULLABLE: string | null;
  INDEX_TYPE: string | null;
  INDEX_COMMENT: string | null;
  EXPRESSION?: string | null;
}

interface ForeignKeyRow {
  CONSTRAINT_NAME: string;
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: number | string;
  REFERENCED_TABLE_SCHEMA: string | null;
  REFERENCED_TABLE_NAME: string | null;
  REFERENCED_COLUMN_NAME: string | null;
  UPDATE_RULE: string | null;
  DELETE_RULE: string | null;
}

interface CheckRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  CHECK_CLAUSE: string;
}

interface RoutineRow {
  ROUTINE_SCHEMA: string;
  ROUTINE_NAME: string;
  ROUTINE_TYPE: string;
  DATA_TYPE: string | null;
  DTD_IDENTIFIER: string | null;
  ROUTINE_BODY: string | null;
  ROUTINE_DEFINITION: string | null;
  IS_DETERMINISTIC: string | null;
  ROUTINE_COMMENT: string | null;
}

interface TriggerRow {
  TRIGGER_SCHEMA: string;
  TRIGGER_NAME: string;
  EVENT_MANIPULATION: string;
  EVENT_OBJECT_SCHEMA: string;
  EVENT_OBJECT_TABLE: string;
  ACTION_TIMING: string;
  ACTION_ORIENTATION: string | null;
  ACTION_STATEMENT: string | null;
}

// --- helpers ---------------------------------------------------------------

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function key(schema: string, table: string): string {
  return `${schema}\u0000${table}`;
}

function referentialAction(rule: string | null): ReferentialAction | undefined {
  switch ((rule ?? '').toUpperCase()) {
    case 'CASCADE':
      return 'cascade';
    case 'SET NULL':
      return 'set null';
    case 'SET DEFAULT':
      return 'set default';
    case 'RESTRICT':
      return 'restrict';
    case 'NO ACTION':
      return 'no action';
    default:
      return undefined;
  }
}

function tableKindFor(tableType: string): TableKind | 'sequence' {
  switch (tableType.toUpperCase()) {
    case 'VIEW':
      return 'view';
    case 'SYSTEM VIEW':
      return 'system';
    case 'SEQUENCE':
      // MariaDB 10.3+ reports sequences through information_schema.TABLES.
      return 'sequence';
    default:
      // 'BASE TABLE', 'TEMPORARY' and MariaDB's 'SYSTEM VERSIONED' are all
      // ordinary tables to us — misclassifying a system-versioned table as a
      // view is the classic MariaDB bug (PLAN §4).
      return 'table';
  }
}

/** EXTRA carries auto_increment, generated-column kind and MariaDB's spellings. */
function parseExtra(extra: string | null): {
  autoIncrement: boolean;
  generated?: 'stored' | 'virtual';
} {
  const e = (extra ?? '').toUpperCase();
  const autoIncrement = e.includes('AUTO_INCREMENT');
  let generated: 'stored' | 'virtual' | undefined;
  if (e.includes('VIRTUAL')) generated = 'virtual';
  // MariaDB says PERSISTENT where MySQL says STORED GENERATED.
  else if (e.includes('STORED') || e.includes('PERSISTENT')) generated = 'stored';
  return { autoIncrement, generated };
}

function schemaPredicate(column: string, schemas: string[]): { sql: string; params: unknown[] } {
  if (schemas.length > 0) return { sql: `${column} IN (?)`, params: [schemas] };
  return { sql: `${column} NOT IN (?)`, params: [SYSTEM_SCHEMAS] };
}

// --- the introspection pass ------------------------------------------------

export async function introspectMysql(
  deps: IntrospectDeps,
  scope: IntrospectScope,
): Promise<SchemaModel> {
  const { flavor } = deps;
  const wanted = scope.namespaces?.length
    ? scope.namespaces
    : [scope.database ?? deps.defaultDatabase].filter((s): s is string => !!s);

  let roundTrips = 0;
  const run = async <T>(sql: string, params: unknown[]): Promise<T[]> => {
    roundTrips++;
    return deps.query<T>(sql, params);
  };

  const tablePred = schemaPredicate('t.TABLE_SCHEMA', wanted);
  const colPred = schemaPredicate('c.TABLE_SCHEMA', wanted);
  const statPred = schemaPredicate('s.TABLE_SCHEMA', wanted);
  const fkPred = schemaPredicate('k.TABLE_SCHEMA', wanted);
  const routinePred = schemaPredicate('r.ROUTINE_SCHEMA', wanted);
  const triggerPred = schemaPredicate('g.EVENT_OBJECT_SCHEMA', wanted);

  // GENERATION_EXPRESSION / EXPRESSION do not exist on older servers; asking for
  // them there is a hard error, so the column list is version-gated.
  const generationExpr = flavor.supportsGeneratedColumns ? ', c.GENERATION_EXPRESSION' : '';
  const indexExpr = flavor.supportsFunctionalIndexes ? ', s.EXPRESSION' : '';

  const tablesP = run<TableRow>(
    `SELECT t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_TYPE, t.ENGINE, t.TABLE_ROWS,
            t.DATA_LENGTH, t.INDEX_LENGTH, t.TABLE_COLLATION, t.TABLE_COMMENT, t.CREATE_OPTIONS
       FROM information_schema.TABLES t
      WHERE ${tablePred.sql}
      ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME`,
    tablePred.params,
  );

  const columnsP = run<ColumnRow>(
    `SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.ORDINAL_POSITION, c.COLUMN_DEFAULT,
            c.IS_NULLABLE, c.DATA_TYPE, c.COLUMN_TYPE, c.CHARACTER_MAXIMUM_LENGTH,
            c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.DATETIME_PRECISION, c.CHARACTER_SET_NAME,
            c.COLLATION_NAME, c.COLUMN_KEY, c.EXTRA, c.COLUMN_COMMENT${generationExpr}
       FROM information_schema.COLUMNS c
      WHERE ${colPred.sql}
      ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`,
    colPred.params,
  );

  const statsP = run<StatisticRow>(
    `SELECT s.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME, s.NON_UNIQUE, s.SEQ_IN_INDEX,
            s.COLUMN_NAME, s.COLLATION, s.SUB_PART, s.NULLABLE, s.INDEX_TYPE,
            s.INDEX_COMMENT${indexExpr}
       FROM information_schema.STATISTICS s
      WHERE ${statPred.sql}
      ORDER BY s.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME, s.SEQ_IN_INDEX`,
    statPred.params,
  );

  const fksP = run<ForeignKeyRow>(
    `SELECT k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION,
            k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
            r.UPDATE_RULE, r.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
        AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.REFERENCED_TABLE_NAME IS NOT NULL AND ${fkPred.sql}
      ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    fkPred.params,
  );

  // MySQL's CHECK_CONSTRAINTS has no TABLE_NAME (it lives in TABLE_CONSTRAINTS);
  // MariaDB's does. One query either way (PLAN §4 flavor divergence).
  const checksP: Promise<CheckRow[]> = flavor.supportsCheckConstraints
    ? flavor.flavor === 'mariadb'
      ? (() => {
          const p = schemaPredicate('cc.CONSTRAINT_SCHEMA', wanted);
          return run<CheckRow>(
            `SELECT cc.CONSTRAINT_SCHEMA AS TABLE_SCHEMA, cc.TABLE_NAME, cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
               FROM information_schema.CHECK_CONSTRAINTS cc
              WHERE ${p.sql}`,
            p.params,
          );
        })()
      : (() => {
          const p = schemaPredicate('tc.TABLE_SCHEMA', wanted);
          return run<CheckRow>(
            `SELECT tc.TABLE_SCHEMA, tc.TABLE_NAME, cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
               FROM information_schema.CHECK_CONSTRAINTS cc
               JOIN information_schema.TABLE_CONSTRAINTS tc
                 ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
                AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
              WHERE tc.CONSTRAINT_TYPE = 'CHECK' AND ${p.sql}`,
            p.params,
          );
        })()
    : Promise.resolve([]);

  // A shallow pass powers the tree only; skipping routines/triggers halves the
  // work on a cold expand (PLAN §8.3 "adaptive defaults").
  const routinesP: Promise<RoutineRow[]> = scope.shallow
    ? Promise.resolve([])
    : run<RoutineRow>(
        `SELECT r.ROUTINE_SCHEMA, r.ROUTINE_NAME, r.ROUTINE_TYPE, r.DATA_TYPE, r.DTD_IDENTIFIER,
                r.ROUTINE_BODY, r.ROUTINE_DEFINITION, r.IS_DETERMINISTIC, r.ROUTINE_COMMENT
           FROM information_schema.ROUTINES r
          WHERE ${routinePred.sql}
          ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME`,
        routinePred.params,
      );

  const triggersP: Promise<TriggerRow[]> = scope.shallow
    ? Promise.resolve([])
    : run<TriggerRow>(
        `SELECT g.TRIGGER_SCHEMA, g.TRIGGER_NAME, g.EVENT_MANIPULATION, g.EVENT_OBJECT_SCHEMA,
                g.EVENT_OBJECT_TABLE, g.ACTION_TIMING, g.ACTION_ORIENTATION, g.ACTION_STATEMENT
           FROM information_schema.TRIGGERS g
          WHERE ${triggerPred.sql}
          ORDER BY g.EVENT_OBJECT_SCHEMA, g.EVENT_OBJECT_TABLE, g.TRIGGER_NAME`,
        triggerPred.params,
      );

  const [tableRows, columnRows, statRows, fkRows, checkRows, routineRows, triggerRows] =
    await Promise.all([tablesP, columnsP, statsP, fksP, checksP, routinesP, triggersP]);

  // --- assemble ------------------------------------------------------------

  const namespaces = new Map<string, SchemaNamespace>();
  const nsFor = (name: string): SchemaNamespace => {
    let ns = namespaces.get(name);
    if (!ns) {
      ns = { name, tables: [], routines: [], sequences: [], triggers: [], enums: [] };
      namespaces.set(name, ns);
    }
    return ns;
  };
  for (const s of wanted) nsFor(s);

  const tables = new Map<string, TableModel>();
  for (const r of tableRows) {
    const ns = nsFor(r.TABLE_SCHEMA);
    const kind = tableKindFor(r.TABLE_TYPE);
    if (kind === 'sequence') {
      // Reading START/INCREMENT/last value means one SELECT per sequence, which
      // would make introspection O(sequences) round trips (PLAN §8.3). The names
      // are enough for the tree; the DDL view fetches details on demand.
      ns.sequences.push({ name: r.TABLE_NAME, schema: r.TABLE_SCHEMA });
      continue;
    }
    const table: TableModel = {
      name: r.TABLE_NAME,
      schema: r.TABLE_SCHEMA,
      kind,
      columns: [],
      indexes: [],
      foreignKeys: [],
      checks: [],
      primaryKey: [],
      comment: r.TABLE_COMMENT ?? undefined,
      rowEstimate: num(r.TABLE_ROWS),
      sizeBytes: (num(r.DATA_LENGTH) ?? 0) + (num(r.INDEX_LENGTH) ?? 0),
      engine: r.ENGINE ?? undefined,
      collation: r.TABLE_COLLATION ?? undefined,
    };
    if ((r.CREATE_OPTIONS ?? '').toLowerCase().includes('partitioned')) {
      table.partitioning = 'partitioned';
    }
    tables.set(key(r.TABLE_SCHEMA, r.TABLE_NAME), table);
    ns.tables.push(table);
  }

  for (const r of columnRows) {
    const table = tables.get(key(r.TABLE_SCHEMA, r.TABLE_NAME));
    if (!table) continue; // a sequence, or a table dropped between queries
    const extra = parseExtra(r.EXTRA);
    const column: ColumnModel = {
      name: r.COLUMN_NAME,
      position: Number(r.ORDINAL_POSITION),
      type: mysqlTypeDescriptor({
        dataType: r.DATA_TYPE,
        columnType: r.COLUMN_TYPE,
        charMaxLength: r.CHARACTER_MAXIMUM_LENGTH === null ? null : num(r.CHARACTER_MAXIMUM_LENGTH),
        numericPrecision: r.NUMERIC_PRECISION === null ? null : num(r.NUMERIC_PRECISION),
        numericScale: r.NUMERIC_SCALE === null ? null : num(r.NUMERIC_SCALE),
        datetimePrecision: r.DATETIME_PRECISION === null ? null : num(r.DATETIME_PRECISION),
      }),
      nullable: r.IS_NULLABLE === 'YES',
      defaultValue: r.COLUMN_DEFAULT,
      collation: r.COLLATION_NAME ?? undefined,
      charset: r.CHARACTER_SET_NAME ?? undefined,
      comment: r.COLUMN_COMMENT || undefined,
    };
    if (extra.autoIncrement) column.autoIncrement = true;
    if (extra.generated) {
      column.generated = extra.generated;
      const expr = r.GENERATION_EXPRESSION;
      if (expr) column.generatedExpression = expr;
    }
    table.columns.push(column);
  }

  // Indexes: one STATISTICS row per index *part*, already ordered by SEQ_IN_INDEX.
  const indexAcc = new Map<string, IndexModel>();
  for (const r of statRows) {
    const table = tables.get(key(r.TABLE_SCHEMA, r.TABLE_NAME));
    if (!table) continue;
    const id = `${key(r.TABLE_SCHEMA, r.TABLE_NAME)}\u0000${r.INDEX_NAME}`;
    let idx = indexAcc.get(id);
    if (!idx) {
      idx = {
        name: r.INDEX_NAME,
        columns: [],
        unique: Number(r.NON_UNIQUE) === 0,
        primary: r.INDEX_NAME === 'PRIMARY',
        method: r.INDEX_TYPE ?? undefined,
        comment: r.INDEX_COMMENT || undefined,
      };
      indexAcc.set(id, idx);
      table.indexes.push(idx);
    }
    const part: IndexColumn = {};
    if (r.COLUMN_NAME) part.name = r.COLUMN_NAME;
    if (r.EXPRESSION) part.expression = r.EXPRESSION;
    // COLLATION is 'A' (ascending), 'D' (descending) or NULL (unsorted/hash).
    if (r.COLLATION === 'A') part.order = 'asc';
    else if (r.COLLATION === 'D') part.order = 'desc';
    const sub = num(r.SUB_PART);
    if (sub !== undefined) part.length = sub;
    idx.columns.push(part);
  }

  for (const table of tables.values()) {
    const pk = table.indexes.find((i) => i.primary);
    if (pk) {
      table.primaryKey = pk.columns.map((c) => c.name ?? '').filter((n) => n !== '');
      table.primaryKeyName = pk.name;
    }
  }

  const fkAcc = new Map<string, ForeignKeyModel>();
  for (const r of fkRows) {
    const table = tables.get(key(r.TABLE_SCHEMA, r.TABLE_NAME));
    if (!table || !r.REFERENCED_TABLE_NAME || !r.REFERENCED_COLUMN_NAME) continue;
    const id = `${key(r.TABLE_SCHEMA, r.TABLE_NAME)}\u0000${r.CONSTRAINT_NAME}`;
    let fk = fkAcc.get(id);
    if (!fk) {
      fk = {
        name: r.CONSTRAINT_NAME,
        columns: [],
        refSchema: r.REFERENCED_TABLE_SCHEMA ?? undefined,
        refTable: r.REFERENCED_TABLE_NAME,
        refColumns: [],
        onUpdate: referentialAction(r.UPDATE_RULE),
        onDelete: referentialAction(r.DELETE_RULE),
      };
      fkAcc.set(id, fk);
      table.foreignKeys.push(fk);
    }
    fk.columns.push(r.COLUMN_NAME);
    fk.refColumns.push(r.REFERENCED_COLUMN_NAME);
  }

  for (const r of checkRows) {
    const table = tables.get(key(r.TABLE_SCHEMA, r.TABLE_NAME));
    if (!table) continue;
    // MariaDB has no JSON type: `col JSON` is LONGTEXT plus an auto-generated
    // `json_valid(col)` CHECK. Surface it as a JSON column and hide the
    // implementation-detail constraint (PLAN §4 flavor divergence).
    if (flavor.flavor === 'mariadb') {
      const jsonColumn = isMariaJsonCheck(r.CHECK_CLAUSE);
      if (jsonColumn) {
        const col = table.columns.find((c) => c.name === jsonColumn);
        if (col && col.type.base === 'text') {
          col.type = { raw: 'json', base: 'json' };
          continue;
        }
      }
    }
    table.checks.push({ name: r.CONSTRAINT_NAME, expression: r.CHECK_CLAUSE });
  }

  for (const r of routineRows) {
    const ns = nsFor(r.ROUTINE_SCHEMA);
    const routine: RoutineModel = {
      name: r.ROUTINE_NAME,
      schema: r.ROUTINE_SCHEMA,
      kind: r.ROUTINE_TYPE.toUpperCase() === 'FUNCTION' ? 'function' : 'procedure',
      language: r.ROUTINE_BODY ?? undefined,
      returnType: r.DTD_IDENTIFIER ?? undefined,
      definition: r.ROUTINE_DEFINITION ?? undefined,
      deterministic: r.IS_DETERMINISTIC === 'YES',
      comment: r.ROUTINE_COMMENT || undefined,
    };
    ns.routines.push(routine);
  }

  for (const r of triggerRows) {
    const ns = nsFor(r.EVENT_OBJECT_SCHEMA);
    const timing = r.ACTION_TIMING.toLowerCase();
    const event = r.EVENT_MANIPULATION.toLowerCase();
    const trigger: TriggerModel = {
      name: r.TRIGGER_NAME,
      schema: r.TRIGGER_SCHEMA,
      table: r.EVENT_OBJECT_TABLE,
      timing: timing === 'before' ? 'before' : timing === 'after' ? 'after' : 'instead of',
      events: [
        event === 'insert' || event === 'update' || event === 'delete' ? event : 'update',
      ],
      // MySQL and MariaDB only have FOR EACH ROW triggers.
      orientation: (r.ACTION_ORIENTATION ?? 'ROW').toLowerCase() === 'row' ? 'row' : 'statement',
      statement: r.ACTION_STATEMENT ?? undefined,
    };
    ns.triggers.push(trigger);
  }

  return {
    engine: flavor.flavor,
    serverVersion: flavor.versionText,
    database: scope.database ?? deps.defaultDatabase,
    namespaces: [...namespaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
    fetchedAt: Date.now(),
    roundTrips,
  };
}
