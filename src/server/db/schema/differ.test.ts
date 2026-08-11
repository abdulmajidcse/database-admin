/**
 * Unit tests for the canonical schema differ and the migration writer
 * (PLAN §13 "Unit: … canonical schema differ", milestone M8).
 *
 * Everything here is a hand-built `SchemaModel`: the differ is pure, so it can
 * be pinned down exactly without a container in sight. The migration tests care
 * most about ORDER — a script that is right but ordered wrong fails halfway and
 * leaves a half-migrated database.
 */

import { describe, expect, it } from 'vitest';

import type {
  ColumnModel,
  EngineKind,
  EnumTypeModel,
  ForeignKeyModel,
  IndexModel,
  RoutineModel,
  SchemaModel,
  SchemaNamespace,
  SequenceModel,
  TableModel,
} from '../../../lib/schema-model';
import type { BaseType } from '../../../lib/wire';
import { diffSchemas, hasChanges, type SchemaDiff, type TableDiffEntry } from './differ';
import { generateMigration, orderByDependency, renderMigrationScript } from './migration';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function col(
  name: string,
  position: number,
  raw: string,
  base: BaseType,
  extra: Partial<ColumnModel> = {},
): ColumnModel {
  return { name, position, type: { raw, base }, nullable: true, defaultValue: null, ...extra };
}

function table(name: string, columns: ColumnModel[], extra: Partial<TableModel> = {}): TableModel {
  return {
    name,
    schema: 'public',
    kind: 'table',
    columns,
    indexes: [],
    foreignKeys: [],
    checks: [],
    primaryKey: [],
    ...extra,
  };
}

function index(name: string, columns: string[], extra: Partial<IndexModel> = {}): IndexModel {
  return { name, columns: columns.map((c) => ({ name: c })), unique: false, primary: false, ...extra };
}

function fk(
  name: string,
  columns: string[],
  refTable: string,
  refColumns: string[],
  extra: Partial<ForeignKeyModel> = {},
): ForeignKeyModel {
  return { name, columns, refTable, refColumns, refSchema: 'public', ...extra };
}

function ns(name: string, tables: TableModel[], extra: Partial<SchemaNamespace> = {}): SchemaNamespace {
  return { name, tables, routines: [], sequences: [], triggers: [], enums: [], ...extra };
}

function model(engine: EngineKind, namespaces: SchemaNamespace[]): SchemaModel {
  return { engine, namespaces, fetchedAt: 0 };
}

/** The single table entry a one-table fixture produces. */
function only(diff: SchemaDiff): TableDiffEntry {
  return diff.namespaces[0].tables[0];
}

const usersTarget = table(
  'users',
  [
    col('id', 1, 'integer', 'integer', { nullable: false, autoIncrement: true }),
    col('name', 2, 'varchar(50)', 'string', { nullable: false }),
  ],
  { primaryKey: ['id'], primaryKeyName: 'users_pkey' },
);

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

describe('diffSchemas — columns', () => {
  it('reports two identical models as unchanged', () => {
    const a = model('postgres', [ns('public', [usersTarget])]);
    const b = model('postgres', [ns('public', [structuredClone(usersTarget)])]);
    const diff = diffSchemas(a, b);

    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(hasChanges(diff)).toBe(false);
    expect(only(diff).status).toBe('same');
    expect(only(diff).columns.map((c) => c.status)).toEqual(['same', 'same']);
  });

  it('marks a column present only in the source as added', () => {
    const source = table('users', [...usersTarget.columns, col('email', 3, 'varchar(255)', 'string')], {
      primaryKey: ['id'],
    });
    const diff = diffSchemas(model('postgres', [ns('public', [source])]), model('postgres', [ns('public', [usersTarget])]));

    const entry = only(diff);
    expect(entry.status).toBe('changed');
    const email = entry.columns.find((c) => c.name === 'email');
    expect(email?.status).toBe('added');
    expect(email?.target).toBeNull();
    expect(email?.source?.name).toBe('email');
    expect(entry.counts).toEqual({ added: 1, removed: 0, changed: 0 });
    // The summary counts objects, not columns: one table differs.
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  it('marks a column present only in the target as removed', () => {
    const source = table('users', [usersTarget.columns[0]], { primaryKey: ['id'] });
    const diff = diffSchemas(model('postgres', [ns('public', [source])]), model('postgres', [ns('public', [usersTarget])]));

    const name = only(diff).columns.find((c) => c.name === 'name');
    expect(name?.status).toBe('removed');
    expect(name?.source).toBeNull();
    expect(only(diff).counts).toEqual({ added: 0, removed: 1, changed: 0 });
  });

  it('lists every field that changed on a column', () => {
    const source = table(
      'users',
      [
        usersTarget.columns[0],
        col('name', 2, 'varchar(100)', 'string', {
          nullable: true,
          defaultValue: "'anon'::text",
          collation: 'C',
          comment: 'display name',
        }),
      ],
      { primaryKey: ['id'], primaryKeyName: 'users_pkey' },
    );
    const diff = diffSchemas(model('postgres', [ns('public', [source])]), model('postgres', [ns('public', [usersTarget])]));

    const name = only(diff).columns.find((c) => c.name === 'name');
    expect(name?.status).toBe('changed');
    expect(name?.fields.map((f) => f.field).sort()).toEqual([
      'collation',
      'comment',
      'default',
      'nullable',
      'type',
    ]);
    const type = name?.fields.find((f) => f.field === 'type');
    expect(type).toEqual({ field: 'type', source: 'varchar(100)', target: 'varchar(50)' });
    const nullable = name?.fields.find((f) => f.field === 'nullable');
    expect(nullable).toEqual({ field: 'nullable', source: 'NULL', target: 'NOT NULL' });
  });

  it('detects a type change on a hand-built model that has no raw spelling', () => {
    const a = table('t', [{ name: 'n', position: 1, type: { raw: '', base: 'integer' }, nullable: true, defaultValue: null }]);
    const b = table('t', [{ name: 'n', position: 1, type: { raw: '', base: 'bigint' }, nullable: true, defaultValue: null }]);
    const diff = diffSchemas(model('postgres', [ns('public', [a])]), model('postgres', [ns('public', [b])]));

    const fields = only(diff).columns[0].fields;
    expect(fields).toEqual([{ field: 'type', source: 'integer', target: 'bigint' }]);
  });

  it('honours ignoreCollation and ignoreComments', () => {
    const target = table('t', [col('a', 1, 'text', 'text', { collation: 'C', charset: 'utf8', comment: 'old' })]);
    const source = table('t', [col('a', 1, 'text', 'text', { collation: 'en_US', charset: 'latin1', comment: 'new' })]);
    const a = model('postgres', [ns('public', [source])]);
    const b = model('postgres', [ns('public', [target])]);

    expect(diffSchemas(a, b).namespaces[0].tables[0].status).toBe('changed');
    const ignored = diffSchemas(a, b, { ignoreCollation: true, ignoreComments: true });
    expect(ignored.namespaces[0].tables[0].status).toBe('same');
    expect(ignored.summary).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('matches identifiers case-insensitively under ignoreCase', () => {
    const source = table('Users', [col('ID', 1, 'integer', 'integer')]);
    const target = table('users', [col('id', 1, 'integer', 'integer')]);
    const a = model('mysql', [ns('app', [source])]);
    const b = model('mysql', [ns('app', [target])]);

    const sensitive = diffSchemas(a, b);
    expect(sensitive.summary).toEqual({ added: 1, removed: 1, changed: 0 });

    const folded = diffSchemas(a, b, { ignoreCase: true });
    expect(folded.summary).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(folded.namespaces[0].tables).toHaveLength(1);
  });

  it('reports a column order difference once, at the table level', () => {
    const source = table('t', [col('a', 1, 'text', 'text'), col('b', 2, 'text', 'text')]);
    const target = table('t', [col('b', 1, 'text', 'text'), col('a', 2, 'text', 'text')]);
    const diff = diffSchemas(model('postgres', [ns('public', [source])]), model('postgres', [ns('public', [target])]));

    const entry = only(diff);
    expect(entry.columnOrderChanged).toBe(true);
    expect(entry.fields.map((f) => f.field)).toEqual(['columnOrder']);
    expect(entry.columns.every((c) => c.status === 'same')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Indexes, foreign keys, checks, primary keys
// ---------------------------------------------------------------------------

describe('diffSchemas — indexes', () => {
  it('reports added, removed and changed indexes', () => {
    const target = table('t', [col('a', 1, 'text', 'text'), col('b', 2, 'text', 'text')], {
      indexes: [index('idx_stale', ['a']), index('idx_shape', ['a'])],
    });
    const source = table('t', [col('a', 1, 'text', 'text'), col('b', 2, 'text', 'text')], {
      indexes: [index('idx_shape', ['a', 'b'], { unique: true }), index('idx_new', ['b'])],
    });
    const diff = diffSchemas(model('postgres', [ns('public', [source])]), model('postgres', [ns('public', [target])]));

    const byName = new Map(only(diff).indexes.map((i) => [i.name, i] as const));
    expect(byName.get('idx_new')?.status).toBe('added');
    expect(byName.get('idx_stale')?.status).toBe('removed');
    expect(byName.get('idx_shape')?.status).toBe('changed');
    expect(byName.get('idx_shape')?.fields.map((f) => f.field).sort()).toEqual(['columns', 'unique']);
    expect(byName.get('idx_shape')?.fields.find((f) => f.field === 'columns')).toEqual({
      field: 'columns',
      source: 'a, b',
      target: 'a',
    });
  });

  it('treats an index rename as the same index under ignoreIndexNames', () => {
    const target = table('t', [col('a', 1, 'text', 'text')], { indexes: [index('users_a_idx', ['a'])] });
    const source = table('t', [col('a', 1, 'text', 'text')], { indexes: [index('idx_a', ['a'])] });
    const a = model('postgres', [ns('public', [source])]);
    const b = model('postgres', [ns('public', [target])]);

    expect(diffSchemas(a, b).namespaces[0].tables[0].indexes.map((i) => i.status).sort()).toEqual([
      'added',
      'removed',
    ]);
    const ignored = diffSchemas(a, b, { ignoreIndexNames: true });
    expect(ignored.namespaces[0].tables[0].indexes.map((i) => i.status)).toEqual(['same']);
    expect(hasChanges(ignored)).toBe(false);
  });

  it('does not report a missing access method as a difference', () => {
    const target = table('t', [col('a', 1, 'text', 'text')], { indexes: [index('i', ['a'], { method: 'btree' })] });
    const source = table('t', [col('a', 1, 'text', 'text')], { indexes: [index('i', ['a'])] });
    const diff = diffSchemas(model('postgres', [ns('public', [source])]), model('postgres', [ns('public', [target])]));
    expect(only(diff).indexes[0].status).toBe('same');
  });
});

describe('diffSchemas — foreign keys, checks and primary keys', () => {
  it('reports a changed referential action and a changed target', () => {
    const target = table('orders', [col('user_id', 1, 'integer', 'integer')], {
      foreignKeys: [fk('fk_orders_user', ['user_id'], 'users', ['id'])],
    });
    const source = table('orders', [col('user_id', 1, 'integer', 'integer')], {
      foreignKeys: [fk('fk_orders_user', ['user_id'], 'accounts', ['id'], { onDelete: 'cascade' })],
    });
    const diff = diffSchemas(model('postgres', [ns('public', [source])]), model('postgres', [ns('public', [target])]));

    const entry = only(diff).foreignKeys[0];
    expect(entry.status).toBe('changed');
    expect(entry.fields.map((f) => f.field).sort()).toEqual(['onDelete', 'references']);
    expect(entry.fields.find((f) => f.field === 'references')).toEqual({
      field: 'references',
      source: 'public.accounts (id)',
      target: 'public.users (id)',
    });
  });

  it('normalizes parentheses and whitespace before comparing a check', () => {
    const target = table('t', [col('a', 1, 'integer', 'integer')], {
      checks: [{ name: 'c_pos', expression: '((a > 0))' }],
    });
    const source = table('t', [col('a', 1, 'integer', 'integer')], {
      checks: [{ name: 'c_pos', expression: 'a  >  0' }],
    });
    const diff = diffSchemas(model('postgres', [ns('public', [source])]), model('postgres', [ns('public', [target])]));
    expect(only(diff).checks[0].status).toBe('same');
  });

  it('does not strip parentheses that are not a wrapper', () => {
    const target = table('t', [col('a', 1, 'integer', 'integer')], {
      checks: [{ name: 'c', expression: '(a > 0) AND (a < 9)' }],
    });
    const source = table('t', [col('a', 1, 'integer', 'integer')], {
      checks: [{ name: 'c', expression: '(a > 0) AND (a < 10)' }],
    });
    const diff = diffSchemas(model('postgres', [ns('public', [source])]), model('postgres', [ns('public', [target])]));
    expect(only(diff).checks[0].status).toBe('changed');
  });

  it('reports a primary key change at table level', () => {
    const target = table('t', [col('a', 1, 'integer', 'integer'), col('b', 2, 'integer', 'integer')], {
      primaryKey: ['a'],
      primaryKeyName: 't_pkey',
    });
    const source = table('t', [col('a', 1, 'integer', 'integer'), col('b', 2, 'integer', 'integer')], {
      primaryKey: ['a', 'b'],
      primaryKeyName: 't_pkey',
    });
    const diff = diffSchemas(model('postgres', [ns('public', [source])]), model('postgres', [ns('public', [target])]));

    expect(only(diff).primaryKey).toEqual({ source: ['a', 'b'], target: ['a'] });
    expect(only(diff).fields.find((f) => f.field === 'primaryKey')).toEqual({
      field: 'primaryKey',
      source: 'a, b',
      target: 'a',
    });
  });
});

// ---------------------------------------------------------------------------
// Namespaces, views and other objects
// ---------------------------------------------------------------------------

describe('diffSchemas — namespaces and other objects', () => {
  it('compares schema A against a differently named schema B', () => {
    const source = model('postgres', [ns('app_dev', [table('t', [col('a', 1, 'text', 'text')], { schema: 'app_dev' })])]);
    const target = model('postgres', [
      ns('app', [table('t', [col('a', 1, 'text', 'text')], { schema: 'app' })]),
      ns('other', []),
    ]);

    const naive = diffSchemas(source, target);
    expect(naive.summary.added + naive.summary.removed).toBeGreaterThan(0);

    const diff = diffSchemas(source, target, { namespaceMap: { app_dev: 'app' } });
    expect(diff.namespaces[0].sourceName).toBe('app_dev');
    expect(diff.namespaces[0].targetName).toBe('app');
    expect(diff.namespaces[0].status).toBe('same');
    // The unrelated `other` schema is then the only remaining difference.
    expect(diff.summary).toEqual({ added: 0, removed: 1, changed: 0 });
  });

  it('does not report a foreign key as changed just because the schema was remapped', () => {
    const source = model('postgres', [
      ns('dev', [
        table('orders', [col('u', 1, 'integer', 'integer')], {
          schema: 'dev',
          foreignKeys: [fk('fk_u', ['u'], 'users', ['id'], { refSchema: 'dev' })],
        }),
      ]),
    ]);
    const target = model('postgres', [
      ns('prod', [
        table('orders', [col('u', 1, 'integer', 'integer')], {
          schema: 'prod',
          foreignKeys: [fk('fk_u', ['u'], 'users', ['id'], { refSchema: 'prod' })],
        }),
      ]),
    ]);

    const diff = diffSchemas(source, target, { namespaceMap: { dev: 'prod' } });
    expect(diff.namespaces[0].tables[0].foreignKeys[0].status).toBe('same');
  });

  it('pairs the only namespace on each side automatically', () => {
    const source = model('mysql', [ns('app_dev', [table('t', [col('a', 1, 'int', 'integer')], { schema: 'app_dev' })])]);
    const target = model('mysql', [ns('app_prod', [table('t', [col('a', 1, 'int', 'integer')], { schema: 'app_prod' })])]);

    const diff = diffSchemas(source, target);
    expect(diff.namespaces).toHaveLength(1);
    expect(diff.namespaces[0].targetName).toBe('app_prod');
    expect(diff.notes.join(' ')).toContain('app_dev');
    expect(hasChanges(diff)).toBe(false);
  });

  it('counts an added namespace and everything in it', () => {
    const source = model('postgres', [
      ns('public', []),
      ns('audit', [table('log', [col('a', 1, 'text', 'text')], { schema: 'audit' })]),
    ]);
    const target = model('postgres', [ns('public', [])]);

    const diff = diffSchemas(source, target);
    const audit = diff.namespaces.find((n) => n.name === 'audit');
    expect(audit?.status).toBe('added');
    expect(audit?.tables[0].status).toBe('added');
    // one namespace + one table
    expect(diff.summary).toEqual({ added: 2, removed: 0, changed: 0 });
  });

  it('buckets views separately and compares their bodies modulo formatting', () => {
    const view = (definition: string): TableModel =>
      table('v_active', [col('id', 1, 'integer', 'integer')], { kind: 'view', definition });
    const source = model('postgres', [ns('public', [view('CREATE VIEW v_active AS SELECT id\n  FROM users;')])]);
    const target = model('postgres', [ns('public', [view('SELECT id FROM users')])]);

    const same = diffSchemas(source, target);
    expect(same.namespaces[0].tables).toHaveLength(0);
    expect(same.namespaces[0].views[0].status).toBe('same');

    const changed = diffSchemas(
      model('postgres', [ns('public', [view('SELECT id FROM users WHERE active')])]),
      target,
    );
    expect(changed.namespaces[0].views[0].fields.map((f) => f.field)).toEqual(['definition']);
  });

  it('compares routines, sequences and enums', () => {
    const routine: RoutineModel = { name: 'f', kind: 'function', language: 'sql', returnType: 'integer', arguments: '(a integer)', definition: 'SELECT a' };
    const sequence: SequenceModel = { name: 's', increment: '1', start: '1', lastValue: '41' };
    const enumType: EnumTypeModel = { name: 'mood', values: ['sad', 'ok'] };

    const source = model('postgres', [
      ns('public', [], {
        routines: [{ ...routine, definition: 'SELECT a + 1' }],
        sequences: [{ ...sequence, increment: '2', lastValue: '9999' }],
        enums: [{ ...enumType, values: ['sad', 'ok', 'happy'] }],
      }),
    ]);
    const target = model('postgres', [
      ns('public', [], { routines: [routine], sequences: [sequence], enums: [enumType] }),
    ]);

    const diff = diffSchemas(source, target);
    expect(diff.namespaces[0].routines[0].fields.map((f) => f.field)).toEqual(['definition']);
    // `lastValue` is runtime state and must never show up as a difference.
    expect(diff.namespaces[0].sequences[0].fields.map((f) => f.field)).toEqual(['increment']);
    expect(diff.namespaces[0].enums[0].fields.map((f) => f.field)).toEqual(['values']);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 3 });
  });

  it('notes a cross-engine comparison', () => {
    const diff = diffSchemas(model('mysql', [ns('app', [])]), model('postgres', [ns('app', [])]));
    expect(diff.notes.join(' ')).toContain('cross-engine');
  });
});

// ---------------------------------------------------------------------------
// Migration: ordering
// ---------------------------------------------------------------------------

/** dev vs prod: one altered table, one new table, one dropped table. */
function orderingFixture(): { source: SchemaModel; target: SchemaModel } {
  const usersProd = table(
    'users',
    [
      col('id', 1, 'integer', 'integer', { nullable: false }),
      col('name', 2, 'varchar(50)', 'string', { nullable: false }),
    ],
    { primaryKey: ['id'], primaryKeyName: 'users_pkey' },
  );
  const ordersProd = table(
    'orders',
    [col('id', 1, 'integer', 'integer', { nullable: false }), col('user_id', 2, 'integer', 'integer')],
    {
      primaryKey: ['id'],
      primaryKeyName: 'orders_pkey',
      indexes: [index('idx_orders_user', ['user_id'])],
      foreignKeys: [fk('fk_orders_user', ['user_id'], 'users', ['id'])],
    },
  );
  const legacyProd = table('legacy', [col('id', 1, 'integer', 'integer')]);

  const usersDev = table(
    'users',
    [
      col('id', 1, 'integer', 'integer', { nullable: false }),
      col('name', 2, 'varchar(100)', 'string', { nullable: false }),
      col('email', 3, 'varchar(255)', 'string'),
    ],
    { primaryKey: ['id'], primaryKeyName: 'users_pkey' },
  );
  const ordersDev = table(
    'orders',
    [
      col('id', 1, 'integer', 'integer', { nullable: false }),
      col('user_id', 2, 'integer', 'integer'),
      col('total', 3, 'numeric(10,2)', 'decimal'),
    ],
    {
      primaryKey: ['id'],
      primaryKeyName: 'orders_pkey',
      // same name, different shape → drop + recreate
      indexes: [index('idx_orders_user', ['user_id', 'total'])],
      // same name, different action → drop + recreate
      foreignKeys: [fk('fk_orders_user', ['user_id'], 'users', ['id'], { onDelete: 'cascade' })],
    },
  );
  const paymentsDev = table(
    'payments',
    [col('id', 1, 'integer', 'integer', { nullable: false }), col('order_id', 2, 'integer', 'integer')],
    {
      primaryKey: ['id'],
      indexes: [index('idx_payments_order', ['order_id'])],
      foreignKeys: [fk('fk_payments_order', ['order_id'], 'orders', ['id'])],
    },
  );

  return {
    source: model('postgres', [ns('public', [usersDev, ordersDev, paymentsDev])]),
    target: model('postgres', [ns('public', [usersProd, ordersProd, legacyProd])]),
  };
}

describe('generateMigration — ordering', () => {
  const { source, target } = orderingFixture();
  const diff = diffSchemas(source, target);
  const script = generateMigration(diff, 'postgres');
  const at = (needle: string | RegExp): number =>
    script.statements.findIndex((s) => (typeof needle === 'string' ? s.includes(needle) : needle.test(s)));

  it('emits only runnable statements, with no comment lines or terminators', () => {
    expect(script.statements.length).toBeGreaterThan(0);
    for (const s of script.statements) {
      expect(s.trimStart().startsWith('--')).toBe(false);
      expect(s.trimEnd().endsWith(';')).toBe(false);
    }
  });

  it('drops foreign keys before indexes, and both before anything is created', () => {
    const dropFk = at('DROP CONSTRAINT "fk_orders_user"');
    const dropIdx = at('DROP INDEX "public"."idx_orders_user"');
    const createTable = at('CREATE TABLE "public"."payments"');

    expect(dropFk).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(dropFk);
    expect(createTable).toBeGreaterThan(dropIdx);
  });

  it('creates and alters tables before recreating indexes, and recreates foreign keys last', () => {
    const createTable = at('CREATE TABLE "public"."payments"');
    const addColumn = at('ADD COLUMN "email"');
    const alterType = at('ALTER COLUMN "name" TYPE varchar(100)');
    const createIdx = at('CREATE INDEX "idx_orders_user"');
    const addFk = at('ADD CONSTRAINT "fk_orders_user" FOREIGN KEY');

    expect(addColumn).toBeGreaterThan(createTable);
    expect(alterType).toBeGreaterThan(createTable);
    expect(createIdx).toBeGreaterThan(addColumn);
    expect(createIdx).toBeGreaterThan(alterType);
    expect(addFk).toBeGreaterThan(createIdx);
  });

  it('creates a table before the foreign keys that reference it', () => {
    const createPayments = at('CREATE TABLE "public"."payments"');
    const paymentsFk = at('ADD CONSTRAINT "fk_payments_order" FOREIGN KEY');

    expect(createPayments).toBeGreaterThanOrEqual(0);
    expect(paymentsFk).toBeGreaterThan(createPayments);
    // The create itself must not carry the foreign key, or the order would only
    // work by luck.
    expect(script.statements[createPayments]).not.toContain('FOREIGN KEY');
    expect(script.statements[createPayments]).toContain('"order_id" integer');
  });

  it('keeps every destructive statement out of the safe list', () => {
    expect(script.statements.some((s) => /\bDROP TABLE\b/.test(s))).toBe(false);
    expect(script.statements.some((s) => /\bDROP COLUMN\b/.test(s))).toBe(false);
    expect(script.destructive).toContain('DROP TABLE "public"."legacy"');
    expect(script.sections.filter((s) => s.destructive).every((s) => s.title.startsWith('DESTRUCTIVE'))).toBe(true);
  });

  it('groups the statements into labelled sections in a fixed order', () => {
    expect(script.sections.map((s) => s.id)).toEqual([
      'drop-foreign-keys',
      'drop-indexes',
      'create-tables',
      'alter-tables',
      'create-indexes',
      'create-foreign-keys',
      'destructive-tables',
    ]);
    const flattened = script.sections.filter((s) => !s.destructive).flatMap((s) => s.statements);
    expect(flattened).toEqual(script.statements);
  });
});

// ---------------------------------------------------------------------------
// Migration: destructive handling and engines
// ---------------------------------------------------------------------------

describe('generateMigration — destructive section', () => {
  it('drops an incoming foreign key alongside the table drop it enables', () => {
    const target = model('postgres', [
      ns('public', [
        table('parent', [col('id', 1, 'integer', 'integer')], { primaryKey: ['id'] }),
        table('child', [col('parent_id', 1, 'integer', 'integer')], {
          foreignKeys: [fk('fk_child_parent', ['parent_id'], 'parent', ['id'])],
        }),
      ]),
    ]);
    // The source keeps `child` (with its foreign key) but has no `parent`.
    const source = model('postgres', [
      ns('public', [
        table('child', [col('parent_id', 1, 'integer', 'integer')], {
          foreignKeys: [fk('fk_child_parent', ['parent_id'], 'parent', ['id'])],
        }),
      ]),
    ]);

    const script = generateMigration(diffSchemas(source, target), 'postgres');
    const dropFk = script.destructive.findIndex((s) => s.includes('DROP CONSTRAINT "fk_child_parent"'));
    const dropTable = script.destructive.findIndex((s) => s.includes('DROP TABLE "public"."parent"'));

    expect(dropFk).toBeGreaterThanOrEqual(0);
    expect(dropTable).toBeGreaterThan(dropFk);
    // The safe list must stay runnable on its own.
    expect(script.statements.some((s) => s.includes('fk_child_parent'))).toBe(false);
  });

  it('drops children before parents', () => {
    const tables = [
      table('parent', [col('id', 1, 'integer', 'integer')], { primaryKey: ['id'] }),
      table('child', [col('parent_id', 1, 'integer', 'integer')], {
        foreignKeys: [fk('fk_child_parent', ['parent_id'], 'parent', ['id'])],
      }),
    ];
    const script = generateMigration(
      diffSchemas(model('postgres', [ns('public', [])]), model('postgres', [ns('public', tables)])),
      'postgres',
    );
    const drops = script.destructive.filter((s) => s.startsWith('DROP TABLE'));
    expect(drops).toEqual(['DROP TABLE "public"."child"', 'DROP TABLE "public"."parent"']);
  });

  it('produces an additive-only script when includeDrops is false', () => {
    const { source, target } = orderingFixture();
    const script = generateMigration(diffSchemas(source, target), 'postgres', { includeDrops: false });
    expect(script.destructive).toEqual([]);
    expect(script.statements.some((s) => /\bDROP (TABLE|COLUMN)\b/.test(s))).toBe(false);
    expect(script.statements.some((s) => s.includes('CREATE TABLE "public"."payments"'))).toBe(true);
    // A *changed* index is still dropped: the safe section only ever drops what
    // it puts back, and that holds whether or not drops are included.
    expect(script.statements.filter((s) => s.includes('idx_orders_user'))).toHaveLength(2);
  });

  it('warns that a drop plus an add may have been a rename', () => {
    const target = model('postgres', [ns('public', [table('t', [col('old_name', 1, 'text', 'text')])])]);
    const source = model('postgres', [ns('public', [table('t', [col('new_name', 1, 'text', 'text')])])]);
    const script = generateMigration(diffSchemas(source, target), 'postgres');

    expect(script.warnings.join(' ')).toContain('RENAME COLUMN');
    expect(script.statements).toContain('ALTER TABLE "public"."t" ADD COLUMN "new_name" text');
    expect(script.destructive).toContain('ALTER TABLE "public"."t" DROP COLUMN "old_name"');
  });
});

describe('generateMigration — engines', () => {
  it('restates the whole column for MySQL and can position an added one', () => {
    const target = model('mysql', [
      ns('app', [
        table('t', [col('a', 1, 'int', 'integer'), col('c', 2, 'int', 'integer')], { schema: 'app' }),
      ]),
    ]);
    const source = model('mysql', [
      ns('app', [
        table(
          't',
          [
            col('a', 1, 'bigint', 'bigint'),
            col('b', 2, 'int', 'integer'),
            col('c', 3, 'int', 'integer'),
          ],
          { schema: 'app' },
        ),
      ]),
    ]);
    const script = generateMigration(diffSchemas(source, target), 'mysql');

    expect(script.statements).toContain('ALTER TABLE `app`.`t` MODIFY COLUMN `a` bigint NULL');
    expect(script.statements).toContain('ALTER TABLE `app`.`t` ADD COLUMN `b` int NULL AFTER `a`');
  });

  it('adds a MySQL index through ALTER TABLE so FULLTEXT stays valid', () => {
    const target = model('mysql', [ns('app', [table('t', [col('a', 1, 'text', 'text')], { schema: 'app' })])]);
    const source = model('mysql', [
      ns('app', [
        table('t', [col('a', 1, 'text', 'text')], {
          schema: 'app',
          indexes: [index('ft', ['a'], { method: 'FULLTEXT' })],
        }),
      ]),
    ]);
    const script = generateMigration(diffSchemas(source, target), 'mysql');
    expect(script.statements).toContain('ALTER TABLE `app`.`t` ADD FULLTEXT KEY `ft` (`a`)');
  });

  it('keeps SQLite foreign keys inline and orders creates parents-first', () => {
    const child = table('child', [col('parent_id', 1, 'INTEGER', 'integer')], {
      schema: undefined,
      foreignKeys: [{ name: 'fk', columns: ['parent_id'], refTable: 'parent', refColumns: ['id'] }],
    });
    const parent = table('parent', [col('id', 1, 'INTEGER', 'integer', { nullable: false })], {
      schema: undefined,
      primaryKey: ['id'],
    });
    // The child is listed first on purpose: the sort has to fix it.
    const source = model('sqlite', [ns('main', [child, parent])]);
    const target = model('sqlite', [ns('main', [])]);

    const script = generateMigration(diffSchemas(source, target), 'sqlite');
    const creates = script.statements.filter((s) => s.startsWith('CREATE TABLE'));
    expect(creates[0].startsWith('CREATE TABLE "parent"')).toBe(true);
    expect(creates[1].startsWith('CREATE TABLE "child"')).toBe(true);
    expect(creates[1]).toContain('FOREIGN KEY ("parent_id") REFERENCES "parent" ("id")');
    // SQLite has no ALTER TABLE … ADD CONSTRAINT, so nothing may be deferred.
    expect(script.statements.some((s) => s.includes('ADD CONSTRAINT'))).toBe(false);
  });

  it('routes a SQLite column change to the connector 12-step rebuild', () => {
    const target = model('sqlite', [
      ns('main', [table('t', [col('a', 1, 'TEXT', 'text')], { schema: undefined })]),
    ]);
    const source = model('sqlite', [
      ns('main', [table('t', [col('a', 1, 'INTEGER', 'integer')], { schema: undefined })]),
    ]);
    const script = generateMigration(diffSchemas(source, target), 'sqlite');

    expect(script.statements).toEqual([]);
    const warning = script.warnings.join(' ');
    expect(warning).toContain('planRebuild()');
    expect(warning).toContain('src/server/db/connectors/sqlite/ddl.ts');
  });

  it('adds new Postgres enum labels in source order and refuses to invent removals', () => {
    const target = model('postgres', [
      ns('public', [], { enums: [{ name: 'mood', values: ['sad', 'ok'] }] }),
    ]);
    const source = model('postgres', [
      ns('public', [], { enums: [{ name: 'mood', values: ['awful', 'sad', 'happy'] }] }),
    ]);
    const script = generateMigration(diffSchemas(source, target), 'postgres');

    expect(script.statements).toEqual([
      `ALTER TYPE "public"."mood" ADD VALUE 'awful' BEFORE 'sad'`,
      `ALTER TYPE "public"."mood" ADD VALUE 'happy' AFTER 'sad'`,
    ]);
    expect(script.warnings.join(' ')).toContain('cannot remove enum values');
  });

  it('writes new objects into the mapped target namespace', () => {
    const source = model('postgres', [
      ns('dev', [table('t', [col('a', 1, 'text', 'text')], { schema: 'dev' })]),
    ]);
    const target = model('postgres', [ns('prod', [])]);
    const script = generateMigration(diffSchemas(source, target, { namespaceMap: { dev: 'prod' } }), 'postgres');

    expect(script.statements.some((s) => s.startsWith('CREATE TABLE "prod"."t"'))).toBe(true);
    expect(script.statements.some((s) => s.includes('"dev"'))).toBe(false);
  });

  it('refuses to generate DDL for an engine that has none', () => {
    const diff = diffSchemas(model('redis', []), model('redis', []));
    expect(() => generateMigration(diff, 'redis')).toThrow(/SQL-only/);
  });
});

describe('orderByDependency', () => {
  it('survives a cycle instead of hanging', () => {
    const a = table('a', [col('b_id', 1, 'integer', 'integer')], {
      foreignKeys: [fk('fk_a_b', ['b_id'], 'b', ['id'])],
    });
    const b = table('b', [col('a_id', 1, 'integer', 'integer')], {
      foreignKeys: [fk('fk_b_a', ['a_id'], 'a', ['id'])],
    });
    expect(orderByDependency([a, b]).map((t) => t.name)).toEqual(['b', 'a']);
  });

  it('ignores a self-reference', () => {
    const t = table('tree', [col('parent', 1, 'integer', 'integer')], {
      foreignKeys: [fk('fk_tree', ['parent'], 'tree', ['id'])],
    });
    expect(orderByDependency([t]).map((x) => x.name)).toEqual(['tree']);
  });
});

describe('renderMigrationScript', () => {
  const { source, target } = orderingFixture();
  const script = generateMigration(diffSchemas(source, target), 'postgres');

  it('comments out the destructive block unless the reviewer opts in', () => {
    const safe = renderMigrationScript(script);
    expect(safe).toContain('-- DROP TABLE "public"."legacy";');
    expect(safe).not.toMatch(/^DROP TABLE/m);
    expect(safe).toContain('-- Drop foreign keys');
    expect(safe).toMatch(/^ALTER TABLE "public"\."orders" DROP CONSTRAINT "fk_orders_user";$/m);

    const full = renderMigrationScript(script, { includeDestructive: true });
    expect(full).toMatch(/^DROP TABLE "public"\."legacy";$/m);
  });

  it('puts every warning at the top as a comment', () => {
    const rendered = renderMigrationScript(script);
    for (const w of script.warnings) {
      expect(rendered).toContain(`-- WARNING: ${w.replace(/\s+/g, ' ')}`);
    }
  });
});
