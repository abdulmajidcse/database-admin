/**
 * SQL dump writer (PLAN §7.1 "SQL INSERTs", §7.4 pipeline, §7.5 restore rules).
 *
 * Emits an `INSERT` stream — single-row or multi-row batched — with an optional
 * `CREATE TABLE` prelude rendered from the canonical `TableModel` (§4). Two
 * things this file takes seriously:
 *
 *  - **Tagged cells are handled losslessly.** Every value comes from the wire
 *    format's lossless text (§6); binary becomes an engine-appropriate literal
 *    (Postgres bytea hex / `decode(…,'base64')`, MySQL `X'…'` / `FROM_BASE64`,
 *    SQLite `X'…'`) rather than a mangled string. Nothing is ever rendered by
 *    string-concatenating an identifier — that all goes through ../../db/sql/quote.
 *  - **Restore ordering** (§7.5): the table is created with its columns, primary
 *    key and checks, then the data loads, and only then do secondary indexes and
 *    foreign keys get built. That is roughly an order of magnitude faster and it
 *    sidesteps insertion-order dependencies.
 *
 * Server-side only: no React, no Next (§11).
 */

import { Transform } from 'node:stream';
import type {
  EngineKind,
  ColumnModel,
  ForeignKeyModel,
  IndexModel,
  TableModel,
} from '../../../lib/schema-model';
import type { ColumnMeta } from '../../../lib/results';
import { base64ToBytes, type Cell, type Row } from '../../../lib/wire';
import { quoteIdent, quoteLiteral, quoteQualified } from '../../db/sql/quote';

export type SqlBinaryEncoding = 'hex' | 'base64';
export type OnConflictStrategy = 'error' | 'ignore' | 'replace';
export type DumpContent = 'structure' | 'data' | 'both';

export interface SqlWriterOptions {
  engine: EngineKind;
  /** Target of the INSERTs. Taken from `model` when omitted. */
  table?: { schema?: string; name: string };
  /** Column order; rows are positional and must match it. */
  columns: ColumnMeta[];
  /** Canonical model — required for the CREATE TABLE prelude (§4). */
  model?: TableModel;
  /** Structure-only / data-only / both (§7.1). */
  content?: DumpContent;
  /** `DROP TABLE IF EXISTS` before the CREATE. */
  dropIfExists?: boolean;
  /** `IF NOT EXISTS` on the CREATE (MySQL/SQLite/Postgres all support it). */
  createIfNotExists?: boolean;
  /** Rows per INSERT statement; 1 emits one statement per row. */
  batchSize?: number;
  /**
   * Soft ceiling on one statement's length. MySQL rejects anything above
   * `max_allowed_packet` (4 MB by default), so a batch is flushed early when it
   * approaches this even if `batchSize` is not reached yet (§7.4).
   */
  maxStatementBytes?: number;
  binary?: SqlBinaryEncoding;
  onConflict?: OnConflictStrategy;
  /** Qualify the INSERT target with its schema. */
  qualifyNames?: boolean;
  /** Emit secondary indexes after the data (§7.5 restore ordering). */
  includeIndexes?: boolean;
  /** Emit foreign keys after the data. SQLite gets them inline instead. */
  includeForeignKeys?: boolean;
  /** `-- table …` banner comment before the section. */
  banner?: boolean;
}

interface ResolvedSqlOptions extends Required<Omit<SqlWriterOptions, 'model' | 'table'>> {
  model?: TableModel;
  table: { schema?: string; name: string };
}

function resolve(options: SqlWriterOptions): ResolvedSqlOptions {
  const table = options.table ?? (options.model ? { schema: options.model.schema, name: options.model.name } : undefined);
  if (!table) throw new Error('createSqlWriter: either `table` or `model` is required');
  return {
    engine: options.engine,
    columns: options.columns,
    model: options.model,
    table,
    content: options.content ?? 'both',
    dropIfExists: options.dropIfExists ?? false,
    createIfNotExists: options.createIfNotExists ?? false,
    batchSize: Math.max(1, options.batchSize ?? 200),
    maxStatementBytes: Math.max(4096, options.maxStatementBytes ?? 4 * 1024 * 1024),
    binary: options.binary ?? 'hex',
    onConflict: options.onConflict ?? 'error',
    qualifyNames: options.qualifyNames ?? true,
    includeIndexes: options.includeIndexes ?? true,
    includeForeignKeys: options.includeForeignKeys ?? true,
    banner: options.banner ?? true,
  };
}

const MYSQL_LIKE = new Set<EngineKind>(['mysql', 'mariadb']);
/** A numeric token safe to emit unquoted, keeping bigint/decimal precision. */
const NUMERIC_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const BIT_TOKEN = /^[01]+$/;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

/**
 * A binary literal for the engine. Hex is the portable default; base64 is
 * offered because it is a third of the size on the wire and every engine except
 * SQLite has a decoder for it (SQLite's `base64()` is an optional extension, so
 * it falls back to hex rather than emitting SQL the target cannot run).
 */
export function binaryLiteral(
  bytes: Uint8Array,
  engine: EngineKind,
  encoding: SqlBinaryEncoding,
  base64: string,
): string {
  switch (engine) {
    case 'postgres':
      // `'\x…'::bytea` is the hex input format; `decode()` sidesteps the
      // standard_conforming_strings question entirely for base64.
      return encoding === 'base64'
        ? `decode('${base64}', 'base64')`
        : `'\\x${toHex(bytes)}'::bytea`;
    case 'mysql':
    case 'mariadb':
      return encoding === 'base64' ? `FROM_BASE64('${base64}')` : `X'${toHex(bytes)}'`;
    case 'sqlite':
      return `X'${toHex(bytes)}'`;
    default:
      throw new Error(`binaryLiteral: engine "${engine}" has no SQL literal syntax`);
  }
}

/**
 * Text containing a NUL byte cannot go through `quoteLiteral` (no engine accepts
 * an embedded NUL in a text literal), and dropping the byte would silently
 * corrupt the dump — so it is written as bytes cast back to text.
 */
function nulSafeStringLiteral(value: string, engine: EngineKind): string {
  const hex = toHex(new TextEncoder().encode(value));
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return `CONVERT(X'${hex}' USING utf8mb4)`;
    case 'sqlite':
      return `CAST(X'${hex}' AS TEXT)`;
    default:
      // Postgres cannot store a NUL in text at all, so such a value cannot have
      // come out of one; failing loudly beats writing a dump that will not load.
      throw new Error(
        `sqlLiteral: value contains a NUL byte, which ${engine} cannot represent in a text literal`,
      );
  }
}

/** One cell as a SQL literal, preserving everything the wire format carried. */
export function sqlLiteral(
  cell: Cell,
  engine: EngineKind,
  encoding: SqlBinaryEncoding = 'hex',
): string {
  if (cell === null) return 'NULL';
  if (typeof cell === 'boolean' || typeof cell === 'number') return quoteLiteral(cell, engine);
  if (typeof cell === 'string') {
    return cell.includes('\u0000') ? nulSafeStringLiteral(cell, engine) : quoteLiteral(cell, engine);
  }

  switch (cell.$t) {
    case 'bytes':
      return binaryLiteral(base64ToBytes(cell.v), engine, encoding, cell.v);
    case 'bigint':
    case 'decimal':
    case 'decimal128':
      // Unquoted so the target keeps full precision; quoted if the driver ever
      // handed us something that is not a plain number (NaN, 'Infinity', …).
      return NUMERIC_TOKEN.test(cell.v) ? cell.v : quoteLiteral(cell.v, engine);
    case 'bit':
      if (!BIT_TOKEN.test(cell.v)) return quoteLiteral(cell.v, engine);
      if (MYSQL_LIKE.has(engine)) return `b'${cell.v}'`;
      if (engine === 'postgres') return `B'${cell.v}'`;
      return quoteLiteral(cell.v, engine); // SQLite has no bit type
    case 'unsupported':
      // There is no lossless text for these, so there is nothing honest to
      // write. Silently emitting NULL is exactly the corrupted dump §7.4 warns
      // about, so the export fails instead.
      throw new Error(
        `sqlLiteral: value of type "${cell.of ?? 'unsupported'}" cannot be represented as a SQL literal`,
      );
    default:
      // json / date / time / timestamp / interval / uuid / array / geo / objectid /
      // regex / document: the lossless text is the engine's own input syntax and
      // the column type drives the cast on insert.
      return cell.v.includes('\u0000')
        ? nulSafeStringLiteral(cell.v, engine)
        : quoteLiteral(cell.v, engine);
  }
}

// ---------------------------------------------------------------------------
// DDL rendering from the canonical model (§4)
// ---------------------------------------------------------------------------

function renderColumn(col: ColumnModel, model: TableModel, engine: EngineKind): string {
  const parts = [quoteIdent(col.name, engine), col.type.raw];

  const singleIntegerPk =
    engine === 'sqlite' &&
    model.primaryKey.length === 1 &&
    model.primaryKey[0] === col.name &&
    /^integer$/i.test(col.type.raw.trim());

  if (col.collation && engine !== 'sqlite') parts.push(`COLLATE ${quoteIdent(col.collation, engine)}`);
  if (col.collation && engine === 'sqlite') parts.push(`COLLATE ${col.collation}`);

  if (col.generatedExpression) {
    const storage = col.generated === 'virtual' ? 'VIRTUAL' : 'STORED';
    // Postgres only has stored generated columns.
    parts.push(
      engine === 'postgres'
        ? `GENERATED ALWAYS AS (${col.generatedExpression}) STORED`
        : `GENERATED ALWAYS AS (${col.generatedExpression}) ${storage}`,
    );
  }

  if (singleIntegerPk) {
    // SQLite only makes a column the rowid alias when PRIMARY KEY is inline on
    // an INTEGER column — a table-level PRIMARY KEY would change its semantics.
    parts.push('PRIMARY KEY');
    if (col.autoIncrement) parts.push('AUTOINCREMENT');
  }

  if (!col.nullable && !singleIntegerPk) parts.push('NOT NULL');
  if (col.defaultValue !== null && col.defaultValue !== undefined && !col.generatedExpression) {
    parts.push(`DEFAULT ${col.defaultValue}`);
  }
  if (col.autoIncrement && MYSQL_LIKE.has(engine)) parts.push('AUTO_INCREMENT');
  if (col.comment && MYSQL_LIKE.has(engine)) parts.push(`COMMENT ${quoteLiteral(col.comment, engine)}`);

  return parts.join(' ');
}

function referentialClause(fk: ForeignKeyModel, engine: EngineKind): string {
  const target = quoteQualified([engine === 'sqlite' ? undefined : fk.refSchema, fk.refTable], engine);
  let out =
    `FOREIGN KEY (${fk.columns.map((c) => quoteIdent(c, engine)).join(', ')}) ` +
    `REFERENCES ${target} (${fk.refColumns.map((c) => quoteIdent(c, engine)).join(', ')})`;
  if (fk.onDelete) out += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
  if (fk.onUpdate) out += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
  if (fk.deferrable && engine === 'postgres') out += ' DEFERRABLE INITIALLY DEFERRED';
  return out;
}

export interface CreateTableOptions {
  ifNotExists?: boolean;
  /**
   * Inline the foreign keys instead of emitting ALTER statements. Forced on for
   * SQLite, which cannot add a constraint to an existing table (§7.5).
   */
  inlineForeignKeys?: boolean;
}

/** `CREATE TABLE` for a canonical `TableModel` (§4). Views are not handled here. */
export function renderCreateTable(
  model: TableModel,
  engine: EngineKind,
  options: CreateTableOptions = {},
): string {
  const inlineFks = options.inlineForeignKeys ?? engine === 'sqlite';
  const name = quoteQualified([engine === 'sqlite' ? undefined : model.schema, model.name], engine);
  const body: string[] = model.columns
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((c) => renderColumn(c, model, engine));

  const rowidAlias =
    engine === 'sqlite' &&
    model.primaryKey.length === 1 &&
    model.columns.some(
      (c) => c.name === model.primaryKey[0] && /^integer$/i.test(c.type.raw.trim()),
    );

  if (model.primaryKey.length > 0 && !rowidAlias) {
    const cols = model.primaryKey.map((c) => quoteIdent(c, engine)).join(', ');
    // MySQL ignores primary-key constraint names; Postgres keeps them.
    const named = model.primaryKeyName && engine === 'postgres'
      ? `CONSTRAINT ${quoteIdent(model.primaryKeyName, engine)} `
      : '';
    body.push(`${named}PRIMARY KEY (${cols})`);
  }

  for (const check of model.checks) {
    body.push(`CONSTRAINT ${quoteIdent(check.name, engine)} CHECK (${check.expression})`);
  }

  if (inlineFks) {
    for (const fk of model.foreignKeys) {
      body.push(`CONSTRAINT ${quoteIdent(fk.name, engine)} ${referentialClause(fk, engine)}`);
    }
  }

  const head = `CREATE TABLE ${options.ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (`;
  let sql = `${head}\n  ${body.join(',\n  ')}\n)`;

  if (MYSQL_LIKE.has(engine)) {
    if (model.engine) sql += ` ENGINE=${model.engine}`;
    if (model.collation) {
      // The charset is the collation's prefix; setting both keeps utf8 vs
      // utf8mb4 from drifting on restore (§7.5 MySQL trap).
      const charset = model.collation.split('_')[0];
      sql += ` DEFAULT CHARSET=${charset} COLLATE=${model.collation}`;
    }
    if (model.comment) sql += ` COMMENT=${quoteLiteral(model.comment, engine)}`;
  }

  return `${sql};\n`;
}

/** `CREATE INDEX` for one non-primary index. */
export function renderCreateIndex(
  index: IndexModel,
  model: TableModel,
  engine: EngineKind,
): string {
  const table = quoteQualified([engine === 'sqlite' ? undefined : model.schema, model.name], engine);
  const parts = index.columns.map((c) => {
    let part = c.expression ? `(${c.expression})` : quoteIdent(c.name as string, engine);
    if (c.length && MYSQL_LIKE.has(engine) && c.name) part += `(${c.length})`;
    if (c.order) part += ` ${c.order.toUpperCase()}`;
    if (c.nulls && engine === 'postgres') part += ` NULLS ${c.nulls.toUpperCase()}`;
    return part;
  });

  const method = index.method?.toLowerCase();
  let kind = index.unique ? 'UNIQUE ' : '';
  let using = '';
  if (MYSQL_LIKE.has(engine)) {
    if (method === 'fulltext' || method === 'spatial') kind = `${method.toUpperCase()} `;
    else if (method === 'hash' || method === 'btree') using = ` USING ${method.toUpperCase()}`;
  } else if (engine === 'postgres' && method) {
    using = ` USING ${method}`;
  }

  const indexName = engine === 'postgres'
    ? quoteIdent(index.name, engine)
    : quoteQualified([engine === 'sqlite' ? model.schema : undefined, index.name], engine);

  // Postgres puts USING before the column list; MySQL after it.
  const head = `CREATE ${kind}INDEX ${indexName} ON ${table}`;
  const sql = engine === 'postgres'
    ? `${head}${using} (${parts.join(', ')})`
    : `${head} (${parts.join(', ')})${using}`;

  return `${sql}${index.predicate ? ` WHERE ${index.predicate}` : ''};\n`;
}

/** `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`. Not valid for SQLite. */
export function renderAddForeignKey(
  fk: ForeignKeyModel,
  model: TableModel,
  engine: EngineKind,
): string {
  const table = quoteQualified([model.schema, model.name], engine);
  return `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(fk.name, engine)} ${referentialClause(fk, engine)};\n`;
}

/** Postgres keeps comments in separate statements. */
function renderComments(model: TableModel, engine: EngineKind): string {
  if (engine !== 'postgres') return '';
  const table = quoteQualified([model.schema, model.name], engine);
  let out = '';
  if (model.comment) out += `COMMENT ON TABLE ${table} IS ${quoteLiteral(model.comment, engine)};\n`;
  for (const col of model.columns) {
    if (!col.comment) continue;
    out += `COMMENT ON COLUMN ${table}.${quoteIdent(col.name, engine)} IS ${quoteLiteral(col.comment, engine)};\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dump-level prelude / postlude (shared by a multi-table dump, §7.5)
// ---------------------------------------------------------------------------

export interface DumpWrapperOptions {
  /** One transaction around the whole restore. */
  transaction?: boolean;
  /**
   * Turn FK enforcement off for the load. Postgres needs superuser for
   * `session_replication_role`, and our ordering (data first, constraints last)
   * makes it unnecessary there anyway — so nothing is emitted for it (§7.5).
   */
  disableForeignKeyChecks?: boolean;
  header?: string;
}

export function renderDumpPrelude(engine: EngineKind, options: DumpWrapperOptions = {}): string {
  let out = options.header ? `-- ${options.header}\n` : '';
  if (options.disableForeignKeyChecks) {
    if (MYSQL_LIKE.has(engine)) out += 'SET FOREIGN_KEY_CHECKS=0;\n';
    else if (engine === 'sqlite') out += 'PRAGMA foreign_keys=OFF;\n';
  }
  if (options.transaction) out += MYSQL_LIKE.has(engine) ? 'START TRANSACTION;\n' : 'BEGIN;\n';
  return out;
}

export function renderDumpPostlude(engine: EngineKind, options: DumpWrapperOptions = {}): string {
  let out = '';
  if (options.transaction) out += 'COMMIT;\n';
  if (options.disableForeignKeyChecks) {
    if (MYSQL_LIKE.has(engine)) out += 'SET FOREIGN_KEY_CHECKS=1;\n';
    else if (engine === 'sqlite') out += 'PRAGMA foreign_keys=ON;\n';
  }
  return out;
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/**
 * `Row[]` chunks in, SQL text out. Batches rows into multi-row INSERTs, flushing
 * early when a statement approaches `maxStatementBytes`, and emits the DDL that
 * must follow the data (§7.5) from `_flush`.
 */
export class SqlWriter extends Transform {
  private readonly o: ResolvedSqlOptions;
  private readonly target: string;
  private readonly columnList: string;
  private readonly insertHead: string;
  private readonly conflictTail: string;
  private tuples: string[] = [];
  private pending = 0;
  private opened = false;

  constructor(options: SqlWriterOptions) {
    super({
      writableObjectMode: true,
      readableObjectMode: false,
      writableHighWaterMark: 2,
      readableHighWaterMark: 1 << 20,
    });
    this.o = resolve(options);
    const engine = this.o.engine;
    this.target = quoteQualified(
      [this.o.qualifyNames && engine !== 'sqlite' ? this.o.table.schema : undefined, this.o.table.name],
      engine,
    );
    this.columnList = this.o.columns.map((c) => quoteIdent(c.name, engine)).join(', ');

    // Conflict handling is a different syntax in all three engines (§7.4 import
    // knobs; the same strategies apply to a dump you intend to replay).
    let verb = 'INSERT INTO';
    let tail = '';
    if (this.o.onConflict === 'ignore') {
      if (MYSQL_LIKE.has(engine)) verb = 'INSERT IGNORE INTO';
      else if (engine === 'sqlite') verb = 'INSERT OR IGNORE INTO';
      else tail = ' ON CONFLICT DO NOTHING';
    } else if (this.o.onConflict === 'replace') {
      if (MYSQL_LIKE.has(engine)) verb = 'REPLACE INTO';
      else if (engine === 'sqlite') verb = 'INSERT OR REPLACE INTO';
      else tail = this.postgresUpsertTail();
    }
    this.insertHead = `${verb} ${this.target} (${this.columnList}) VALUES\n`;
    this.conflictTail = tail;
  }

  /** Postgres has no REPLACE; an upsert needs an explicit conflict target. */
  private postgresUpsertTail(): string {
    const key = this.o.model?.primaryKey ?? [];
    if (key.length === 0) return ' ON CONFLICT DO NOTHING';
    const engine = this.o.engine;
    const updates = this.o.columns
      .filter((c) => !key.includes(c.name))
      .map((c) => `${quoteIdent(c.name, engine)} = EXCLUDED.${quoteIdent(c.name, engine)}`);
    const conflict = key.map((c) => quoteIdent(c, engine)).join(', ');
    if (updates.length === 0) return ` ON CONFLICT (${conflict}) DO NOTHING`;
    return ` ON CONFLICT (${conflict}) DO UPDATE SET ${updates.join(', ')}`;
  }

  private open(): string {
    if (this.opened) return '';
    this.opened = true;
    let out = '';
    if (this.o.banner) {
      const label = this.o.table.schema ? `${this.o.table.schema}.${this.o.table.name}` : this.o.table.name;
      out += `\n--\n-- Table: ${label}\n--\n`;
    }
    if (this.o.content !== 'data') {
      if (!this.o.model) {
        // An ad-hoc result set has no DDL to render (§7.1 result-set scope), so
        // "both" degrades to data. Asking for structure alone is a real error:
        // it would produce an empty file.
        if (this.o.content === 'structure') {
          throw new Error('SqlWriter: a structure export needs the canonical TableModel');
        }
      } else {
        if (this.o.dropIfExists) {
          out += `DROP TABLE IF EXISTS ${this.target}${this.o.engine === 'postgres' ? ' CASCADE' : ''};\n`;
        }
        out += renderCreateTable(this.o.model, this.o.engine, {
          ifNotExists: this.o.createIfNotExists,
        });
      }
    }
    return out;
  }

  private flushBatch(): string {
    if (this.tuples.length === 0) return '';
    const sql = this.insertHead + this.tuples.join(',\n') + this.conflictTail + ';\n';
    this.tuples = [];
    this.pending = 0;
    return sql;
  }

  override _transform(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (!Array.isArray(chunk)) {
      cb(new TypeError('SqlWriter expects Row[] chunks'));
      return;
    }
    if (this.o.content === 'structure') {
      // Structure-only: rows are ignored rather than silently written.
      cb();
      return;
    }
    try {
      let out = this.open();
      for (const row of chunk as Row[]) {
        const values = this.o.columns
          .map((_c, i) => sqlLiteral(row[i] === undefined ? null : row[i], this.o.engine, this.o.binary))
          .join(', ');
        const tuple = `  (${values})`;
        this.tuples.push(tuple);
        this.pending += tuple.length + 2;
        if (this.tuples.length >= this.o.batchSize || this.pending >= this.o.maxStatementBytes) {
          out += this.flushBatch();
        }
      }
      if (out.length > 0) this.push(out);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: (e?: Error | null) => void): void {
    try {
      let out = this.open() + this.flushBatch();
      const model = this.o.model;
      if (model && this.o.content !== 'data') {
        // Indexes and FKs go *after* the data (§7.5 restore ordering).
        if (this.o.includeIndexes) {
          for (const index of model.indexes) {
            if (index.primary) continue;
            // A unique constraint backing the primary key is already in the CREATE.
            out += renderCreateIndex(index, model, this.o.engine);
          }
        }
        if (this.o.includeForeignKeys && this.o.engine !== 'sqlite') {
          for (const fk of model.foreignKeys) out += renderAddForeignKey(fk, model, this.o.engine);
        }
        out += renderComments(model, this.o.engine);
      }
      if (out.length > 0) this.push(out);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

export function createSqlWriter(options: SqlWriterOptions): SqlWriter {
  return new SqlWriter(options);
}
