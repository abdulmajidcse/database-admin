/**
 * Unit tests for the DML renderer (PLAN §13 "Unit: … changeset→SQL generator,
 * quoting functions"; docs/roadmap.md M10).
 *
 * Two callers share this module and they fail differently. The grid's "copy as
 * INSERT" renders real values, so the dangerous bugs are lossy ones: a bigint
 * that becomes a rounded double, a NULL that becomes the string "NULL", bytes
 * that lose their encoding. The tree's "generate SQL" renders a template with
 * no values at all, so the dangerous bug is a placeholder that does not survive
 * the lexer that is about to scan it for bind parameters.
 */

import { describe, expect, it } from 'vitest';

import type { ColumnModel, TableModel, TypeDescriptor } from '../../../lib/schema-model';
import type { Row } from '../../../lib/wire';
import { tag } from '../../../lib/wire';
import {
  renderDeleteTemplate,
  renderInsertRows,
  renderInsertTemplate,
  renderSelectTemplate,
  renderUpdateRow,
  renderUpdateTemplate,
} from './dml';

const text: TypeDescriptor = { raw: 'text', base: 'text' };
const int8: TypeDescriptor = { raw: 'bigint', base: 'bigint' };

function column(name: string, over: Partial<ColumnModel> = {}): ColumnModel {
  return { name, position: 1, type: text, nullable: true, defaultValue: null, ...over };
}

function table(over: Partial<TableModel> = {}): TableModel {
  return {
    name: 'users',
    schema: 'public',
    kind: 'table',
    columns: [column('id', { type: int8, nullable: false }), column('email'), column('note')],
    indexes: [],
    foreignKeys: [],
    checks: [],
    primaryKey: ['id'],
    ...over,
  };
}

const COLS = ['id', 'email', 'note'];

// ---------------------------------------------------------------------------
// Templates — what the object tree generates
// ---------------------------------------------------------------------------

describe('templates', () => {
  it('renders a SELECT naming every column rather than *', () => {
    // `*` re-orders itself when someone adds a column; an explicit list does not.
    expect(renderSelectTemplate(table(), 'postgres')).toBe(
      'SELECT "id", "email", "note"\nFROM "public"."users"\nLIMIT 100;',
    );
  });

  it('quotes per engine', () => {
    expect(renderSelectTemplate(table({ schema: undefined }), 'mysql')).toContain('FROM `users`');
    expect(renderSelectTemplate(table({ schema: undefined }), 'sqlite')).toContain('FROM "users"');
  });

  it('renders INSERT with named placeholders the params bar can find', () => {
    expect(renderInsertTemplate(table(), 'postgres')).toBe(
      'INSERT INTO "public"."users" ("id", "email", "note")\nVALUES (:id, :email, :note);',
    );
  });

  it('omits generated and auto-increment columns from an INSERT template', () => {
    const t = table({
      columns: [
        column('id', { autoIncrement: true }),
        column('email'),
        column('slug', { generated: 'stored', generatedExpression: 'lower(email)' }),
      ],
    });
    const sql = renderInsertTemplate(t, 'postgres');
    expect(sql).toContain('("email")');
    expect(sql).not.toContain('id');
    expect(sql).not.toContain('slug');
  });

  it('keys UPDATE and DELETE templates on the primary key', () => {
    expect(renderUpdateTemplate(table(), 'postgres')).toBe(
      'UPDATE "public"."users"\nSET "email" = :email,\n    "note" = :note\nWHERE "id" = :id;',
    );
    expect(renderDeleteTemplate(table(), 'postgres')).toBe(
      'DELETE FROM "public"."users"\nWHERE "id" = :id;',
    );
  });

  it('refuses an UPDATE or DELETE template for a table with no primary key', () => {
    // Silently emitting an unkeyed UPDATE is how you rewrite a whole table.
    const t = table({ primaryKey: [] });
    expect(() => renderUpdateTemplate(t, 'postgres')).toThrow(/primary key/i);
    expect(() => renderDeleteTemplate(t, 'postgres')).toThrow(/primary key/i);
  });

  it('uses every key column of a composite primary key', () => {
    const t = table({ primaryKey: ['id', 'email'] });
    const sql = renderDeleteTemplate(t, 'postgres');
    expect(sql).toBe('DELETE FROM "public"."users"\nWHERE "id" = :id AND "email" = :email;');
  });

  it('names placeholders so a column needing quotes stays a legal placeholder', () => {
    // ":order date" would not lex as one placeholder, so odd names fall back to
    // positional style rather than emitting something the parser will misread.
    const t = table({ columns: [column('order date')], primaryKey: [] });
    expect(renderInsertTemplate(t, 'postgres')).toContain('VALUES (?)');
  });
});

// ---------------------------------------------------------------------------
// Values — what the grid copies
// ---------------------------------------------------------------------------

describe('rows', () => {
  const target = { schema: 'public', table: 'users' };

  it('renders one INSERT carrying several rows', () => {
    const rows: Row[] = [
      [1, 'a@example.com', null],
      [2, 'b@example.com', 'hi'],
    ];
    expect(renderInsertRows(target, COLS, rows, 'postgres')).toBe(
      'INSERT INTO "public"."users" ("id", "email", "note") VALUES\n' +
        "  (1, 'a@example.com', NULL),\n" +
        "  (2, 'b@example.com', 'hi');",
    );
  });

  it('keeps a bigint lossless instead of rounding it through a double', () => {
    const rows: Row[] = [[tag('bigint', '9007199254740993'), 'a@example.com', null]];
    const sql = renderInsertRows(target, COLS, rows, 'postgres');
    expect(sql).toContain('9007199254740993');
    expect(sql).not.toContain('9007199254740992');
  });

  it('writes NULL unquoted and the literal string "NULL" quoted', () => {
    const rows: Row[] = [[1, 'NULL', null]];
    const sql = renderInsertRows(target, COLS, rows, 'postgres');
    expect(sql).toContain("'NULL'");
    expect(sql).toContain(', NULL)');
  });

  it('escapes a quote in a value rather than closing the literal', () => {
    const rows: Row[] = [[1, "o'brien@example.com", null]];
    expect(renderInsertRows(target, COLS, rows, 'postgres')).toContain("'o''brien@example.com'");
  });

  it('escapes an identifier that tries to close its own quote', () => {
    const sql = renderInsertRows({ table: 'we"ird' }, ['a'], [[1]], 'postgres');
    expect(sql).toContain('"we""ird"');
  });

  it('renders an UPDATE keyed on the given columns, excluding them from SET', () => {
    const sql = renderUpdateRow(target, COLS, [7, 'z@example.com', 'note'], ['id'], 'postgres');
    expect(sql).toBe(
      'UPDATE "public"."users"\n' +
        "SET \"email\" = 'z@example.com',\n" +
        "    \"note\" = 'note'\n" +
        'WHERE "id" = 7;',
    );
  });

  it('matches a NULL key with IS NULL, which = never matches', () => {
    const sql = renderUpdateRow(target, COLS, [null, 'z@example.com', null], ['id'], 'postgres');
    expect(sql).toContain('WHERE "id" IS NULL');
  });

  it('refuses an UPDATE with no key columns', () => {
    expect(() => renderUpdateRow(target, COLS, [1, 'a', null], [], 'postgres')).toThrow(/key/i);
  });

  it('refuses a row whose width does not match the column list', () => {
    expect(() => renderInsertRows(target, COLS, [[1, 'a']], 'postgres')).toThrow(/columns/i);
  });

  it('rejects an empty row set rather than emitting invalid SQL', () => {
    expect(() => renderInsertRows(target, COLS, [], 'postgres')).toThrow(/no rows/i);
  });

  it('doubles backslashes for MySQL but not for SQLite', () => {
    const rows: Row[] = [[1, 'a\\b', null]];
    expect(renderInsertRows(target, COLS, rows, 'mysql')).toContain("'a\\\\b'");
    expect(renderInsertRows(target, COLS, rows, 'sqlite')).toContain("'a\\b'");
  });
});
