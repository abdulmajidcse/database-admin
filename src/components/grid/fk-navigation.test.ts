/**
 * Unit tests for foreign-key navigation (docs/roadmap.md M10).
 *
 * The failure that matters is a filter that matches the wrong rows: a NULL key
 * turned into a match-everything filter, a composite key half-applied, or a
 * same-named table in another schema treated as the same table. All three are
 * silent — you get rows, just not the right ones.
 */

import { describe, expect, it } from 'vitest';

import type { SchemaModel, TableModel, TypeDescriptor } from '@/lib/schema-model';
import type { Cell } from '@/lib/wire';
import { incomingFor, outgoingFor } from './fk-navigation';

const t: TypeDescriptor = { raw: 'text', base: 'text' };

function tableOf(name: string, over: Partial<TableModel> = {}): TableModel {
  return {
    name,
    kind: 'table',
    columns: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
    primaryKey: [],
    ...over,
  };
}

const orders = tableOf('orders', {
  schema: 'public',
  columns: [
    { name: 'id', position: 1, type: t, nullable: false, defaultValue: null },
    { name: 'customer_id', position: 2, type: t, nullable: true, defaultValue: null },
  ],
  foreignKeys: [
    { name: 'fk_customer', columns: ['customer_id'], refSchema: 'public', refTable: 'customers', refColumns: ['id'] },
  ],
});

const customers = tableOf('customers', { schema: 'public' });

const model: SchemaModel = {
  engine: 'postgres',
  namespaces: [{ name: 'public', tables: [orders, customers], routines: [], sequences: [], triggers: [], enums: [] }],
} as unknown as SchemaModel;

const ORDER_COLS = ['id', 'customer_id'];

describe('outgoingFor', () => {
  it('follows a foreign key to the referenced row', () => {
    const out = outgoingFor(orders, 'customer_id', ['o1', 'c9'] as Cell[], ORDER_COLS);
    expect(out).toHaveLength(1);
    expect(out[0].table).toBe('customers');
    expect(out[0].filters).toEqual([{ column: 'id', op: 'eq', value: 'c9' }]);
  });

  it('offers nothing for a column in no foreign key', () => {
    expect(outgoingFor(orders, 'id', ['o1', 'c9'] as Cell[], ORDER_COLS)).toEqual([]);
  });

  it('offers nothing when the key value is NULL', () => {
    // A filter built from NULL would match on `= NULL`, which matches nothing,
    // or worse be dropped and match everything.
    expect(outgoingFor(orders, 'customer_id', ['o1', null] as Cell[], ORDER_COLS)).toEqual([]);
  });

  it('offers every foreign key a column takes part in', () => {
    const multi = tableOf('x', {
      columns: [{ name: 'a', position: 1, type: t, nullable: true, defaultValue: null }],
      foreignKeys: [
        { name: 'f1', columns: ['a'], refTable: 'p', refColumns: ['id'] },
        { name: 'f2', columns: ['a'], refTable: 'q', refColumns: ['id'] },
      ],
    });
    expect(outgoingFor(multi, 'a', ['1'] as Cell[], ['a']).map((d) => d.table)).toEqual(['p', 'q']);
  });

  it('applies every column of a composite key', () => {
    const comp = tableOf('x', {
      foreignKeys: [{ name: 'f', columns: ['a', 'b'], refTable: 'p', refColumns: ['pa', 'pb'] }],
    });
    const out = outgoingFor(comp, 'a', ['1', '2'] as Cell[], ['a', 'b']);
    expect(out[0].filters).toEqual([
      { column: 'pa', op: 'eq', value: '1' },
      { column: 'pb', op: 'eq', value: '2' },
    ]);
  });
});

describe('incomingFor', () => {
  it('finds tables referencing this row', () => {
    const out = incomingFor(model, customers, ['c9'] as Cell[], ['id']);
    expect(out).toHaveLength(1);
    expect(out[0].table).toBe('orders');
    expect(out[0].filters).toEqual([{ column: 'customer_id', op: 'eq', value: 'c9' }]);
  });

  it('offers nothing when nothing references the table', () => {
    expect(incomingFor(model, orders, ['o1', 'c9'] as Cell[], ORDER_COLS)).toEqual([]);
  });

  it('does not treat a same-named table in another schema as the target', () => {
    const other = tableOf('customers', { schema: 'archive' });
    expect(incomingFor(model, other, ['c9'] as Cell[], ['id'])).toEqual([]);
  });

  it('offers nothing when the referenced column is not among the visible ones', () => {
    // The row simply does not carry the value the filter would need.
    expect(incomingFor(model, customers, ['c9'] as Cell[], ['something_else'])).toEqual([]);
  });
});
