/**
 * Unit tests for the changeset → SQL generator (PLAN §13 "Unit: … changeset→SQL
 * generator, quoting functions").
 *
 * These are the cases where a bug is silent and destructive: a NULL key that
 * matches nothing (or everything), a composite key with mis-numbered
 * placeholders, a bigint that becomes a rounded JS number, an identifier that
 * closes its own quote.
 */

import { describe, expect, it } from 'vitest';

import type { Changeset } from '../../../lib/results';
import type { ColumnModel, TableModel, TypeDescriptor } from '../../../lib/schema-model';
import { tag } from '../../../lib/wire';
import {
  AffectedRowsMismatchError,
  buildChangesetSql,
  checkAffected,
  decodeCellForSql,
  paramStyleFor,
  planChangeset,
} from './changeset';
import {
  diffTables,
  renderCheckDefinition,
  renderColumnDefinition,
  renderCreateTable,
} from './ddl-common';
import { quoterFor } from './quote';

const pg = quoterFor('postgres');
const my = quoterFor('mysql');
const lite = quoterFor('sqlite');

function column(name: string, type: TypeDescriptor, over: Partial<ColumnModel> = {}): ColumnModel {
  return { name, position: 1, type, nullable: true, defaultValue: null, ...over };
}

// ---------------------------------------------------------------------------
// NULL keys
// ---------------------------------------------------------------------------

describe('NULL key values', () => {
  it('renders IS NULL instead of = NULL for a delete', () => {
    const cs: Changeset = {
      table: 'users',
      keyColumns: ['tenant', 'id'],
      changes: [{ op: 'delete', key: { tenant: null, id: 7 } }],
    };
    const plan = planChangeset(cs, 'postgres', pg);

    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe(
      'DELETE FROM "users" WHERE "tenant" IS NULL AND "id" = $1',
    );
    // The NULL contributes no parameter, so numbering must skip it.
    expect(plan.statements[0].params).toEqual([7]);
    expect(plan.statements[0].display).toBe(
      'DELETE FROM "users" WHERE "tenant" IS NULL AND "id" = 7',
    );
  });

  it('renders IS NULL in an update WHERE while the SET keeps its own placeholder', () => {
    const cs: Changeset = {
      table: 'users',
      keyColumns: ['tenant', 'id'],
      changes: [{ op: 'update', key: { tenant: null, id: 7 }, values: { name: 'Ada' } }],
    };
    const plan = planChangeset(cs, 'postgres', pg);

    expect(plan.statements[0].sql).toBe(
      'UPDATE "users" SET "name" = $1 WHERE "tenant" IS NULL AND "id" = $2',
    );
    expect(plan.statements[0].params).toEqual(['Ada', 7]);
  });

  it('never emits the string "= NULL"', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['a', 'b', 'c'],
      changes: [{ op: 'delete', key: { a: null, b: null, c: null } }],
    };
    const preview = buildChangesetSql(cs, 'mysql', my);
    expect(preview.statements[0]).toBe('DELETE FROM `t` WHERE `a` IS NULL AND `b` IS NULL AND `c` IS NULL');
    expect(preview.statements[0]).not.toContain('= NULL');
  });

  it('writes a NULL value in a SET as a bound null, not IS NULL', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [{ op: 'update', key: { id: 1 }, values: { note: null } }],
    };
    const plan = planChangeset(cs, 'mysql', my);
    expect(plan.statements[0].sql).toBe('UPDATE `t` SET `note` = ? WHERE `id` = ?');
    expect(plan.statements[0].params).toEqual([null, 1]);
    expect(plan.statements[0].display).toBe('UPDATE `t` SET `note` = NULL WHERE `id` = 1');
  });
});

// ---------------------------------------------------------------------------
// Composite keys
// ---------------------------------------------------------------------------

describe('composite keys', () => {
  it('ANDs every key column in the declared order', () => {
    const cs: Changeset = {
      schema: 'app',
      table: 'memberships',
      keyColumns: ['org_id', 'user_id', 'role'],
      changes: [
        {
          op: 'update',
          key: { org_id: 10, user_id: 20, role: 'admin' },
          values: { active: false, note: 'x' },
        },
      ],
    };
    const plan = planChangeset(cs, 'postgres', pg);

    expect(plan.statements[0].sql).toBe(
      'UPDATE "app"."memberships" SET "active" = $1, "note" = $2 ' +
        'WHERE "org_id" = $3 AND "user_id" = $4 AND "role" = $5',
    );
    expect(plan.statements[0].params).toEqual([false, 'x', 10, 20, 'admin']);
  });

  it('uses ? placeholders and qualified names for MySQL', () => {
    const cs: Changeset = {
      schema: 'shop',
      table: 'order_items',
      keyColumns: ['order_id', 'line'],
      changes: [{ op: 'delete', key: { order_id: 1, line: 2 } }],
    };
    const plan = planChangeset(cs, 'mysql', my);
    expect(plan.statements[0].sql).toBe(
      'DELETE FROM `shop`.`order_items` WHERE `order_id` = ? AND `line` = ?',
    );
    expect(plan.statements[0].params).toEqual([1, 2]);
  });

  it('ignores key columns the row did not carry and skips the change', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['a', 'b'],
      changes: [{ op: 'delete', key: { a: 1 } }],
    };
    const plan = planChangeset(cs, 'postgres', pg);
    // A missing member would widen the WHERE, which is the destructive direction.
    expect(plan.statements).toHaveLength(0);
    expect(plan.warnings.join(' ')).toContain('missing b');
  });

  it('falls back to the row key columns when the table has no declared key', () => {
    const cs: Changeset = {
      table: 'log',
      keyColumns: [],
      changes: [{ op: 'delete', key: { at: '2024-01-01', msg: 'boom' } }],
    };
    const plan = planChangeset(cs, 'sqlite', lite);
    expect(plan.statements[0].sql).toBe('DELETE FROM "log" WHERE "at" = ? AND "msg" = ?');
    expect(plan.warnings.join(' ')).toContain('no primary key');
  });
});

// ---------------------------------------------------------------------------
// Tagged cells (§6 type fidelity)
// ---------------------------------------------------------------------------

describe('tagged cells', () => {
  it('binds a bigint as its lossless string, never as a JS number', () => {
    const big = '9007199254740993'; // 2^53 + 1: unrepresentable as a JS number
    const { sql, param } = decodeCellForSql(tag('bigint', big), pg);
    expect(param).toBe(big);
    expect(typeof param).toBe('string');
    // Inlined bare (it is a number to the engine) but byte-identical: routing it
    // through Number() would render 9007199254740992.
    expect(sql).toBe(big);
    expect(String(Number(big))).not.toBe(big);
  });

  it('keeps decimal precision in both forms', () => {
    const { sql, param } = decodeCellForSql(tag('decimal', '0.10000000000000000001'), pg);
    expect(param).toBe('0.10000000000000000001');
    expect(sql).toBe('0.10000000000000000001');
  });

  it('quotes a non-numeric decimal rather than inlining it bare', () => {
    const { sql, param } = decodeCellForSql(tag('decimal', 'NaN'), pg);
    expect(param).toBe('NaN');
    expect(sql).toBe("'NaN'");
  });

  it('binds timestamps as text and quotes them in the preview', () => {
    const ts = '2024-03-01 12:00:00.123456+00';
    const { sql, param } = decodeCellForSql(tag('timestamptz', ts), pg);
    expect(param).toBe(ts);
    expect(sql).toBe(`'${ts}'`);
  });

  it('binds bytes as a Buffer and renders the engine blob syntax', () => {
    const cell = tag('bytes', Buffer.from([0x0a, 0xff]).toString('base64'));

    const onMysql = decodeCellForSql(cell, my);
    expect(Buffer.isBuffer(onMysql.param)).toBe(true);
    expect([...(onMysql.param as Buffer)]).toEqual([0x0a, 0xff]);
    expect(onMysql.sql).toBe("X'0aff'");

    expect(decodeCellForSql(cell, lite).sql).toBe("X'0aff'");
    // Postgres bytea hex input, escaped so it survives standard_conforming_strings.
    expect(decodeCellForSql(cell, pg).sql).toBe(String.raw`E'\\x0aff'`);
  });

  it('binds json as its exact text, without reparsing it', () => {
    const json = '{"n":1e400,"s":"a\'b"}';
    const { sql, param } = decodeCellForSql(tag('json', json), pg);
    expect(param).toBe(json);
    expect(sql).toBe(`'{"n":1e400,"s":"a''b"}'`);
  });

  it('turns a Postgres array cell into a real JS array parameter', () => {
    const { param, sql } = decodeCellForSql(tag('array', '[1,2,null]', 'int4'), pg);
    expect(param).toEqual([1, 2, null]);
    expect(sql).toBe(`'{"1","2",NULL}'`);
  });

  it('coerces booleans to 1/0 for SQLite, which cannot bind a JS boolean', () => {
    expect(decodeCellForSql(true, lite).param).toBe(1);
    expect(decodeCellForSql(false, lite).param).toBe(0);
    expect(decodeCellForSql(true, pg).param).toBe(true);
    expect(decodeCellForSql(true, lite).sql).toBe('1');
    expect(decodeCellForSql(true, pg).sql).toBe('TRUE');
  });

  it('carries tagged values through a full statement as parameters', () => {
    const cs: Changeset = {
      table: 'events',
      keyColumns: ['id'],
      changes: [
        {
          op: 'update',
          key: { id: tag('bigint', '12345678901234567890') },
          values: {
            amount: tag('decimal', '1.05'),
            at: tag('timestamp', '2024-01-02 03:04:05'),
            payload: tag('json', '{"a":1}'),
            blob: tag('bytes', 'AAE='),
          },
        },
      ],
    };
    const plan = planChangeset(cs, 'postgres', pg);
    const [stmt] = plan.statements;

    expect(stmt.sql).toBe(
      'UPDATE "events" SET "amount" = $1, "at" = $2, "payload" = $3, "blob" = $4 WHERE "id" = $5',
    );
    expect(stmt.params.slice(0, 3)).toEqual(['1.05', '2024-01-02 03:04:05', '{"a":1}']);
    expect(Buffer.isBuffer(stmt.params[3])).toBe(true);
    // The key keeps its full 20-digit precision as a string.
    expect(stmt.params[4]).toBe('12345678901234567890');
    expect(stmt.display).toContain('WHERE "id" = 12345678901234567890');
  });

  it('skips a change whose value could not be decoded losslessly', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [
        { op: 'update', key: { id: 1 }, values: { weird: tag('unsupported', '', 'tsvector') } },
        { op: 'update', key: { id: 2 }, values: { ok: 'yes' } },
      ],
    };
    const plan = planChangeset(cs, 'postgres', pg);
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].params).toEqual(['yes', 2]);
    expect(plan.warnings.join(' ')).toContain('tsvector');
  });
});

// ---------------------------------------------------------------------------
// Identifier quoting (§9)
// ---------------------------------------------------------------------------

describe('identifiers containing quotes and backticks', () => {
  it('doubles backticks for MySQL and leaves double quotes alone', () => {
    const cs: Changeset = {
      schema: 'we`ird',
      table: 'ta`ble',
      keyColumns: ['id`col'],
      changes: [{ op: 'update', key: { 'id`col': 1 }, values: { 'a"b': 'x' } }],
    };
    const plan = planChangeset(cs, 'mysql', my);
    expect(plan.statements[0].sql).toBe(
      'UPDATE `we``ird`.`ta``ble` SET `a"b` = ? WHERE `id``col` = ?',
    );
  });

  it('doubles double quotes for Postgres and leaves backticks alone', () => {
    const cs: Changeset = {
      schema: 'we"ird',
      table: 'ta"ble',
      keyColumns: ['id"col'],
      changes: [{ op: 'delete', key: { 'id"col': 1 } }],
    };
    const plan = planChangeset(cs, 'postgres', pg);
    expect(plan.statements[0].sql).toBe('DELETE FROM "we""ird"."ta""ble" WHERE "id""col" = $1');
  });

  it('neutralizes an identifier that tries to close its own quote', () => {
    const cs: Changeset = {
      table: 'users" ; DROP TABLE secrets --',
      keyColumns: ['id'],
      changes: [{ op: 'delete', key: { id: 1 } }],
    };
    const plan = planChangeset(cs, 'postgres', pg);
    // The injected text stays inside a balanced quoted identifier, so the `;`
    // and the `--` are just characters in a table name.
    expect(plan.statements[0].sql).toBe(
      'DELETE FROM "users"" ; DROP TABLE secrets --" WHERE "id" = $1',
    );
    expect(plan.statements[0].sql.split('"')).toHaveLength(7);
  });

  it('escapes a value that tries to close its own literal in the preview', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [{ op: 'update', key: { id: 1 }, values: { name: "'; DROP TABLE t --" } }],
    };
    const plan = planChangeset(cs, 'sqlite', lite);
    expect(plan.statements[0].params).toEqual(["'; DROP TABLE t --", 1]);
    expect(plan.statements[0].display).toBe(
      `UPDATE "t" SET "name" = '''; DROP TABLE t --' WHERE "id" = 1`,
    );
  });

  it('escapes backslashes per engine in the preview literal', () => {
    const value = 'C:\\temp';
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [{ op: 'update', key: { id: 1 }, values: { path: value } }],
    };
    expect(planChangeset(cs, 'mysql', my).statements[0].display).toBe(
      'UPDATE `t` SET `path` = ' + String.raw`'C:\\temp'` + ' WHERE `id` = 1',
    );
    expect(planChangeset(cs, 'postgres', pg).statements[0].display).toBe(
      'UPDATE "t" SET "path" = ' + String.raw`E'C:\\temp'` + ' WHERE "id" = 1',
    );
    // Either way the executed statement binds the raw value.
    expect(planChangeset(cs, 'postgres', pg).statements[0].params).toEqual([value, 1]);
  });
});

// ---------------------------------------------------------------------------
// expectedAffected
// ---------------------------------------------------------------------------

describe('expectedAffected', () => {
  it('is 1 per emitted statement, and skipped changes are not counted', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [
        { op: 'insert', values: { a: 1 } },
        { op: 'update', key: { id: 1 }, values: { a: 2 } },
        { op: 'update', key: { id: 2 }, values: {} }, // nothing to write → no statement
        { op: 'delete', key: { id: 3 } },
      ],
    };
    const preview = buildChangesetSql(cs, 'postgres', pg);
    expect(preview.statements).toHaveLength(3);
    expect(preview.expectedAffected).toEqual([1, 1, 1]);
    expect(preview.expectedAffected).toHaveLength(preview.statements.length);
  });

  it('counts an insert of defaults as one row, in each engine spelling', () => {
    const cs: Changeset = { table: 't', keyColumns: ['id'], changes: [{ op: 'insert', values: {} }] };
    expect(buildChangesetSql(cs, 'postgres', pg).statements[0]).toBe(
      'INSERT INTO "t" DEFAULT VALUES',
    );
    expect(buildChangesetSql(cs, 'sqlite', lite).statements[0]).toBe(
      'INSERT INTO "t" DEFAULT VALUES',
    );
    expect(buildChangesetSql(cs, 'mysql', my).statements[0]).toBe('INSERT INTO `t` () VALUES ()');
    expect(buildChangesetSql(cs, 'mysql', my).expectedAffected).toEqual([1]);
  });

  it('preserves the order the grid recorded the changes in', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [
        { op: 'delete', key: { id: 1 } },
        { op: 'insert', values: { id: 2 } },
        { op: 'update', key: { id: 3 }, values: { a: 1 } },
      ],
    };
    expect(planChangeset(cs, 'postgres', pg).statements.map((s) => s.op)).toEqual([
      'delete',
      'insert',
      'update',
    ]);
  });

  it('aborts the apply when the driver reports a different row count', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [{ op: 'delete', key: { id: 1 } }],
    };
    const [stmt] = planChangeset(cs, 'postgres', pg).statements;

    expect(() => checkAffected(1, stmt, 0)).not.toThrow();
    expect(() => checkAffected(0, stmt, 0)).toThrow(AffectedRowsMismatchError);
    // The dangerous direction: a WHERE that matched more rows than intended.
    expect(() => checkAffected(42, stmt, 0)).toThrow(/affected 42 row/);
  });
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

describe('warnings', () => {
  const columns: ColumnModel[] = [
    column('id', { raw: 'integer', base: 'integer' }, { nullable: false }),
    column('first', { raw: 'varchar(5)', base: 'string', length: 5 }),
    column(
      'full_name',
      { raw: 'text', base: 'text' },
      { generated: 'stored', generatedExpression: "first || ' '" },
    ),
    column('amount', { raw: 'numeric(5,2)', base: 'decimal', precision: 5, scale: 2 }),
    column('photo', { raw: 'bytea', base: 'binary', length: 4 }),
  ];

  it('warns about and drops a write to a generated column', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [{ op: 'insert', values: { first: 'Ada', full_name: 'Ada L' } }],
    };
    const preview = buildChangesetSql(cs, 'postgres', pg, { columns });

    expect(preview.statements[0]).toBe(`INSERT INTO "t" ("first") VALUES ('Ada')`);
    expect(preview.warnings.join(' ')).toMatch(/generated column/);
  });

  it('emits no statement when every written column was generated', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [{ op: 'update', key: { id: 1 }, values: { full_name: 'x' } }],
    };
    const plan = planChangeset(cs, 'postgres', pg, { columns });
    expect(plan.statements).toHaveLength(0);
  });

  it('warns once when the table has no key at all', () => {
    const cs: Changeset = {
      table: 'no_key',
      keyColumns: [],
      changes: [
        { op: 'update', key: { a: 1 }, values: { b: 2 } },
        { op: 'update', key: { a: 2 }, values: { b: 3 } },
      ],
    };
    const preview = buildChangesetSql(cs, 'postgres', pg);
    const keyWarnings = preview.warnings.filter((w) => w.includes('no primary key'));
    expect(keyWarnings).toHaveLength(1);
    expect(keyWarnings[0]).toContain('rolled back');
    expect(preview.expectedAffected).toEqual([1, 1]);
  });

  it('does not warn about a missing key when only inserting', () => {
    const cs: Changeset = { table: 'no_key', keyColumns: [], changes: [{ op: 'insert', values: { a: 1 } }] };
    expect(buildChangesetSql(cs, 'postgres', pg).warnings).toEqual([]);
  });

  it('warns when a value is longer than the column', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [{ op: 'update', key: { id: 1 }, values: { first: 'Wolfeschlegelstein' } }],
    };
    const preview = buildChangesetSql(cs, 'postgres', pg, { columns });
    expect(preview.warnings.join(' ')).toMatch(/18 characters but varchar\(5\) holds 5/);
    // It is a warning, not a rejection: the statement is still produced.
    expect(preview.statements).toHaveLength(1);
  });

  it('warns when a binary value is longer than the column', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [
        { op: 'update', key: { id: 1 }, values: { photo: tag('bytes', Buffer.alloc(9).toString('base64')) } },
      ],
    };
    const preview = buildChangesetSql(cs, 'postgres', pg, { columns });
    expect(preview.warnings.join(' ')).toMatch(/9 bytes but the column holds 4/);
  });

  it('warns when a decimal has more scale than the column keeps', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [{ op: 'update', key: { id: 1 }, values: { amount: tag('decimal', '1.2345') } }],
    };
    const preview = buildChangesetSql(cs, 'postgres', pg, { columns });
    expect(preview.warnings.join(' ')).toMatch(/rounded/);
  });

  it('warns when a decimal exceeds the column precision', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [{ op: 'update', key: { id: 1 }, values: { amount: tag('decimal', '12345.67') } }],
    };
    const preview = buildChangesetSql(cs, 'postgres', pg, { columns });
    expect(preview.warnings.join(' ')).toMatch(/digits before the decimal point/);
  });

  it('stays silent about length on SQLite, where declared lengths mean nothing', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [{ op: 'update', key: { id: 1 }, values: { first: 'far too long' } }],
    };
    expect(buildChangesetSql(cs, 'sqlite', lite, { columns }).warnings).toEqual([]);
  });

  it('deduplicates a warning repeated across many edited rows', () => {
    const changes = Array.from({ length: 50 }, (_, i) => ({
      op: 'update' as const,
      key: { id: i },
      values: { first: 'much too long for five' },
    }));
    const preview = buildChangesetSql({ table: 't', keyColumns: ['id'], changes }, 'postgres', pg, {
      columns,
    });
    expect(preview.statements).toHaveLength(50);
    expect(preview.warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe('paramStyleFor', () => {
  it('gives Postgres $n and everything else ?', () => {
    expect(paramStyleFor('postgres')).toBe('dollar');
    expect(paramStyleFor('mysql')).toBe('qmark');
    expect(paramStyleFor('mariadb')).toBe('qmark');
    expect(paramStyleFor('sqlite')).toBe('qmark');
  });
});

// ---------------------------------------------------------------------------
// Shared DDL helpers (./ddl-common), the other half of what the grid's editing
// path emits. They live here because they share this file's fixtures and the
// same §9 quoting chokepoint.
// ---------------------------------------------------------------------------

function table(over: Partial<TableModel> = {}): TableModel {
  return {
    name: 't',
    kind: 'table',
    columns: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
    primaryKey: [],
    ...over,
  };
}

describe('renderColumnDefinition', () => {
  it('puts MySQL clauses in the order MySQL accepts them', () => {
    const id = column('i`d', { raw: 'bigint unsigned', base: 'bigint' }, {
      nullable: false,
      autoIncrement: true,
    });
    expect(renderColumnDefinition(id, 'mysql', my)).toBe(
      '`i``d` bigint unsigned NOT NULL AUTO_INCREMENT',
    );
  });

  it('quotes a MySQL literal default but not a keyword one', () => {
    const name = column('name', { raw: 'varchar(10)', base: 'string', length: 10 }, {
      defaultValue: 'hi',
    });
    expect(renderColumnDefinition(name, 'mysql', my)).toBe("`name` varchar(10) NULL DEFAULT 'hi'");

    const at = column('at', { raw: 'datetime', base: 'timestamp' }, {
      defaultValue: 'CURRENT_TIMESTAMP',
    });
    expect(renderColumnDefinition(at, 'mysql', my)).toBe(
      '`at` datetime NULL DEFAULT CURRENT_TIMESTAMP',
    );
  });

  it('spells a keyless Postgres auto-increment as an identity column', () => {
    const id = column('id', { raw: 'integer', base: 'integer' }, {
      nullable: false,
      autoIncrement: true,
    });
    expect(renderColumnDefinition(id, 'postgres', pg)).toBe(
      '"id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL',
    );
  });

  it('keeps a serial column its nextval default, verbatim', () => {
    const id = column('id', { raw: 'integer', base: 'integer' }, {
      nullable: false,
      autoIncrement: true,
      defaultValue: "nextval('t_id_seq'::regclass)",
    });
    expect(renderColumnDefinition(id, 'postgres', pg)).toBe(
      `"id" integer DEFAULT nextval('t_id_seq'::regclass) NOT NULL`,
    );
  });
});

describe('renderCreateTable', () => {
  it('keeps MySQL indexes inside the table and options after it', () => {
    const t = table({
      columns: [
        column('id', { raw: 'bigint', base: 'bigint' }, {
          position: 1,
          nullable: false,
          autoIncrement: true,
        }),
        column('name', { raw: 'varchar(20)', base: 'string', length: 20 }, { position: 2 }),
      ],
      primaryKey: ['id'],
      indexes: [{ name: 'idx_name', columns: [{ name: 'name' }], unique: false, primary: false }],
      engine: 'InnoDB',
    });
    expect(renderCreateTable(t, 'mysql', my)).toBe(
      'CREATE TABLE `t` (\n' +
        '  `id` bigint NOT NULL AUTO_INCREMENT,\n' +
        '  `name` varchar(20) NULL,\n' +
        '  PRIMARY KEY (`id`),\n' +
        '  KEY `idx_name` (`name`)\n' +
        ') ENGINE=InnoDB',
    );
  });

  it('leaves Postgres secondary indexes out of the table body', () => {
    const t = table({
      columns: [
        column('id', { raw: 'bigint', base: 'bigint' }, { position: 1, nullable: false }),
        column('name', { raw: 'varchar(20)', base: 'string', length: 20 }, { position: 2 }),
      ],
      primaryKey: ['id'],
      primaryKeyName: 't_pkey',
      indexes: [{ name: 'idx_name', columns: [{ name: 'name' }], unique: false, primary: false }],
    });
    expect(renderCreateTable(t, 'postgres', pg)).toBe(
      'CREATE TABLE "t" (\n' +
        '  "id" bigint NOT NULL,\n' +
        '  "name" varchar(20),\n' +
        '  CONSTRAINT "t_pkey" PRIMARY KEY ("id")\n' +
        ')',
    );
  });

  it('declares a SQLite AUTOINCREMENT key on the column, never as a constraint', () => {
    const t = table({
      columns: [
        column('id', { raw: 'INTEGER', base: 'integer' }, { position: 1, autoIncrement: true }),
        column('name', { raw: 'TEXT', base: 'text' }, { position: 2 }),
      ],
      primaryKey: ['id'],
    });
    expect(renderCreateTable(t, 'sqlite', lite)).toBe(
      'CREATE TABLE "t" (\n  "id" INTEGER PRIMARY KEY AUTOINCREMENT,\n  "name" TEXT\n)',
    );
  });

  it('orders columns by position, not by array order', () => {
    const t = table({
      columns: [
        column('b', { raw: 'TEXT', base: 'text' }, { position: 2 }),
        column('a', { raw: 'TEXT', base: 'text' }, { position: 1 }),
      ],
    });
    expect(renderCreateTable(t, 'sqlite', lite)).toBe(
      'CREATE TABLE "t" (\n  "a" TEXT,\n  "b" TEXT\n)',
    );
  });
});

describe('renderCheckDefinition', () => {
  it('wraps an expression whose outer parentheses do not span it', () => {
    expect(renderCheckDefinition({ name: 'ck', expression: '(a > 1) AND (b < 2)' }, pg)).toBe(
      'CONSTRAINT "ck" CHECK ((a > 1) AND (b < 2))',
    );
  });

  it('does not double-wrap an already parenthesized expression', () => {
    expect(renderCheckDefinition({ name: 'ck', expression: '(a > 1)' }, pg)).toBe(
      'CONSTRAINT "ck" CHECK (a > 1)',
    );
  });

  it('ignores parentheses inside string literals', () => {
    expect(renderCheckDefinition({ name: 'ck', expression: "note <> ')'" }, pg)).toBe(
      `CONSTRAINT "ck" CHECK (note <> ')')`,
    );
  });
});

describe('diffTables', () => {
  const base = table({
    columns: [
      column('a', { raw: 'INTEGER', base: 'integer' }, { position: 1, nullable: false }),
      column('b', { raw: 'TEXT', base: 'text' }, { position: 2 }),
    ],
    primaryKey: ['a'],
  });

  it('reports a create when there is no current table', () => {
    const diff = diffTables(null, base);
    expect(diff.kind).toBe('create');
    expect(diff.isEmpty).toBe(false);
    expect(diff.requiresRebuild).toBe(false);
  });

  it('reports nothing for two identical models', () => {
    const diff = diffTables(base, table({ ...base }));
    expect(diff.isEmpty).toBe(true);
    expect(diff.requiresRebuild).toBe(false);
    expect(diff.rebuildReasons).toEqual([]);
  });

  it('detects a rename positionally instead of a destructive drop + add', () => {
    const renamed = table({
      ...base,
      columns: [
        column('a', { raw: 'INTEGER', base: 'integer' }, { position: 1, nullable: false }),
        column('bee', { raw: 'TEXT', base: 'text' }, { position: 2 }),
      ],
    });
    const diff = diffTables(base, renamed);
    expect(diff.renamedColumns).toEqual([{ from: 'b', to: 'bee' }]);
    expect(diff.addedColumns).toEqual([]);
    expect(diff.droppedColumns).toEqual([]);
    // RENAME COLUMN is a real SQLite ALTER, so no rebuild is needed.
    expect(diff.requiresRebuild).toBe(false);
  });

  it('will not guess a rename when the body also changed', () => {
    const changed = table({
      ...base,
      columns: [
        column('a', { raw: 'INTEGER', base: 'integer' }, { position: 1, nullable: false }),
        column('bee', { raw: 'INTEGER', base: 'integer' }, { position: 2 }),
      ],
    });
    const diff = diffTables(base, changed);
    expect(diff.renamedColumns).toEqual([]);
    expect(diff.addedColumns.map((c) => c.name)).toEqual(['bee']);
    expect(diff.droppedColumns.map((c) => c.name)).toEqual(['b']);
  });

  it('forces a rebuild when a column definition changes', () => {
    const retyped = table({
      ...base,
      columns: [
        column('a', { raw: 'INTEGER', base: 'integer' }, { position: 1, nullable: false }),
        column('b', { raw: 'TEXT', base: 'text' }, { position: 2, nullable: false }),
      ],
    });
    const diff = diffTables(base, retyped);
    expect(diff.alteredColumns).toHaveLength(1);
    expect(diff.alteredColumns[0].aspects).toEqual(['nullable']);
    expect(diff.requiresRebuild).toBe(true);
    expect(diff.rebuildReasons.join(' ')).toContain('column definition changed');
  });

  it('allows an appended column but not one inserted in the middle', () => {
    const appended = table({
      ...base,
      columns: [
        ...base.columns,
        column('c', { raw: 'TEXT', base: 'text' }, { position: 3 }),
      ],
    });
    const tail = diffTables(base, appended);
    expect(tail.addedColumnsAtEnd).toBe(true);
    expect(tail.reordered).toBe(false);
    expect(tail.requiresRebuild).toBe(false);

    const inserted = table({
      ...base,
      columns: [
        column('a', { raw: 'INTEGER', base: 'integer' }, { position: 1, nullable: false }),
        column('c', { raw: 'TEXT', base: 'text' }, { position: 2 }),
        column('b', { raw: 'TEXT', base: 'text' }, { position: 3 }),
      ],
    });
    const middle = diffTables(base, inserted);
    expect(middle.addedColumnsAtEnd).toBe(false);
    expect(middle.requiresRebuild).toBe(true);
  });

  it('treats a primary key change as a constraint change', () => {
    const diff = diffTables(base, table({ ...base, primaryKey: ['a', 'b'] }));
    expect(diff.primaryKeyChange).toEqual({ from: ['a'], to: ['a', 'b'] });
    expect(diff.constraintsChanged).toBe(true);
    expect(diff.requiresRebuild).toBe(true);
  });

  it('separates added, dropped and changed indexes by name', () => {
    const withIndexes = table({
      ...base,
      indexes: [
        { name: 'keep', columns: [{ name: 'b' }], unique: false, primary: false },
        { name: 'drop_me', columns: [{ name: 'a' }], unique: false, primary: false },
        { name: 'change_me', columns: [{ name: 'a' }], unique: false, primary: false },
      ],
    });
    const desired = table({
      ...base,
      indexes: [
        { name: 'keep', columns: [{ name: 'b' }], unique: false, primary: false },
        { name: 'change_me', columns: [{ name: 'a' }], unique: true, primary: false },
        { name: 'add_me', columns: [{ name: 'b' }], unique: false, primary: false },
      ],
    });
    const diff = diffTables(withIndexes, desired);
    expect(diff.addedIndexes.map((i) => i.name)).toEqual(['add_me']);
    expect(diff.droppedIndexes.map((i) => i.name)).toEqual(['drop_me']);
    expect(diff.changedIndexes.map((c) => c.name)).toEqual(['change_me']);
    expect(diff.isEmpty).toBe(false);
  });

  it('notices a rename of the table itself', () => {
    const diff = diffTables(base, table({ ...base, name: 'u' }));
    expect(diff.renamedTable).toEqual({ from: 't', to: 'u' });
    expect(diff.isEmpty).toBe(false);
  });
});

describe('preview and execution stay in step', () => {
  it('produces one display string per prepared statement', () => {
    const cs: Changeset = {
      table: 't',
      keyColumns: ['id'],
      changes: [
        { op: 'insert', values: { a: 1, b: 'two' } },
        { op: 'update', key: { id: 1 }, values: { a: 3 } },
        { op: 'delete', key: { id: 2 } },
      ],
    };
    const plan = planChangeset(cs, 'postgres', pg);
    const preview = buildChangesetSql(cs, 'postgres', pg);

    expect(preview.statements).toEqual(plan.statements.map((s) => s.display));
    expect(preview.expectedAffected).toEqual(plan.statements.map((s) => s.expected));
    // Same shape, different rendering of the values.
    expect(plan.statements[0].sql).toBe('INSERT INTO "t" ("a", "b") VALUES ($1, $2)');
    expect(plan.statements[0].display).toBe(`INSERT INTO "t" ("a", "b") VALUES (1, 'two')`);
  });
});
