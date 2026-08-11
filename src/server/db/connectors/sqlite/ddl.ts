/**
 * SQLite DDL rendering and migration planning (PLAN §6 "SQLite's four traps", trap 3).
 *
 * `ALTER TABLE` in SQLite can only: RENAME TO (3.x), RENAME COLUMN (3.25+),
 * ADD COLUMN (with restrictions) and DROP COLUMN (3.35+). *Anything* else —
 * changing a type, nullability, default, primary key, foreign keys, checks or
 * table options — needs the official 12-step rebuild from
 * <https://sqlite.org/lang_altertable.html#otheralter>. `planTableDdl()` picks
 * the cheap path when it is legal and generates the rebuild otherwise.
 *
 * This module is PURE: no database handle, no Node built-ins. It is used from
 * the main thread (to render a script the user reviews before running) and by
 * tests. Executing the script is the worker's job.
 */

import type {
  ColumnModel,
  ForeignKeyModel,
  IndexModel,
  TableModel,
} from '../../../../lib/schema-model';

// ---------------------------------------------------------------------------
// Quoting (§9: identifiers we build never go through string concatenation)
// ---------------------------------------------------------------------------

/** SQLite identifier quoting. Double quotes, doubled to escape. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** SQLite string literal. Single quotes, doubled to escape. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Blob literal, the only lossless way to write bytes into SQL text (§6 wire format). */
export function quoteBlob(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `X'${hex}'`;
}

/** `"schema"."name"`, or just `"name"` when no schema is given. */
export function qualify(schema: string | undefined, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
}

/** `3.45.1` → true for (3,35,0). Used to gate DROP COLUMN / RENAME COLUMN. */
export function versionAtLeast(version: string, major: number, minor: number, patch = 0): boolean {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const v = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  const want = [major, minor, patch];
  for (let i = 0; i < 3; i++) {
    if (v[i] > want[i]) return true;
    if (v[i] < want[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Indexes SQLite created itself for a UNIQUE/PRIMARY KEY constraint are tagged
 * `method: 'auto'` by the introspector. They cannot be recreated with
 * CREATE INDEX (the `sqlite_` name prefix is reserved), so they are rendered as
 * table constraints instead.
 */
export function isAutoIndex(idx: IndexModel): boolean {
  return idx.method === 'auto' || idx.name.toLowerCase().startsWith('sqlite_autoindex');
}

function indexPart(part: { name?: string; expression?: string; order?: 'asc' | 'desc' }): string {
  const base = part.name ? quoteIdent(part.name) : (part.expression ?? 'NULL');
  return part.order === 'desc' ? `${base} DESC` : base;
}

export function renderColumn(c: ColumnModel, opts: { inlinePrimaryKey?: boolean } = {}): string {
  const parts: string[] = [quoteIdent(c.name)];
  const raw = c.type.raw.trim();
  if (raw) parts.push(raw);
  if (opts.inlinePrimaryKey) {
    parts.push('PRIMARY KEY');
    // AUTOINCREMENT is only legal inline on an INTEGER PRIMARY KEY.
    if (c.autoIncrement) parts.push('AUTOINCREMENT');
  }
  if (!c.nullable) parts.push('NOT NULL');
  if (c.collation) parts.push(`COLLATE ${c.collation}`);
  if (c.generated) {
    parts.push(
      `GENERATED ALWAYS AS (${c.generatedExpression ?? 'NULL'}) ${
        c.generated === 'stored' ? 'STORED' : 'VIRTUAL'
      }`,
    );
  } else if (c.defaultValue !== null && c.defaultValue !== undefined && c.defaultValue !== '') {
    // defaultValue is the raw expression as SQLite reports it; never re-quote it.
    parts.push(`DEFAULT ${c.defaultValue}`);
  }
  return parts.join(' ');
}

function renderForeignKey(fk: ForeignKeyModel): string {
  const parts: string[] = [];
  if (fk.name && !/^fk_auto_/.test(fk.name)) parts.push(`CONSTRAINT ${quoteIdent(fk.name)}`);
  parts.push(`FOREIGN KEY (${fk.columns.map(quoteIdent).join(', ')})`);
  parts.push(
    `REFERENCES ${qualify(undefined, fk.refTable)} (${fk.refColumns.map(quoteIdent).join(', ')})`,
  );
  if (fk.onUpdate && fk.onUpdate !== 'no action') parts.push(`ON UPDATE ${fk.onUpdate.toUpperCase()}`);
  if (fk.onDelete && fk.onDelete !== 'no action') parts.push(`ON DELETE ${fk.onDelete.toUpperCase()}`);
  if (fk.deferrable) parts.push('DEFERRABLE INITIALLY DEFERRED');
  return parts.join(' ');
}

/** Table options live in `TableModel.engine` for SQLite: `strict`, `without rowid`. */
function tableOptions(t: TableModel): string {
  const flags = (t.engine ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  if (flags.includes('without rowid')) out.push('WITHOUT ROWID');
  if (flags.includes('strict')) out.push('STRICT');
  return out.length ? ` ${out.join(', ')}` : '';
}

export function renderCreateTable(
  t: TableModel,
  opts: { name?: string; schema?: string; ifNotExists?: boolean } = {},
): string {
  const name = opts.name ?? t.name;
  const schema = opts.schema ?? t.schema;
  const items: string[] = [];

  // An INTEGER PRIMARY KEY AUTOINCREMENT column MUST be declared inline; every
  // other primary key is emitted as a named table constraint so the name survives.
  const inlinePk =
    t.primaryKey.length === 1 && t.columns.some((c) => c.name === t.primaryKey[0] && c.autoIncrement);

  for (const c of t.columns) {
    items.push(renderColumn(c, { inlinePrimaryKey: inlinePk && c.name === t.primaryKey[0] }));
  }

  if (t.primaryKey.length > 0 && !inlinePk) {
    const prefix = t.primaryKeyName ? `CONSTRAINT ${quoteIdent(t.primaryKeyName)} ` : '';
    items.push(`${prefix}PRIMARY KEY (${t.primaryKey.map(quoteIdent).join(', ')})`);
  }

  // UNIQUE constraints come back from introspection as auto-created unique
  // indexes; they must go back into the table body, not a CREATE INDEX.
  for (const idx of t.indexes) {
    if (!idx.unique || idx.primary || !isAutoIndex(idx)) continue;
    const cols = idx.columns.map(indexPart).join(', ');
    const prefix = idx.name && !idx.name.toLowerCase().startsWith('sqlite_')
      ? `CONSTRAINT ${quoteIdent(idx.name)} `
      : '';
    items.push(`${prefix}UNIQUE (${cols})`);
  }

  for (const ck of t.checks) {
    const prefix = ck.name ? `CONSTRAINT ${quoteIdent(ck.name)} ` : '';
    items.push(`${prefix}CHECK (${ck.expression})`);
  }
  for (const fk of t.foreignKeys) items.push(renderForeignKey(fk));

  const head = `CREATE TABLE ${opts.ifNotExists ? 'IF NOT EXISTS ' : ''}${qualify(schema, name)}`;
  return `${head} (\n  ${items.join(',\n  ')}\n)${tableOptions(t)}`;
}

export function renderCreateIndex(
  schema: string | undefined,
  table: string,
  idx: IndexModel,
): string {
  const cols = idx.columns.map(indexPart).join(', ');
  const where = idx.predicate ? ` WHERE ${idx.predicate}` : '';
  // The index is created in the same schema as its table; the table name in
  // `ON` is always unqualified (SQLite rejects a qualified name there).
  return `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${qualify(schema, idx.name)} ON ${quoteIdent(
    table,
  )} (${cols})${where}`;
}

export function renderDropIndex(schema: string | undefined, name: string): string {
  return `DROP INDEX IF EXISTS ${qualify(schema, name)}`;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

function sameType(a: ColumnModel, b: ColumnModel): boolean {
  return a.type.raw.trim().toUpperCase() === b.type.raw.trim().toUpperCase();
}

/** Everything except the name — used to spot a pure rename. */
function columnBodyEqual(a: ColumnModel, b: ColumnModel): boolean {
  return (
    sameType(a, b) &&
    a.nullable === b.nullable &&
    (a.defaultValue ?? null) === (b.defaultValue ?? null) &&
    !!a.autoIncrement === !!b.autoIncrement &&
    (a.generated ?? null) === (b.generated ?? null) &&
    (a.generatedExpression ?? null) === (b.generatedExpression ?? null) &&
    (a.collation ?? null) === (b.collation ?? null)
  );
}

function columnEqual(a: ColumnModel, b: ColumnModel): boolean {
  return a.name === b.name && columnBodyEqual(a, b);
}

function fkKey(fk: ForeignKeyModel): string {
  return [
    fk.columns.join(','),
    fk.refTable,
    fk.refColumns.join(','),
    fk.onUpdate ?? 'no action',
    fk.onDelete ?? 'no action',
    fk.deferrable ? 'd' : '',
  ].join('|');
}

function indexKey(i: IndexModel): string {
  return [
    i.name,
    i.unique ? 'u' : '',
    i.predicate ?? '',
    i.columns.map((c) => `${c.name ?? c.expression ?? ''}:${c.order ?? 'asc'}`).join(','),
  ].join('|');
}

export interface TableDiff {
  renamedTable: boolean;
  /** Column renames detected positionally (see `detectRenames`). */
  renames: { from: string; to: string }[];
  added: ColumnModel[];
  dropped: ColumnModel[];
  /** Columns whose definition changed — these always force a rebuild. */
  altered: string[];
  constraintsChanged: boolean;
  optionsChanged: boolean;
  droppedIndexes: IndexModel[];
  createdIndexes: IndexModel[];
}

/**
 * `ColumnModel` has no stable id, so a rename is indistinguishable from
 * drop+add by name alone. When the two tables have the same shape position for
 * position and only names differ, treat it as a rename — that keeps the cheap
 * `ALTER TABLE … RENAME COLUMN` path usable for the most common edit.
 */
function detectRenames(current: TableModel, desired: TableModel): { from: string; to: string }[] {
  if (current.columns.length !== desired.columns.length) return [];
  const renames: { from: string; to: string }[] = [];
  for (let i = 0; i < current.columns.length; i++) {
    const a = current.columns[i];
    const b = desired.columns[i];
    if (a.name === b.name) continue;
    if (!columnBodyEqual(a, b)) return [];
    // A "rename" onto a name that already exists elsewhere is really a reshuffle.
    if (current.columns.some((c) => c.name === b.name)) return [];
    renames.push({ from: a.name, to: b.name });
  }
  return renames;
}

export function diffTable(current: TableModel, desired: TableModel): TableDiff {
  const renames = detectRenames(current, desired);
  const renameMap = new Map(renames.map((r) => [r.from, r.to]));
  const currentByDesiredName = new Map<string, ColumnModel>();
  for (const c of current.columns) currentByDesiredName.set(renameMap.get(c.name) ?? c.name, c);

  const desiredNames = new Set(desired.columns.map((c) => c.name));
  const added: ColumnModel[] = [];
  const altered: string[] = [];
  for (const d of desired.columns) {
    const src = currentByDesiredName.get(d.name);
    if (!src) {
      added.push(d);
      continue;
    }
    if (!columnBodyEqual(src, d)) altered.push(d.name);
  }
  const dropped = current.columns.filter((c) => !desiredNames.has(renameMap.get(c.name) ?? c.name));

  const constraintsChanged =
    current.primaryKey.join(',') !== desired.primaryKey.join(',') ||
    current.foreignKeys.map(fkKey).sort().join(';') !== desired.foreignKeys.map(fkKey).sort().join(';') ||
    current.checks.map((c) => c.expression.trim()).sort().join(';') !==
      desired.checks.map((c) => c.expression.trim()).sort().join(';') ||
    // UNIQUE constraints live in the table body, so they are constraints, not indexes.
    current.indexes.filter(isAutoIndex).map(indexKey).sort().join(';') !==
      desired.indexes.filter(isAutoIndex).map(indexKey).sort().join(';');

  const optionsChanged = (current.engine ?? '') !== (desired.engine ?? '');

  const currentExplicit = current.indexes.filter((i) => !i.primary && !isAutoIndex(i));
  const desiredExplicit = desired.indexes.filter((i) => !i.primary && !isAutoIndex(i));
  const currentKeys = new Map(currentExplicit.map((i) => [indexKey(i), i]));
  const desiredKeys = new Map(desiredExplicit.map((i) => [indexKey(i), i]));
  const droppedIndexes = currentExplicit.filter((i) => !desiredKeys.has(indexKey(i)));
  const createdIndexes = desiredExplicit.filter((i) => !currentKeys.has(indexKey(i)));

  return {
    renamedTable: current.name !== desired.name,
    renames,
    added,
    dropped,
    altered,
    constraintsChanged,
    optionsChanged,
    droppedIndexes,
    createdIndexes,
  };
}

// ---------------------------------------------------------------------------
// Legality of the cheap ALTER paths
// ---------------------------------------------------------------------------

/** Returns the reason ADD COLUMN is illegal, or null when it is fine. */
export function addColumnBlocker(c: ColumnModel, desired: TableModel): string | null {
  if (desired.primaryKey.includes(c.name)) return 'the new column joins the PRIMARY KEY';
  if (desired.indexes.some((i) => i.unique && isAutoIndex(i) && i.columns.some((p) => p.name === c.name)))
    return 'the new column has a UNIQUE constraint';
  if (c.generated === 'stored') return 'STORED generated columns cannot be added in place';
  const def = (c.defaultValue ?? '').trim();
  if (!c.nullable && def === '') return 'a NOT NULL column needs a constant DEFAULT';
  if (/^CURRENT_(TIME|DATE|TIMESTAMP)$/i.test(def))
    return 'CURRENT_TIME/DATE/TIMESTAMP defaults are not allowed by ADD COLUMN';
  if (def !== '' && def.toUpperCase() !== 'NULL' && desired.foreignKeys.some((f) => f.columns.includes(c.name)))
    return 'a REFERENCES column may not have a non-NULL default';
  return null;
}

/** Returns the reason DROP COLUMN is illegal, or null when it is fine. */
export function dropColumnBlocker(
  c: ColumnModel,
  current: TableModel,
  sqliteVersion: string,
): string | null {
  if (!versionAtLeast(sqliteVersion, 3, 35, 0))
    return `DROP COLUMN needs SQLite 3.35.0 (server is ${sqliteVersion})`;
  if (current.primaryKey.includes(c.name)) return 'the column is part of the PRIMARY KEY';
  if (current.indexes.some((i) => i.columns.some((p) => p.name === c.name)))
    return 'the column is indexed';
  if (current.foreignKeys.some((f) => f.columns.includes(c.name))) return 'a foreign key uses the column';
  const mentions = (expr: string): boolean =>
    new RegExp(`(^|[^A-Za-z0-9_"])"?${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?($|[^A-Za-z0-9_"])`).test(expr);
  if (current.checks.some((ck) => mentions(ck.expression))) return 'a CHECK constraint references the column';
  if (current.columns.some((o) => o.generatedExpression && mentions(o.generatedExpression)))
    return 'a generated column references it';
  return null;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface DependentObject {
  name: string;
  sql: string;
}

/**
 * Everything the rebuild needs that the canonical `TableModel` does not carry:
 * triggers and views are schema-level objects, and the FK-enforcement state is
 * a connection setting the script has to restore.
 */
export interface RebuildContext {
  schema?: string;
  triggers: DependentObject[];
  views: DependentObject[];
  /** True when `PRAGMA foreign_keys` was ON, so step 12 turns it back on. */
  foreignKeysEnabled: boolean;
  sqliteVersion: string;
}

export const EMPTY_REBUILD_CONTEXT: RebuildContext = {
  triggers: [],
  views: [],
  foreignKeysEnabled: true,
  sqliteVersion: '3.0.0',
};

/**
 * The whole point of trap 3: return a runnable script, cheap ALTERs when SQLite
 * supports them and the full 12-step rebuild otherwise. Statements carry their
 * own `--` comments so the DDL preview reads like the SQLite manual's recipe.
 */
export function planTableDdl(
  current: TableModel | null,
  desired: TableModel,
  ctx: RebuildContext = EMPTY_REBUILD_CONTEXT,
): string[] {
  const schema = ctx.schema ?? desired.schema ?? current?.schema;

  if (!current) {
    const out = [renderCreateTable(desired, { schema })];
    for (const idx of desired.indexes) {
      if (idx.primary || isAutoIndex(idx)) continue;
      out.push(renderCreateIndex(schema, desired.name, idx));
    }
    return out;
  }

  const diff = diffTable(current, desired);
  const simple = planSimpleAlter(current, desired, diff, ctx);
  if (simple) return simple;
  return planRebuild(current, desired, diff, ctx);
}

/** Null when the change cannot be expressed with SQLite's real ALTER TABLE. */
export function planSimpleAlter(
  current: TableModel,
  desired: TableModel,
  diff: TableDiff,
  ctx: RebuildContext,
): string[] | null {
  if (diff.altered.length > 0 || diff.constraintsChanged || diff.optionsChanged) return null;
  if (diff.renames.length > 0 && !versionAtLeast(ctx.sqliteVersion, 3, 25, 0)) return null;
  for (const c of diff.added) if (addColumnBlocker(c, desired)) return null;
  for (const c of diff.dropped) if (dropColumnBlocker(c, current, ctx.sqliteVersion)) return null;

  // ADD COLUMN can only append; a new column in the middle changes ordinals and
  // therefore needs the rebuild.
  if (diff.added.length > 0) {
    const tail = desired.columns.slice(desired.columns.length - diff.added.length);
    if (tail.some((c, i) => c.name !== diff.added[i].name)) return null;
  }

  const schema = ctx.schema ?? current.schema;
  const out: string[] = [];
  let live = current.name;

  for (const r of diff.renames) {
    out.push(`ALTER TABLE ${qualify(schema, live)} RENAME COLUMN ${quoteIdent(r.from)} TO ${quoteIdent(r.to)}`);
  }
  for (const c of diff.dropped) {
    out.push(`ALTER TABLE ${qualify(schema, live)} DROP COLUMN ${quoteIdent(c.name)}`);
  }
  for (const c of diff.added) {
    out.push(`ALTER TABLE ${qualify(schema, live)} ADD COLUMN ${renderColumn(c)}`);
  }
  if (diff.renamedTable) {
    // RENAME TO takes an unqualified target name.
    out.push(`ALTER TABLE ${qualify(schema, live)} RENAME TO ${quoteIdent(desired.name)}`);
    live = desired.name;
  }
  for (const idx of diff.droppedIndexes) out.push(renderDropIndex(schema, idx.name));
  for (const idx of diff.createdIndexes) out.push(renderCreateIndex(schema, live, idx));

  return out.length > 0 ? out : [];
}

/**
 * The 12-step rebuild, verbatim from
 * <https://sqlite.org/lang_altertable.html#otheralter> (PLAN §6 trap 3).
 *
 * Two details that are easy to get wrong and silently corrupt data:
 *   - `PRAGMA foreign_keys` is a no-op inside a transaction, so step 1 and
 *     step 12 sit OUTSIDE the BEGIN/COMMIT.
 *   - since 3.25 `ALTER TABLE … RENAME TO` rewrites references to the table in
 *     other triggers/views, which fails while those objects are mid-rebuild;
 *     `legacy_alter_table` turns that rewriting off for the one rename we do.
 */
export function planRebuild(
  current: TableModel,
  desired: TableModel,
  diff: TableDiff,
  ctx: RebuildContext,
): string[] {
  const schema = ctx.schema ?? current.schema;
  const tmp = `${desired.name}_dbadmin_rebuild`;
  const out: string[] = [];

  out.push('-- Step 1: FK enforcement off (must be outside the transaction)\nPRAGMA foreign_keys = off');
  out.push('-- Step 2: everything below is atomic\nBEGIN');

  // Step 3 is "remember the dependent objects" — the caller captured them into
  // ctx. Views must be dropped up front or the DROP TABLE in step 6 leaves them
  // dangling and the rename in step 7 errors on them.
  for (const v of ctx.views) out.push(`-- Step 3: dependent view saved for recreation\nDROP VIEW IF EXISTS ${qualify(schema, v.name)}`);
  for (const t of ctx.triggers) out.push(`DROP TRIGGER IF EXISTS ${qualify(schema, t.name)}`);

  out.push(`-- Step 4: the new shape\n${renderCreateTable(desired, { name: tmp, schema })}`);

  const renameMap = new Map(diff.renames.map((r) => [r.to, r.from]));
  const currentNames = new Set(current.columns.map((c) => c.name));
  const destCols: string[] = [];
  const srcCols: string[] = [];
  const warnings: string[] = [];
  for (const d of desired.columns) {
    if (d.generated) continue; // generated columns cannot be inserted into
    const src = renameMap.get(d.name) ?? (currentNames.has(d.name) ? d.name : null);
    if (!src) {
      if (!d.nullable && (d.defaultValue === null || d.defaultValue === '')) {
        warnings.push(
          `-- WARNING: new column "${d.name}" is NOT NULL with no DEFAULT and no source column; this INSERT will fail until you give it a default`,
        );
      }
      continue;
    }
    destCols.push(quoteIdent(d.name));
    srcCols.push(quoteIdent(src));
  }
  const copy =
    destCols.length > 0
      ? `INSERT INTO ${qualify(schema, tmp)} (${destCols.join(', ')})\n  SELECT ${srcCols.join(
          ', ',
        )} FROM ${qualify(schema, current.name)}`
      : `-- no columns in common; nothing to copy\nSELECT 1`;
  out.push(`-- Step 5: copy the data${warnings.length ? '\n' + warnings.join('\n') : ''}\n${copy}`);

  out.push(`-- Step 6: drop the old table\nDROP TABLE ${qualify(schema, current.name)}`);
  out.push('PRAGMA legacy_alter_table = on');
  out.push(
    `-- Step 7: put the new table in its place\nALTER TABLE ${qualify(schema, tmp)} RENAME TO ${quoteIdent(
      desired.name,
    )}`,
  );
  out.push('PRAGMA legacy_alter_table = off');

  let first = true;
  for (const idx of desired.indexes) {
    if (idx.primary || isAutoIndex(idx)) continue;
    const head = first ? '-- Step 8: recreate indexes and triggers\n' : '';
    first = false;
    out.push(head + renderCreateIndex(schema, desired.name, idx));
  }
  for (const t of ctx.triggers) out.push((first ? '-- Step 8: recreate indexes and triggers\n' : '') + t.sql);
  for (const v of ctx.views) out.push(`-- Step 9: recreate dependent views\n${v.sql}`);

  out.push(
    `-- Step 10: prove no foreign key was broken by the rebuild\nPRAGMA ${
      schema ? `${quoteIdent(schema)}.` : ''
    }foreign_key_check`,
  );
  out.push('-- Step 11\nCOMMIT');
  if (ctx.foreignKeysEnabled) out.push('-- Step 12: restore FK enforcement\nPRAGMA foreign_keys = on');

  return out;
}

/** `DROP TABLE`, used by the DDL editor and by cross-engine copy. */
export function renderDropTable(schema: string | undefined, name: string): string {
  return `DROP TABLE IF EXISTS ${qualify(schema, name)}`;
}
