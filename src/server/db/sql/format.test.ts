/**
 * Unit tests for the SQL formatter wrapper (docs/roadmap.md M10).
 *
 * The formatting itself is sql-formatter's problem. What is ours is the
 * boundary: that our dialects map to its languages, that the things this app
 * puts into a buffer survive a round trip — bind placeholders, multiple
 * statements, MySQL DELIMITER blocks — and above all that a formatter which
 * mangles a statement is refused rather than written back over the user's SQL.
 */

import { describe, expect, it } from 'vitest';

import { FormatRefusedError, formatSql } from './format';
import { splitStatements } from './lexer';

describe('formatSql', () => {
  it('formats a flat statement onto readable lines', () => {
    const out = formatSql('select a,b from t where a=1', 'postgres');
    expect(out).toContain('SELECT');
    expect(out).toContain('FROM');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('is idempotent — formatting formatted SQL changes nothing', () => {
    const once = formatSql('select a,b from t where a=1', 'postgres');
    expect(formatSql(once, 'postgres')).toBe(once);
  });

  it('honours each dialect rather than formatting everything as one', () => {
    // Backtick identifiers are MySQL-only; a Postgres run must not invent them.
    const my = formatSql('select `a` from `t`', 'mysql');
    expect(my).toContain('`a`');
    const pg = formatSql('select "a" from "t"', 'postgres');
    expect(pg).toContain('"a"');
  });

  it('applies the requested indent width', () => {
    const two = formatSql('select a, b from t', 'postgres', { indent: 2 });
    const four = formatSql('select a, b from t', 'postgres', { indent: 4 });
    expect(four.length).toBeGreaterThan(two.length);
  });

  it('can leave keyword case alone', () => {
    const preserved = formatSql('select a from t', 'postgres', { keywordCase: 'preserve' });
    expect(preserved).toContain('select');
  });

  it('preserves named bind placeholders', () => {
    // The generated templates from dml.ts are full of these, and formatting is
    // the first thing someone does to a generated statement.
    const out = formatSql('insert into t (a,b) values (:a,:b)', 'postgres');
    expect(out).toContain(':a');
    expect(out).toContain(':b');
  });

  it('preserves positional and numbered placeholders', () => {
    expect(formatSql('select * from t where a=?', 'mysql')).toContain('?');
    expect(formatSql('select * from t where a=$1', 'postgres')).toContain('$1');
  });

  it('keeps every statement of a multi-statement script', () => {
    const out = formatSql('select 1; select 2; select 3', 'postgres');
    expect(splitStatements(out, 'postgres')).toHaveLength(3);
  });

  it('preserves a dollar-quoted body verbatim', () => {
    const body = "DO $$ BEGIN PERFORM 'a b  c'; END $$;";
    const out = formatSql(body, 'postgres');
    expect(out).toContain("'a b  c'");
  });

  it('leaves a MySQL DELIMITER script completely alone', () => {
    // sql-formatter does not understand DELIMITER and would read the `;` inside
    // the body as a terminator. The guard cannot catch the result, because a
    // mangled body can still re-lex to the same statement count and kinds.
    const sql = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END $$\nDELIMITER ;';
    expect(formatSql(sql, 'mysql')).toBe(sql);
  });

  it('still formats MySQL without a DELIMITER command', () => {
    expect(formatSql('select a from t', 'mysql')).toContain('SELECT');
  });

  it('leaves an empty or whitespace-only buffer alone', () => {
    expect(formatSql('', 'postgres')).toBe('');
    expect(formatSql('   \n  ', 'postgres')).toBe('   \n  ');
  });
});

describe('the guard', () => {
  it('refuses a format that changes how many statements there are', () => {
    const mangle = () => 'SELECT 1; SELECT 2';
    expect(() => formatSql('SELECT 1', 'postgres', {}, mangle)).toThrow(FormatRefusedError);
  });

  it('refuses a format that changes what a statement does', () => {
    // The nightmare case: a formatter bug turns a SELECT into a DELETE and the
    // editor writes it back without asking.
    const mangle = () => 'DELETE FROM t';
    expect(() => formatSql('SELECT * FROM t', 'postgres', {}, mangle)).toThrow(FormatRefusedError);
  });

  it('names the buffer as unchanged in the refusal, so the caller can say so', () => {
    try {
      formatSql('SELECT 1', 'postgres', {}, () => 'DROP TABLE t');
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(FormatRefusedError);
      expect((err as Error).message).toMatch(/unchanged/i);
    }
  });

  it('accepts a format that only changes whitespace and case', () => {
    expect(() => formatSql('select   1', 'postgres')).not.toThrow();
  });

  it('turns a formatter crash into a refusal rather than propagating it', () => {
    const boom = () => {
      throw new Error('nearley exploded');
    };
    expect(() => formatSql('SELECT 1', 'postgres', {}, boom)).toThrow(FormatRefusedError);
  });
});
