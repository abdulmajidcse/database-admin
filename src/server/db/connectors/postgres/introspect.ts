/**
 * Postgres introspection into the canonical `SchemaModel` (PLAN §8.3).
 *
 * The hard requirement: a **fixed** number of round trips regardless of how many
 * tables the schema has. A per-table `\d`-style loop is 500 round trips on a
 * 500-table schema — under 2 s locally, over 90 s on a 180 ms link. So this
 * module issues nine set-based `pg_catalog` queries (six for a shallow pass),
 * fires them concurrently across the pool, and assembles the model in JS.
 *
 * Everything comes back as text because the connector installs identity type
 * parsers (see `./types`), so booleans are `'t'`/`'f'` and arrays are `{a,b}`.
 */

import type {
  CheckModel,
  ColumnModel,
  EnumTypeModel,
  ForeignKeyModel,
  IndexColumn,
  IndexModel,
  IntrospectScope,
  ReferentialAction,
  RoutineModel,
  SchemaModel,
  SchemaNamespace,
  SequenceModel,
  TableKind,
  TableModel,
  TriggerModel,
} from '../../../../lib/schema-model';
import { parsePgArray, pgTypeDescriptor } from './types';

export type PgRow = Record<string, string | null>;
export type PgQueryFn = (sql: string, params?: unknown[]) => Promise<PgRow[]>;

export interface PgIntrospectOptions {
  scope: IntrospectScope;
  query: PgQueryFn;
  serverVersion: string;
  /** `server_version_num`, e.g. 160002. Drives the catalog-column guards below. */
  serverVersionNum: number;
  /** Restrict to a single relation — used by `generateDdl`, not by the tree. */
  only?: { schema: string; name: string };
}

// ---------------------------------------------------------------------------
// Small text helpers (identity parsers mean everything arrives as a string).
// ---------------------------------------------------------------------------

const isTrue = (v: string | null): boolean => v === 't' || v === 'true' || v === 'y';
const num = (v: string | null): number | undefined => (v === null || v === '' ? undefined : Number(v));
const textArray = (v: string | null): string[] =>
  v === null ? [] : parsePgArray(v).map((e) => (typeof e === 'string' ? e : ''));

/**
 * One predicate shared by every query: `$1` is either NULL (all user schemas) or
 * the explicit list from the scope. `pg\_%` covers pg_catalog, pg_toast and the
 * per-backend pg_temp_N schemas in a single condition.
 */
const NS_PRED = `(($1::text[] IS NULL AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema')
       OR ($1::text[] IS NOT NULL AND n.nspname = ANY($1::text[])))`;

const REL_KINDS = `'{r,p,v,m,f}'::"char"[]`;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const Q_NAMESPACES = `
  SELECT current_database() AS db,
         n.nspname          AS name,
         pg_get_userbyid(n.nspowner) AS owner,
         obj_description(n.oid, 'pg_namespace') AS comment
    FROM pg_namespace n
   WHERE ${NS_PRED}
   ORDER BY n.nspname`;

function qRelations(versionNum: number): string {
  // relispartition / pg_get_partkeydef arrived in PG 10.
  const partitioning =
    versionNum >= 100000
      ? `CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid)
              WHEN c.relispartition THEN 'PARTITION ' || pg_get_expr(c.relpartbound, c.oid, true)
         END`
      : `NULL::text`;
  return `
  SELECT c.oid::text  AS relid,
         n.nspname     AS schema,
         c.relname     AS name,
         c.relkind::text AS kind,
         c.reltuples::bigint::text AS row_estimate,
         pg_total_relation_size(c.oid)::text AS size_bytes,
         obj_description(c.oid, 'pg_class') AS comment,
         am.amname     AS access_method,
         CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, true) END AS definition,
         ${partitioning} AS partitioning
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_am am ON am.oid = c.relam
   WHERE c.relkind = ANY(${REL_KINDS}) AND ${NS_PRED}
     AND ($2::text IS NULL OR c.relname = $2)
   ORDER BY n.nspname, c.relname`;
}

function qColumns(versionNum: number): string {
  // attgenerated (generated columns) arrived in PG 12, attidentity in PG 10.
  const generated = versionNum >= 120000 ? `a.attgenerated::text` : `''::text`;
  const identity = versionNum >= 100000 ? `a.attidentity::text` : `''::text`;
  return `
  SELECT a.attrelid::text AS relid,
         a.attnum::text   AS position,
         a.attname        AS name,
         format_type(a.atttypid, a.atttypmod) AS raw_type,
         t.typname        AS type_name,
         t.typtype::text  AS type_kind,
         t.typcategory::text AS type_category,
         tn.nspname       AS type_schema,
         et.typname       AS elem_type_name,
         bt.typname       AS base_type_name,
         a.atttypmod::text AS typmod,
         a.attndims::text AS dims,
         a.attnotnull     AS not_null,
         pg_get_expr(ad.adbin, ad.adrelid, true) AS default_expr,
         ${identity}      AS identity,
         ${generated}     AS generated,
         cl.collname      AS collation,
         col_description(a.attrelid, a.attnum) AS comment
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_namespace tn ON tn.oid = t.typnamespace
    LEFT JOIN pg_type et ON et.oid = NULLIF(t.typelem, 0)
    LEFT JOIN pg_type bt ON bt.oid = NULLIF(t.typbasetype, 0)
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    LEFT JOIN pg_collation cl ON cl.oid = NULLIF(a.attcollation, 0)
   WHERE a.attnum > 0 AND NOT a.attisdropped
     AND c.relkind = ANY(${REL_KINDS}) AND ${NS_PRED}
     AND ($2::text IS NULL OR c.relname = $2)
   ORDER BY a.attrelid, a.attnum`;
}

function qIndexes(versionNum: number): string {
  const keyAtts = versionNum >= 110000 ? `i.indnkeyatts::text` : `i.indnatts::text`;
  // int2vector has no unnest() and is 0-based when subscripted, so we go through
  // its text output — `1 2 5` — which is stable across every supported version.
  return `
  SELECT ic.oid::text  AS indexid,
         i.indrelid::text AS relid,
         n.nspname     AS schema,
         tc.relname    AS table_name,
         ic.relname    AS name,
         i.indisunique AS is_unique,
         i.indisprimary AS is_primary,
         am.amname     AS method,
         pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
         obj_description(ic.oid, 'pg_class') AS comment,
         ${keyAtts}    AS key_atts,
         k.ord::text   AS ord,
         k.attnum::text AS attnum,
         a.attname     AS column_name,
         CASE WHEN k.attnum = 0 THEN pg_get_indexdef(i.indexrelid, k.ord::int, true) END AS expression,
         (string_to_array(i.indoption::text, ' ')::int[])[k.ord::int]::text AS option
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = tc.relnamespace
    LEFT JOIN pg_am am ON am.oid = ic.relam
    LEFT JOIN LATERAL unnest(string_to_array(i.indkey::text, ' ')::int[])
              WITH ORDINALITY AS k(attnum, ord) ON true
    LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum AND NOT a.attisdropped
   WHERE i.indislive AND ${NS_PRED}
     AND ($2::text IS NULL OR tc.relname = $2)
   ORDER BY ic.oid, k.ord`;
}

const Q_CONSTRAINTS = `
  SELECT c.conname       AS name,
         c.contype::text  AS type,
         n.nspname        AS schema,
         tc.relname       AS table_name,
         c.condeferrable  AS deferrable,
         c.confupdtype::text AS on_update,
         c.confdeltype::text AS on_delete,
         pg_get_expr(c.conbin, c.conrelid, true) AS expression,
         pg_get_constraintdef(c.oid, true) AS definition,
         rn.nspname       AS ref_schema,
         rc.relname       AS ref_table,
         (SELECT array_agg(a.attname ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)::text AS columns,
         (SELECT array_agg(a.attname ORDER BY k.ord)
            FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)::text AS ref_columns
    FROM pg_constraint c
    JOIN pg_class tc ON tc.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = tc.relnamespace
    LEFT JOIN pg_class rc ON rc.oid = NULLIF(c.confrelid, 0)
    LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
   WHERE c.contype IN ('f', 'c') AND ${NS_PRED}
     AND ($2::text IS NULL OR tc.relname = $2)
   ORDER BY tc.relname, c.conname`;

const Q_ENUMS = `
  SELECT n.nspname AS schema,
         t.typname AS name,
         array_agg(e.enumlabel ORDER BY e.enumsortorder)::text AS values
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE ${NS_PRED}
   GROUP BY n.nspname, t.typname
   ORDER BY n.nspname, t.typname`;

function qRoutines(versionNum: number): string {
  // prokind replaced proisagg/proiswindow in PG 11.
  const kind =
    versionNum >= 110000
      ? `CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END`
      : `'function'::text`;
  const notAggregate =
    versionNum >= 110000 ? `p.prokind IN ('f', 'p')` : `NOT p.proisagg AND NOT p.proiswindow`;
  return `
  SELECT n.nspname AS schema,
         p.proname AS name,
         ${kind}   AS kind,
         l.lanname AS language,
         pg_get_function_arguments(p.oid) AS arguments,
         pg_get_function_result(p.oid)    AS return_type,
         pg_get_functiondef(p.oid)        AS definition,
         (p.provolatile = 'i')            AS deterministic,
         obj_description(p.oid, 'pg_proc') AS comment
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE ${NS_PRED} AND ${notAggregate}
     -- Skip functions owned by an extension: PostGIS alone adds ~1500 of them
     -- and none of them are part of the user's schema (§8.3).
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
   ORDER BY n.nspname, p.proname`;
}

const Q_SEQUENCES = `
  SELECT n.nspname AS schema,
         c.relname AS name,
         s.seqstart::text     AS start,
         s.seqincrement::text AS increment,
         s.seqmin::text       AS min_value,
         s.seqmax::text       AS max_value,
         s.seqcycle           AS cycle,
         CASE WHEN has_sequence_privilege(c.oid, 'SELECT')
              THEN pg_sequence_last_value(c.oid)::text END AS last_value,
         (SELECT dn.nspname || '.' || dc.relname || '.' || da.attname
            FROM pg_depend d
            JOIN pg_class dc ON dc.oid = d.refobjid
            JOIN pg_namespace dn ON dn.oid = dc.relnamespace
            JOIN pg_attribute da ON da.attrelid = d.refobjid AND da.attnum = d.refobjsubid
           WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
             AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
           LIMIT 1) AS owned_by
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_sequence s ON s.seqrelid = c.oid
   WHERE c.relkind = 'S' AND ${NS_PRED}
   ORDER BY n.nspname, c.relname`;

const Q_TRIGGERS = `
  SELECT n.nspname  AS schema,
         c.relname  AS table_name,
         t.tgname   AS name,
         t.tgtype::int::text AS tgtype,
         pg_get_expr(t.tgqual, t.tgrelid, true) AS condition,
         pg_get_triggerdef(t.oid, true) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND ${NS_PRED}
     AND ($2::text IS NULL OR c.relname = $2)
   ORDER BY c.relname, t.tgname`;

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const RELKIND_TO_TABLE_KIND: Record<string, TableKind> = {
  r: 'table',
  p: 'table',
  v: 'view',
  m: 'materialized_view',
  f: 'foreign_table',
};

const FK_ACTION: Record<string, ReferentialAction> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

export async function introspectPostgres(o: PgIntrospectOptions): Promise<SchemaModel> {
  const { query, scope, serverVersionNum } = o;
  const nsParam = scope.namespaces && scope.namespaces.length > 0 ? scope.namespaces : null;
  const onlyName = o.only?.name ?? null;
  const nsFilter = o.only ? [o.only.schema] : nsParam;

  const scoped: unknown[] = [nsFilter, onlyName];
  const nsOnly: unknown[] = [nsFilter];

  // Sequences and routines are not part of a single-table DDL request, and the
  // shallow pass skips them for a fast tree fill (IntrospectScope.shallow).
  const wantExtras = !scope.shallow && !o.only;
  const wantTriggers = !scope.shallow;

  const jobs: Promise<PgRow[]>[] = [
    query(Q_NAMESPACES, nsOnly),
    query(qRelations(serverVersionNum), scoped),
    query(qColumns(serverVersionNum), scoped),
    query(qIndexes(serverVersionNum), scoped),
    query(Q_CONSTRAINTS, scoped),
    query(Q_ENUMS, nsOnly),
  ];
  if (wantExtras) {
    jobs.push(query(qRoutines(serverVersionNum), nsOnly));
    if (serverVersionNum >= 100000) jobs.push(query(Q_SEQUENCES, nsOnly));
  }
  if (wantTriggers) jobs.push(query(Q_TRIGGERS, scoped));

  const results = await Promise.all(jobs);
  const roundTrips = jobs.length;

  let cursor = 0;
  const nsRows = results[cursor++];
  const relRows = results[cursor++];
  const colRows = results[cursor++];
  const idxRows = results[cursor++];
  const conRows = results[cursor++];
  const enumRows = results[cursor++];
  const routineRows = wantExtras ? results[cursor++] : [];
  const seqRows = wantExtras && serverVersionNum >= 100000 ? results[cursor++] : [];
  const trigRows = wantTriggers ? results[cursor++] : [];

  const database = nsRows.length > 0 ? (nsRows[0].db ?? undefined) : undefined;

  // --- enums first: column type descriptors need their labels -------------
  const enumsBySchema = new Map<string, EnumTypeModel[]>();
  const enumByKey = new Map<string, string[]>();
  for (const r of enumRows) {
    const schema = r.schema ?? '';
    const values = textArray(r.values);
    const model: EnumTypeModel = { name: r.name ?? '', schema, values };
    push(enumsBySchema, schema, model);
    enumByKey.set(`${schema}.${model.name}`, values);
  }

  // --- namespaces ---------------------------------------------------------
  const namespaces = new Map<string, SchemaNamespace>();
  const ensureNs = (name: string): SchemaNamespace => {
    let ns = namespaces.get(name);
    if (!ns) {
      ns = { name, tables: [], routines: [], sequences: [], triggers: [], enums: [] };
      namespaces.set(name, ns);
    }
    return ns;
  };
  for (const r of nsRows) {
    const ns = ensureNs(r.name ?? '');
    ns.owner = r.owner ?? undefined;
    ns.comment = r.comment ?? undefined;
  }
  for (const [schema, list] of enumsBySchema) ensureNs(schema).enums.push(...list);

  // --- relations ----------------------------------------------------------
  const tablesByRelid = new Map<string, TableModel>();
  const tablesByName = new Map<string, TableModel>();
  for (const r of relRows) {
    const schema = r.schema ?? '';
    const rowEstimate = num(r.row_estimate);
    const table: TableModel = {
      name: r.name ?? '',
      schema,
      kind: RELKIND_TO_TABLE_KIND[r.kind ?? 'r'] ?? 'table',
      columns: [],
      indexes: [],
      foreignKeys: [],
      checks: [],
      primaryKey: [],
      comment: r.comment ?? undefined,
      // reltuples is -1 on a relation that was never analyzed; do not pretend.
      rowEstimate: rowEstimate !== undefined && rowEstimate >= 0 ? rowEstimate : undefined,
      sizeBytes: num(r.size_bytes),
      engine: r.access_method ?? undefined,
      definition: r.definition ?? undefined,
      partitioning: r.partitioning ?? undefined,
    };
    tablesByRelid.set(r.relid ?? '', table);
    tablesByName.set(`${schema}.${table.name}`, table);
    ensureNs(schema).tables.push(table);
  }

  // --- columns ------------------------------------------------------------
  for (const r of colRows) {
    const table = tablesByRelid.get(r.relid ?? '');
    if (!table) continue;
    const typeSchema = r.type_schema ?? '';
    const elemTypeName = r.elem_type_name;
    const enumKey = `${typeSchema}.${elemTypeName ?? r.type_name ?? ''}`;
    const enumValues = enumByKey.get(enumKey);
    const generated = r.generated ?? '';
    const identity = r.identity ?? '';
    const defaultExpr = r.default_expr;

    const column: ColumnModel = {
      name: r.name ?? '',
      position: Number(r.position ?? 0),
      type: pgTypeDescriptor({
        raw: r.raw_type ?? '',
        typeName: r.type_name ?? '',
        typeKind: r.type_kind ?? 'b',
        typeCategory: r.type_category ?? '',
        elemTypeName,
        baseTypeName: r.base_type_name,
        typmod: Number(r.typmod ?? -1),
        dims: Number(r.dims ?? 0),
        enumValues,
      }),
      nullable: !isTrue(r.not_null),
      // A generated column stores its expression in pg_attrdef, not a default.
      defaultValue: generated === '' ? (defaultExpr ?? null) : null,
      collation: r.collation ?? undefined,
      comment: r.comment ?? undefined,
    };
    // GENERATED ... AS IDENTITY and the classic `nextval()` serial both count.
    if (identity === 'a' || identity === 'd' || (defaultExpr ?? '').startsWith('nextval(')) {
      column.autoIncrement = true;
    }
    if (generated === 's') {
      column.generated = 'stored';
      column.generatedExpression = defaultExpr ?? undefined;
    } else if (generated === 'v') {
      column.generated = 'virtual';
      column.generatedExpression = defaultExpr ?? undefined;
    }
    table.columns.push(column);
  }

  // --- indexes ------------------------------------------------------------
  interface IndexAcc {
    model: IndexModel;
    table: TableModel;
    keyAtts: number;
    parts: { ord: number; part: IndexColumn }[];
  }
  const indexAcc = new Map<string, IndexAcc>();
  for (const r of idxRows) {
    const table = tablesByRelid.get(r.relid ?? '');
    if (!table) continue;
    const id = r.indexid ?? '';
    let acc = indexAcc.get(id);
    if (!acc) {
      acc = {
        model: {
          name: r.name ?? '',
          columns: [],
          unique: isTrue(r.is_unique),
          primary: isTrue(r.is_primary),
          method: r.method ?? undefined,
          predicate: r.predicate ?? undefined,
          comment: r.comment ?? undefined,
        },
        table,
        keyAtts: Number(r.key_atts ?? 0),
        parts: [],
      };
      indexAcc.set(id, acc);
    }
    const ord = Number(r.ord ?? 0);
    if (ord === 0 || ord > acc.keyAtts) continue; // INCLUDE columns are not key parts
    const option = Number(r.option ?? 0);
    const part: IndexColumn = {};
    if (r.attnum === '0') part.expression = r.expression ?? undefined;
    else part.name = r.column_name ?? undefined;
    // pg_index.indoption bit 0 = DESC, bit 1 = NULLS FIRST.
    part.order = (option & 1) === 1 ? 'desc' : 'asc';
    part.nulls = (option & 2) === 2 ? 'first' : 'last';
    acc.parts.push({ ord, part });
  }
  for (const acc of indexAcc.values()) {
    acc.parts.sort((a, b) => a.ord - b.ord);
    acc.model.columns = acc.parts.map((p) => p.part);
    acc.table.indexes.push(acc.model);
    if (acc.model.primary) {
      acc.table.primaryKey = acc.model.columns.map((c) => c.name ?? '').filter((n) => n !== '');
      acc.table.primaryKeyName = acc.model.name;
    }
  }

  // --- constraints --------------------------------------------------------
  for (const r of conRows) {
    const table = tablesByName.get(`${r.schema ?? ''}.${r.table_name ?? ''}`);
    if (!table) continue;
    if (r.type === 'f') {
      const fk: ForeignKeyModel = {
        name: r.name ?? '',
        columns: textArray(r.columns),
        refSchema: r.ref_schema ?? undefined,
        refTable: r.ref_table ?? '',
        refColumns: textArray(r.ref_columns),
        onUpdate: FK_ACTION[r.on_update ?? 'a'],
        onDelete: FK_ACTION[r.on_delete ?? 'a'],
        deferrable: isTrue(r.deferrable),
      };
      table.foreignKeys.push(fk);
    } else {
      const check: CheckModel = {
        name: r.name ?? '',
        // conbin gives the bare predicate; the constraintdef wraps it in CHECK(...).
        expression: r.expression ?? stripCheck(r.definition ?? ''),
      };
      table.checks.push(check);
    }
  }

  // --- routines / sequences / triggers ------------------------------------
  for (const r of routineRows) {
    const routine: RoutineModel = {
      name: r.name ?? '',
      schema: r.schema ?? undefined,
      kind: r.kind === 'procedure' ? 'procedure' : 'function',
      language: r.language ?? undefined,
      returnType: r.return_type ?? undefined,
      arguments: r.arguments ?? undefined,
      definition: r.definition ?? undefined,
      deterministic: isTrue(r.deterministic),
      comment: r.comment ?? undefined,
    };
    ensureNs(r.schema ?? '').routines.push(routine);
  }

  for (const r of seqRows) {
    const seq: SequenceModel = {
      name: r.name ?? '',
      schema: r.schema ?? undefined,
      start: r.start ?? undefined,
      increment: r.increment ?? undefined,
      minValue: r.min_value ?? undefined,
      maxValue: r.max_value ?? undefined,
      cycle: isTrue(r.cycle),
      lastValue: r.last_value ?? undefined,
      ownedBy: r.owned_by ?? undefined,
    };
    ensureNs(r.schema ?? '').sequences.push(seq);
  }

  for (const r of trigRows) {
    const tgtype = Number(r.tgtype ?? 0);
    const events: TriggerModel['events'] = [];
    if (tgtype & 4) events.push('insert');
    if (tgtype & 8) events.push('delete');
    if (tgtype & 16) events.push('update');
    if (tgtype & 32) events.push('truncate');
    const trigger: TriggerModel = {
      name: r.name ?? '',
      schema: r.schema ?? undefined,
      table: r.table_name ?? '',
      // pg_trigger.tgtype bits: 1 ROW, 2 BEFORE, 64 INSTEAD OF.
      timing: tgtype & 64 ? 'instead of' : tgtype & 2 ? 'before' : 'after',
      events,
      orientation: tgtype & 1 ? 'row' : 'statement',
      condition: r.condition ?? undefined,
      statement: r.definition ?? undefined,
    };
    ensureNs(r.schema ?? '').triggers.push(trigger);
  }

  for (const ns of namespaces.values()) {
    ns.tables.sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    engine: 'postgres',
    serverVersion: o.serverVersion,
    database,
    namespaces: [...namespaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
    fetchedAt: Date.now(),
    roundTrips,
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** `CHECK ((a > 0))` → `(a > 0)`; used only when conbin was unreadable. */
function stripCheck(def: string): string {
  const m = /^CHECK\s*\(([\s\S]*)\)\s*(?:NO INHERIT)?$/i.exec(def.trim());
  return m ? m[1].trim() : def;
}
