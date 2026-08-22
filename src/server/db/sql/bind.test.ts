/**
 * Unit tests for parameter binding (docs/roadmap.md M10).
 *
 * The whole point of binding is that a value never becomes SQL. So the tests
 * that matter are the ones proving a hostile value stays a value: a name that
 * looks like SQL, a value containing the placeholder syntax, a name appearing
 * inside a string literal that must NOT be rewritten.
 */

import { describe, expect, it } from 'vitest';

import { BindError, bindStatement } from './bind';

describe('bindStatement', () => {
  it('leaves a statement with no placeholders alone', () => {
    const out = bindStatement('SELECT 1', 'postgres', 'postgres', {});
    expect(out.sql).toBe('SELECT 1');
    expect(out.params).toEqual([]);
  });

  it('rewrites named placeholders to Postgres numbering', () => {
    const out = bindStatement(
      'SELECT * FROM t WHERE a = :id AND b = :name',
      'postgres',
      'postgres',
      { id: 7, name: 'x' },
    );
    expect(out.sql).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(out.params).toEqual([7, 'x']);
  });

  it('rewrites named placeholders to question marks for MySQL', () => {
    const out = bindStatement('SELECT * FROM t WHERE a = :id', 'mysql', 'mysql', { id: 7 });
    expect(out.sql).toBe('SELECT * FROM t WHERE a = ?');
    expect(out.params).toEqual([7]);
  });

  it('reuses one Postgres placeholder for a repeated name', () => {
    const out = bindStatement('SELECT :a, :b, :a', 'postgres', 'postgres', { a: 1, b: 2 });
    expect(out.sql).toBe('SELECT $1, $2, $1');
    expect(out.params).toEqual([1, 2]);
  });

  it('repeats the value for a repeated name where placeholders are positional', () => {
    // `?` cannot refer back, so the value has to be bound twice.
    const out = bindStatement('SELECT :a, :b, :a', 'mysql', 'mysql', { a: 1, b: 2 });
    expect(out.sql).toBe('SELECT ?, ?, ?');
    expect(out.params).toEqual([1, 2, 1]);
  });

  it('does not rewrite something that only looks like a placeholder', () => {
    const out = bindStatement("SELECT ':id' , :id", 'postgres', 'postgres', { id: 5 });
    expect(out.sql).toBe("SELECT ':id' , $1");
    expect(out.params).toEqual([5]);
  });

  it('keeps a value that contains placeholder syntax as data', () => {
    const out = bindStatement('SELECT :a', 'postgres', 'postgres', { a: ':b OR 1=1 --' });
    expect(out.sql).toBe('SELECT $1');
    expect(out.params).toEqual([':b OR 1=1 --']);
  });

  it('binds NULL rather than dropping the parameter', () => {
    const out = bindStatement('SELECT :a', 'postgres', 'postgres', { a: null });
    expect(out.params).toEqual([null]);
  });

  it('names the missing parameter when a value was not supplied', () => {
    expect(() => bindStatement('SELECT :a, :b', 'postgres', 'postgres', { a: 1 })).toThrow(BindError);
    expect(() => bindStatement('SELECT :a, :b', 'postgres', 'postgres', { a: 1 })).toThrow(/\bb\b/);
  });

  it('passes a statement already in the engine style through untouched', () => {
    const out = bindStatement('SELECT * FROM t WHERE a = $1', 'postgres', 'postgres', {}, [9]);
    expect(out.sql).toBe('SELECT * FROM t WHERE a = $1');
    expect(out.params).toEqual([9]);
  });

  it('refuses a statement mixing named and positional placeholders', () => {
    // The ordering of the two kinds against one params array is ambiguous, and
    // guessing it wrong binds values to the wrong columns.
    expect(() => bindStatement('SELECT :a, ?', 'mysql', 'mysql', { a: 1 })).toThrow(/mix/i);
  });

  it('refuses when a positional statement gets the wrong number of values', () => {
    expect(() => bindStatement('SELECT ?, ?', 'mysql', 'mysql', {}, [1])).toThrow(BindError);
  });

  it('passes a positional statement through when no values were supplied', () => {
    // Binding is opt-in. Refusing here would break every script containing a
    // `?` the user never meant as a placeholder.
    const out = bindStatement('SELECT ?, ?', 'mysql', 'mysql', {});
    expect(out.sql).toBe('SELECT ?, ?');
    expect(out.params).toEqual([]);
  });

  it('leaves a Postgres jsonb ? operator alone', () => {
    const sql = "SELECT data ? 'key' FROM t";
    expect(bindStatement(sql, 'postgres', 'postgres', {}).sql).toBe(sql);
  });

  it('ignores a Postgres cast while binding around it', () => {
    const out = bindStatement("SELECT '1'::int, :a", 'postgres', 'postgres', { a: 2 });
    expect(out.sql).toBe("SELECT '1'::int, $1");
    expect(out.params).toEqual([2]);
  });

  it('does not touch a placeholder inside a dollar-quoted body', () => {
    const sql = 'DO $$ BEGIN PERFORM :nope; END $$';
    expect(bindStatement(sql, 'postgres', 'postgres', {}).sql).toBe(sql);
  });
});
