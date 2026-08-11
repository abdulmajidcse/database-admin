/**
 * Unit tests for the statement lexer, the quoting chokepoint and the filter
 * builder (PLAN §13 "Unit: statement lexer (a nasty fixture corpus), quoting
 * functions").
 *
 * The fixtures are deliberately hostile: every construct here is one that a
 * naive `sql.split(';')` gets wrong, and several are pairs that must be read
 * DIFFERENTLY per dialect.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyStatement,
  dialectForEngine,
  isDestructive,
  splitStatements,
  statementAtOffset,
  type SqlDialect,
} from './lexer';
import { quoteIdent, quoteLiteral, quoteQualified, quoterFor } from './quote';
import { buildConditions, buildWhere, escapeLikePattern } from './filters';

const texts = (sql: string, dialect: SqlDialect): string[] =>
  splitStatements(sql, dialect).map((s) => s.text);

describe('splitStatements: the basics', () => {
  it('splits on semicolons and drops the terminator', () => {
    expect(texts('SELECT 1; SELECT 2', 'postgres')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('reports offsets that slice back to the exact text', () => {
    const sql = 'SELECT 1; SELECT 2';
    for (const s of splitStatements(sql, 'postgres')) {
      expect(sql.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it('returns nothing for empty, blank or comment-only input', () => {
    expect(splitStatements('', 'postgres')).toEqual([]);
    expect(splitStatements('   \n\t  ', 'postgres')).toEqual([]);
    expect(splitStatements('-- nothing here\n/* nor here */', 'postgres')).toEqual([]);
    expect(splitStatements(';;;', 'postgres')).toEqual([]);
  });

  it('tolerates a missing final terminator', () => {
    expect(texts('SELECT 1;\nSELECT 2', 'sqlite')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('numbers lines from 1', () => {
    const sql = 'SELECT 1;\nSELECT 2;\n\nSELECT 3;';
    expect(splitStatements(sql, 'postgres').map((s) => s.line)).toEqual([1, 2, 4]);
  });

  it('handles CRLF without leaking the carriage return into the text', () => {
    const sql = 'SELECT 1;\r\nSELECT 2;\r\n';
    expect(texts(sql, 'postgres')).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('splitStatements: string literals', () => {
  it('ignores semicolons inside single quotes', () => {
    expect(texts("SELECT 'a;b';", 'postgres')).toEqual(["SELECT 'a;b'"]);
  });

  it('understands doubled quotes', () => {
    expect(texts("SELECT 'it''s; fine';", 'postgres')).toEqual(["SELECT 'it''s; fine'"]);
    expect(texts("SELECT 'it''s; fine';", 'mysql')).toEqual(["SELECT 'it''s; fine'"]);
    expect(texts("SELECT 'it''s; fine';", 'sqlite')).toEqual(["SELECT 'it''s; fine'"]);
  });

  it("reads \\' as an escape in MySQL but not in Postgres", () => {
    const sql = "SELECT 'a\\'b;c' FROM t;";
    // MySQL: the quote is escaped, so the whole thing is one string literal.
    expect(texts(sql, 'mysql')).toEqual(["SELECT 'a\\'b;c' FROM t"]);
    // Postgres (standard_conforming_strings): the backslash is data, the string
    // ends at the second quote and the `;` really is a separator.
    expect(splitStatements(sql, 'postgres').length).toBe(2);
    expect(texts(sql, 'postgres')[0]).toBe("SELECT 'a\\'b");
  });

  it('honours backslashes inside a Postgres E-string', () => {
    const sql = "SELECT E'\\';' ; SELECT 2;";
    expect(texts(sql, 'postgres')).toEqual(["SELECT E'\\';'", 'SELECT 2']);
  });

  it('does not treat a trailing E of an identifier as an escape-string prefix', () => {
    // `nameE'x'` is the identifier `nameE` followed by a literal.
    const sql = "SELECT nameE'\\' , 1;";
    expect(splitStatements(sql, 'postgres').length).toBe(1);
  });

  it('leaves N/B/X literal prefixes alone', () => {
    expect(texts("SELECT N'a;b', X'4142';", 'mysql')).toEqual(["SELECT N'a;b', X'4142'"]);
  });

  it('runs an unterminated string to end of input instead of hanging', () => {
    expect(texts("SELECT 'abc", 'postgres')).toEqual(["SELECT 'abc"]);
  });
});

describe('splitStatements: quoted identifiers', () => {
  it('ignores semicolons inside double quotes, doubling included', () => {
    const sql = 'SELECT "a""b;c" FROM t;';
    expect(texts(sql, 'postgres')).toEqual(['SELECT "a""b;c" FROM t']);
    expect(texts(sql, 'sqlite')).toEqual(['SELECT "a""b;c" FROM t']);
    expect(texts(sql, 'mysql')).toEqual(['SELECT "a""b;c" FROM t']);
  });

  it('ignores semicolons inside MySQL backticks, doubling included', () => {
    const sql = 'SELECT `a``b;c` FROM t;';
    expect(texts(sql, 'mysql')).toEqual(['SELECT `a``b;c` FROM t']);
  });

  it('treats brackets as identifier quotes only for SQLite', () => {
    const sql = 'SELECT [a;b] FROM [t];';
    expect(texts(sql, 'sqlite')).toEqual(['SELECT [a;b] FROM [t]']);
    // In Postgres `[` is an array subscript, so the semicolon still separates.
    expect(splitStatements(sql, 'postgres').length).toBe(2);
  });
});

describe('splitStatements: comments', () => {
  it('ignores semicolons in a double-dash comment', () => {
    const sql = 'SELECT 1; -- trailing ; comment\nSELECT 2;';
    const stmts = splitStatements(sql, 'postgres');
    expect(stmts.length).toBe(2);
    expect(stmts[0].text).toBe('SELECT 1');
    expect(stmts[1].text.endsWith('SELECT 2')).toBe(true);
  });

  it('requires whitespace after -- in MySQL only', () => {
    const sql = 'SELECT 1--2;\nSELECT 3;';
    // MySQL reads `1--2` as arithmetic, so the `;` separates.
    expect(texts(sql, 'mysql')).toEqual(['SELECT 1--2', 'SELECT 3']);
    // Postgres comments out the rest of the line, `;` included.
    expect(splitStatements(sql, 'postgres').length).toBe(1);
  });

  it('treats # as a comment in MySQL and as an operator elsewhere', () => {
    const sql = 'SELECT 1 # c ; more\nSELECT 2;';
    expect(splitStatements(sql, 'mysql').length).toBe(1);
    expect(splitStatements(sql, 'postgres').length).toBe(2);
  });

  it('nests block comments for Postgres but not for MySQL/SQLite', () => {
    const sql = '/* a /* b */ SELECT 1; SELECT 2;';
    // Postgres: still one comment deep at EOF, so nothing is runnable.
    expect(splitStatements(sql, 'postgres')).toEqual([]);
    // MySQL/SQLite: the comment closed at the first terminator.
    expect(splitStatements(sql, 'mysql').length).toBe(2);
    expect(splitStatements(sql, 'sqlite').length).toBe(2);
  });

  it('keeps a MySQL bang comment as a statement of its own', () => {
    const sql = '/*!40101 SET NAMES utf8 */;\nSELECT 1;';
    expect(texts(sql, 'mysql')).toEqual(['/*!40101 SET NAMES utf8 */', 'SELECT 1']);
  });

  it('drops a plain comment-only chunk', () => {
    expect(texts('/* plain */;\nSELECT 1;', 'postgres')).toEqual(['SELECT 1']);
  });

  it('keeps a leading comment attached to the statement it introduces', () => {
    const stmts = splitStatements('-- name: users\nSELECT 1;', 'postgres');
    expect(stmts.length).toBe(1);
    expect(stmts[0].text).toBe('-- name: users\nSELECT 1');
  });

  it('runs an unterminated block comment to end of input', () => {
    expect(splitStatements('SELECT 1 /* oops', 'postgres').length).toBe(1);
  });
});

describe('splitStatements: Postgres dollar quoting', () => {
  it('protects a function body wrapped in the empty tag', () => {
    const sql = [
      'CREATE FUNCTION f() RETURNS int AS $$',
      'BEGIN',
      '  SELECT 1; SELECT 2;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'SELECT 3;',
    ].join('\n');
    const stmts = splitStatements(sql, 'postgres');
    expect(stmts.length).toBe(2);
    expect(stmts[0].text.endsWith('$$ LANGUAGE plpgsql')).toBe(true);
    expect(stmts[1].text).toBe('SELECT 3');
    // The same script is butchered without dollar-quoting, which is exactly why
    // the dialect flag exists.
    expect(splitStatements(sql, 'mysql').length).toBe(5);
  });

  it('protects a tagged body that contains a bare $$ and a semicolon', () => {
    const sql = [
      'CREATE FUNCTION g() RETURNS text AS $body$',
      "  SELECT 'x;y'; -- $$ is not the end",
      '$body$ LANGUAGE sql;',
      'SELECT 1;',
    ].join('\n');
    const stmts = splitStatements(sql, 'postgres');
    expect(stmts.length).toBe(2);
    expect(stmts[1].text).toBe('SELECT 1');
  });

  it('does not mistake $1 placeholders for a dollar quote', () => {
    const sql = 'SELECT $1, $2 FROM t WHERE a = $1;\nSELECT 3;';
    expect(texts(sql, 'postgres')).toEqual(['SELECT $1, $2 FROM t WHERE a = $1', 'SELECT 3']);
  });

  it('handles a dollar string that holds only a semicolon', () => {
    expect(texts('SELECT $$;$$;', 'postgres')).toEqual(['SELECT $$;$$']);
  });

  it('runs an unterminated dollar quote to end of input', () => {
    expect(splitStatements('SELECT $tag$ abc; def', 'postgres').length).toBe(1);
  });

  it('ignores dollar quoting outside Postgres', () => {
    expect(splitStatements('SELECT $$;$$;', 'mysql').length).toBe(2);
  });
});

describe('splitStatements: MySQL DELIMITER', () => {
  const proc = [
    'DELIMITER //',
    'CREATE PROCEDURE p()',
    'BEGIN',
    '  SELECT 1;',
    '  SELECT 2;',
    'END//',
    'DELIMITER ;',
    'SELECT 3;',
  ].join('\n');

  it('keeps a routine body whole and restores the default terminator', () => {
    const stmts = splitStatements(proc, 'mysql');
    expect(stmts.length).toBe(2);
    expect(stmts[0].text.startsWith('CREATE PROCEDURE p()')).toBe(true);
    expect(stmts[0].text.includes('SELECT 1;')).toBe(true);
    expect(stmts[0].text.endsWith('END')).toBe(true);
    expect(stmts[0].delimiter).toBe('//');
    expect(stmts[1].text).toBe('SELECT 3');
    expect(stmts[1].delimiter).toBe(';');
  });

  it('never emits the DELIMITER command itself — the server would reject it', () => {
    for (const s of splitStatements(proc, 'mysql')) {
      expect(s.text.toUpperCase()).not.toContain('DELIMITER');
    }
  });

  it('accepts a doubled-semicolon delimiter', () => {
    const sql = ['DELIMITER ;;', 'CREATE TRIGGER t BEGIN SELECT 1; END;;', 'DELIMITER ;'].join('\n');
    expect(texts(sql, 'mysql')).toEqual(['CREATE TRIGGER t BEGIN SELECT 1; END']);
  });

  it('accepts a quoted delimiter argument', () => {
    const sql = ["DELIMITER '$$'", 'SELECT 1; SELECT 2$$'].join('\n');
    expect(texts(sql, 'mysql')).toEqual(['SELECT 1; SELECT 2']);
  });

  it('is a MySQL-only command', () => {
    const sql = 'DELIMITER //\nSELECT 1;';
    expect(texts(sql, 'postgres')).toEqual(['DELIMITER //\nSELECT 1']);
  });

  it('does not fire on an identifier that merely starts with delimiter', () => {
    expect(texts('SELECT delimiter_col FROM t;', 'mysql')).toEqual([
      'SELECT delimiter_col FROM t',
    ]);
  });
});

describe('splitStatements: combined nastiness', () => {
  const corpus: { name: string; sql: string; dialect: SqlDialect; count: number }[] = [
    {
      name: 'quotes, comments and dollar bodies in one script',
      dialect: 'postgres',
      count: 4,
      sql: [
        "INSERT INTO t (a) VALUES ('semi; colon');",
        '/* block ; comment */',
        "UPDATE t SET a = 'dash -- not a comment' WHERE b = 1;",
        'CREATE FUNCTION h() RETURNS void AS $h$ BEGIN DELETE FROM t; END $h$ LANGUAGE plpgsql;',
        '-- trailing note ;',
        'SELECT 1;',
      ].join('\n'),
    },
    {
      name: 'mysql dump preamble',
      dialect: 'mysql',
      count: 3,
      sql: [
        '/*!40101 SET @OLD_MODE=@@SQL_MODE */;',
        '# a hash comment with ; inside',
        'INSERT INTO `weird;name` VALUES (\'a\\\'b\', "c;d");',
        'SELECT 1;',
      ].join('\n'),
    },
  ];

  for (const c of corpus) {
    it(c.name, () => {
      const stmts = splitStatements(c.sql, c.dialect);
      expect(stmts.length).toBe(c.count);
      for (const s of stmts) {
        expect(c.sql.slice(s.start, s.end)).toBe(s.text);
        expect(s.text.trim()).toBe(s.text);
      }
    });
  }
});

describe('statementAtOffset', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';

  it('returns the statement containing the caret', () => {
    expect(statementAtOffset(sql, 3, 'postgres')?.text).toBe('SELECT 1');
    expect(statementAtOffset(sql, 12, 'postgres')?.text).toBe('SELECT 2');
    expect(statementAtOffset(sql, 20, 'postgres')?.text).toBe('SELECT 3');
  });

  it('includes both boundaries', () => {
    expect(statementAtOffset(sql, 0, 'postgres')?.text).toBe('SELECT 1');
    expect(statementAtOffset(sql, 8, 'postgres')?.text).toBe('SELECT 1');
  });

  it('sticks to the statement on the caret line when between statements', () => {
    // Caret sitting on the `;` of the first statement.
    expect(statementAtOffset(sql, 9, 'postgres')?.text).toBe('SELECT 1');
  });

  it('moves to the next statement once the caret is on a later line', () => {
    const withBlank = 'SELECT 1;\n\nSELECT 2;';
    expect(statementAtOffset(withBlank, 10, 'postgres')?.text).toBe('SELECT 2');
  });

  it('clamps out-of-range offsets and returns the last statement at EOF', () => {
    expect(statementAtOffset(sql, sql.length + 500, 'postgres')?.text).toBe('SELECT 3');
    expect(statementAtOffset(sql, -5, 'postgres')?.text).toBe('SELECT 1');
  });

  it('returns null when there is nothing runnable', () => {
    expect(statementAtOffset('-- just a note', 0, 'postgres')).toBeNull();
    expect(statementAtOffset('', 0, 'postgres')).toBeNull();
  });

  it('finds the whole routine body from a caret inside it', () => {
    const sql2 = 'CREATE FUNCTION f() AS $$ SELECT 1; SELECT 2; $$ LANGUAGE sql;\nSELECT 9;';
    expect(statementAtOffset(sql2, 30, 'postgres')?.text.startsWith('CREATE FUNCTION')).toBe(true);
  });
});

describe('classifyStatement', () => {
  const cases: [string, string][] = [
    ['SELECT 1', 'select'],
    ['   -- lead\n  select * from t', 'select'],
    ['(SELECT 1) UNION (SELECT 2)', 'select'],
    ['TABLE users', 'select'],
    ['VALUES (1),(2)', 'select'],
    ['SHOW TABLES', 'select'],
    ['DESCRIBE users', 'select'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'select'],
    ['WITH m AS (INSERT INTO a VALUES (1) RETURNING *) SELECT * FROM m', 'select'],
    ['WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT id FROM x)', 'delete'],
    ['WITH x AS (SELECT 1) UPDATE t SET a = 1', 'update'],
    ['INSERT INTO t VALUES (1)', 'insert'],
    ['REPLACE INTO t VALUES (1)', 'insert'],
    ['UPDATE t SET a = 1', 'update'],
    ['DELETE FROM t', 'delete'],
    ['CREATE TABLE t (a int)', 'ddl'],
    ['ALTER TABLE t ADD COLUMN b int', 'ddl'],
    ['DROP VIEW v', 'ddl'],
    ['TRUNCATE TABLE t', 'ddl'],
    ['GRANT SELECT ON t TO bob', 'ddl'],
    ['BEGIN', 'transaction'],
    ['START TRANSACTION', 'transaction'],
    ['COMMIT', 'transaction'],
    ['ROLLBACK TO SAVEPOINT a', 'transaction'],
    ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'transaction'],
    ['SET search_path = public', 'other'],
    ['EXPLAIN ANALYZE SELECT 1', 'explain'],
    ['EXPLAIN QUERY PLAN SELECT 1', 'explain'],
    ['PRAGMA table_info(t)', 'other'],
    ['CALL do_thing()', 'other'],
    ['', 'other'],
    ['-- only a comment', 'other'],
  ];

  for (const [sql, kind] of cases) {
    it(`${kind}: ${sql || '(empty)'}`, () => {
      expect(classifyStatement(sql)).toBe(kind);
    });
  }

  it('is not fooled by a keyword inside a string', () => {
    expect(classifyStatement("SELECT 'DROP TABLE users'")).toBe('select');
  });
});

describe('isDestructive', () => {
  it('flags DROP and names the target', () => {
    const v = isDestructive('DROP TABLE users');
    expect(v.destructive).toBe(true);
    expect(v.reason).toBe('DROP TABLE users');
  });

  it('sees through IF EXISTS and schema qualification', () => {
    expect(isDestructive('DROP TABLE IF EXISTS public.users').reason).toBe('DROP TABLE public.users');
  });

  it('handles multi-word object types', () => {
    expect(isDestructive('DROP MATERIALIZED VIEW mv').reason).toBe('DROP MATERIALIZED VIEW mv');
  });

  it('does not eat a table whose name is also a keyword', () => {
    expect(isDestructive('DROP TABLE event').reason).toBe('DROP TABLE event');
  });

  it('flags TRUNCATE', () => {
    expect(isDestructive('TRUNCATE TABLE t').destructive).toBe(true);
    expect(isDestructive('TRUNCATE t').reason).toContain('TRUNCATE TABLE t');
  });

  it('flags an unqualified DELETE and clears it once a WHERE appears', () => {
    const v = isDestructive('DELETE FROM t');
    expect(v.destructive).toBe(true);
    expect(v.unqualified).toBe(true);
    expect(v.reason).toContain('DELETE FROM t');
    expect(isDestructive('DELETE FROM t WHERE id = 1').destructive).toBe(false);
  });

  it('flags an unqualified UPDATE', () => {
    const v = isDestructive('UPDATE t SET a = 1');
    expect(v.destructive).toBe(true);
    expect(v.unqualified).toBe(true);
    expect(isDestructive('UPDATE t SET a = 1 WHERE id = 2').destructive).toBe(false);
  });

  it('does not accept a subquery WHERE as qualification', () => {
    // The WHERE belongs to the inner SELECT; every row of `t` is still rewritten.
    const v = isDestructive('UPDATE t SET a = (SELECT max(x) FROM y WHERE z = 1)');
    expect(v.destructive).toBe(true);
    expect(v.unqualified).toBe(true);
  });

  it('is not fooled by SQL inside a string literal', () => {
    expect(isDestructive("DELETE FROM t WHERE name = 'a; DROP TABLE x'").destructive).toBe(false);
    expect(isDestructive("INSERT INTO log VALUES ('DROP TABLE x')").destructive).toBe(false);
  });

  it('scans every statement in a script, not just the first', () => {
    const v = isDestructive('SELECT 1;\nINSERT INTO t VALUES (1);\nDROP TABLE t;');
    expect(v.destructive).toBe(true);
    expect(v.reason).toBe('DROP TABLE t');
  });

  it('flags ALTER ... DROP COLUMN but not DROP CONSTRAINT', () => {
    expect(isDestructive('ALTER TABLE t DROP COLUMN c').destructive).toBe(true);
    expect(isDestructive('ALTER TABLE t DROP COLUMN c').reason).toBe('ALTER TABLE t DROP COLUMN c');
    expect(isDestructive('ALTER TABLE t DROP CONSTRAINT fk_a').destructive).toBe(false);
    expect(isDestructive('ALTER TABLE t ADD COLUMN c int').destructive).toBe(false);
  });

  it('understands MySQL quoting when told the dialect', () => {
    const v = isDestructive('ALTER TABLE `t` DROP `c`', 'mysql');
    expect(v.destructive).toBe(true);
    expect(v.reason).toBe('ALTER TABLE t DROP COLUMN c');
  });

  it('leaves ordinary statements alone', () => {
    expect(isDestructive('SELECT * FROM t').destructive).toBe(false);
    expect(isDestructive('CREATE TABLE t (a int)').destructive).toBe(false);
    expect(isDestructive('').destructive).toBe(false);
  });
});

describe('dialectForEngine', () => {
  it('maps the SQL engines and rejects the rest', () => {
    expect(dialectForEngine('mysql')).toBe('mysql');
    expect(dialectForEngine('mariadb')).toBe('mysql');
    expect(dialectForEngine('postgres')).toBe('postgres');
    expect(dialectForEngine('sqlite')).toBe('sqlite');
    expect(() => dialectForEngine('redis')).toThrow();
  });
});

describe('quoteIdent / quoteLiteral / quoteQualified', () => {
  it('uses backticks for MySQL and MariaDB', () => {
    expect(quoteIdent('users', 'mysql')).toBe('`users`');
    expect(quoteIdent('we`ird', 'mariadb')).toBe('`we``ird`');
  });

  it('uses double quotes for Postgres and SQLite', () => {
    expect(quoteIdent('users', 'postgres')).toBe('"users"');
    expect(quoteIdent('we"ird', 'sqlite')).toBe('"we""ird"');
  });

  it('does not lose case or mangle spaces and dots', () => {
    expect(quoteIdent('My Table.v2', 'postgres')).toBe('"My Table.v2"');
  });

  it('rejects nonsense rather than emitting broken SQL', () => {
    expect(() => quoteIdent('', 'postgres')).toThrow();
    expect(() => quoteIdent('a\u0000b', 'postgres')).toThrow();
    expect(() => quoteIdent('a', 'redis')).toThrow();
    expect(() => quoteIdent('a', 'mongodb')).toThrow();
  });

  it('quotes literals per engine', () => {
    expect(quoteLiteral("O'Brien", 'postgres')).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", 'mysql')).toBe("'O''Brien'");
    expect(quoteLiteral(null, 'postgres')).toBe('NULL');
    expect(quoteLiteral(undefined, 'postgres')).toBe('NULL');
    expect(quoteLiteral(42, 'postgres')).toBe('42');
    expect(quoteLiteral(9007199254740993n, 'postgres')).toBe('9007199254740993');
    expect(quoteLiteral(true, 'postgres')).toBe('TRUE');
    expect(quoteLiteral(false, 'mysql')).toBe('FALSE');
    expect(quoteLiteral(true, 'sqlite')).toBe('1');
  });

  it('escapes backslashes the way each engine reads them', () => {
    // MySQL: backslash is an escape, so it must be doubled.
    expect(quoteLiteral('a\\b', 'mysql')).toBe("'a\\\\b'");
    // Postgres: emitted as an E-string so the value is the same whatever
    // standard_conforming_strings says.
    expect(quoteLiteral('a\\b', 'postgres')).toBe("E'a\\\\b'");
    expect(quoteLiteral('plain', 'postgres')).toBe("'plain'");
    // SQLite has no escape processing at all.
    expect(quoteLiteral('a\\b', 'sqlite')).toBe("'a\\b'");
  });

  it('refuses NUL bytes and non-finite numbers', () => {
    expect(() => quoteLiteral('a\u0000b', 'postgres')).toThrow();
    expect(() => quoteLiteral(Number.NaN, 'postgres')).toThrow();
    expect(() => quoteLiteral(Number.POSITIVE_INFINITY, 'postgres')).toThrow();
  });

  it('joins qualified names and drops empty parts', () => {
    expect(quoteQualified(['public', 'users'], 'postgres')).toBe('"public"."users"');
    expect(quoteQualified([undefined, 'users'], 'postgres')).toBe('"users"');
    expect(quoteQualified([null, '', 'users'], 'mysql')).toBe('`users`');
    expect(() => quoteQualified([undefined, ''], 'postgres')).toThrow();
  });

  it('bundles the three functions per engine', () => {
    const q = quoterFor('mysql');
    expect(q.engine).toBe('mysql');
    expect(q.ident('a')).toBe('`a`');
    expect(q.literal("x'y")).toBe("'x''y'");
    expect(q.qualified(['db', 't'])).toBe('`db`.`t`');
    expect(() => quoterFor('redis')).toThrow();
  });
});

describe('buildWhere', () => {
  it('returns an empty clause for no filters', () => {
    expect(buildWhere([], 'postgres', 'dollar')).toEqual({ sql: '', params: [] });
  });

  it('numbers dollar placeholders and quotes columns', () => {
    const w = buildWhere(
      [
        { column: 'id', op: 'gte', value: '10' },
        { column: 'name', op: 'eq', value: 'bob' },
      ],
      'postgres',
      'dollar',
    );
    expect(w.sql).toBe('WHERE "id" >= $1 AND "name" = $2');
    expect(w.params).toEqual(['10', 'bob']);
  });

  it('uses question marks for MySQL and SQLite', () => {
    const w = buildWhere([{ column: 'id', op: 'ne', value: '1' }], 'mysql', 'qmark');
    expect(w.sql).toBe('WHERE `id` <> ?');
    expect(w.params).toEqual(['1']);
  });

  it('starts dollar numbering where the caller asks', () => {
    const w = buildWhere([{ column: 'a', op: 'lt', value: '5' }], 'postgres', 'dollar', 3);
    expect(w.sql).toBe('WHERE "a" < $3');
  });

  it('covers every comparison operator', () => {
    const ops = [
      ['eq', '='],
      ['ne', '<>'],
      ['lt', '<'],
      ['lte', '<='],
      ['gt', '>'],
      ['gte', '>='],
    ] as const;
    for (const [op, sym] of ops) {
      const w = buildWhere([{ column: 'a', op, value: '1' }], 'sqlite', 'qmark');
      expect(w.sql).toBe(`WHERE "a" ${sym} ?`);
    }
  });

  it('emits null checks without parameters', () => {
    expect(buildWhere([{ column: 'a', op: 'isNull' }], 'postgres', 'dollar')).toEqual({
      sql: 'WHERE "a" IS NULL',
      params: [],
    });
    expect(buildWhere([{ column: 'a', op: 'isNotNull' }], 'postgres', 'dollar')).toEqual({
      sql: 'WHERE "a" IS NOT NULL',
      params: [],
    });
  });

  it('binds both ends of a BETWEEN', () => {
    const w = buildWhere(
      [{ column: 'ts', op: 'between', value: '2020-01-01', value2: '2020-12-31' }],
      'postgres',
      'dollar',
    );
    expect(w.sql).toBe('WHERE "ts" BETWEEN $1 AND $2');
    expect(w.params).toEqual(['2020-01-01', '2020-12-31']);
  });

  it('expands IN and degrades an empty set to a false constant', () => {
    const w = buildWhere([{ column: 'a', op: 'in', values: ['x', 'y'] }], 'postgres', 'dollar');
    expect(w.sql).toBe('WHERE "a" IN ($1, $2)');
    expect(w.params).toEqual(['x', 'y']);

    const empty = buildWhere([{ column: 'a', op: 'in', values: [] }], 'postgres', 'dollar');
    expect(empty.sql).toBe('WHERE 1 = 0');
    expect(empty.params).toEqual([]);
  });

  it('builds LIKE patterns with an explicit escape character', () => {
    const pg = buildWhere([{ column: 'a', op: 'contains', value: 'x' }], 'postgres', 'dollar');
    expect(pg.sql).toBe('WHERE "a" LIKE $1 ESCAPE E\'\\\\\'');
    expect(pg.params).toEqual(['%x%']);

    const my = buildWhere([{ column: 'a', op: 'startsWith', value: 'x' }], 'mysql', 'qmark');
    expect(my.sql).toBe("WHERE `a` LIKE ? ESCAPE '\\\\'");
    expect(my.params).toEqual(['x%']);

    const lite = buildWhere([{ column: 'a', op: 'endsWith', value: 'x' }], 'sqlite', 'qmark');
    expect(lite.sql).toBe('WHERE "a" LIKE ? ESCAPE \'\\\'');
    expect(lite.params).toEqual(['%x']);
  });

  it('escapes LIKE metacharacters in the value, not in the SQL', () => {
    const w = buildWhere([{ column: 'a', op: 'contains', value: '50%_x' }], 'postgres', 'dollar');
    expect(w.params).toEqual(['%50\\%\\_x%']);
    expect(escapeLikePattern('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });

  it('throws instead of silently widening the result when a value is missing', () => {
    expect(() => buildWhere([{ column: 'a', op: 'eq' }], 'postgres', 'dollar')).toThrow();
    expect(() =>
      buildWhere([{ column: 'a', op: 'between', value: '1' }], 'postgres', 'dollar'),
    ).toThrow();
  });

  it('never lets a value reach the SQL text', () => {
    const w = buildWhere(
      [{ column: 'a', op: 'eq', value: "x'; DROP TABLE users; --" }],
      'postgres',
      'dollar',
    );
    expect(w.sql).toBe('WHERE "a" = $1');
    expect(w.sql).not.toContain('DROP');
    expect(w.params).toEqual(["x'; DROP TABLE users; --"]);
  });

  it('exposes the raw conditions for callers that AND in their own predicate', () => {
    const c = buildConditions(
      [
        { column: 'a', op: 'eq', value: '1' },
        { column: 'b', op: 'isNull' },
      ],
      'postgres',
      'dollar',
    );
    expect(c.conditions).toEqual(['"a" = $1', '"b" IS NULL']);
    expect(c.params).toEqual(['1']);
  });
});
