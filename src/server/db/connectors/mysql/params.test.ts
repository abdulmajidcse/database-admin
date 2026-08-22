/**
 * Bound parameters against a REAL MySQL server (PLAN §13).
 *
 * This exists because a unit test could not have caught the bug it covers. The
 * params bar was fixed to keep an oversized integer as `{$t:'bigint'}` rather
 * than round it through a double, and a test asserted exactly that — while the
 * MySQL query path passed the tagged cell straight to mysql2, which stringified
 * it to "[object Object]". The statement ran, matched nothing, and reported
 * success. Everything in isolation was correct; only the round trip was wrong.
 *
 * Skipped when no MySQL is reachable, so `npm test` still passes without one.
 * Bring one up with `docker compose -f compose.test.yml up -d`.
 */

import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tag } from '../../../../lib/wire';
import { cellToParam } from './types';

const HOST = process.env.TEST_MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.TEST_MYSQL_PORT ?? 13306);

/** Beyond 2^53: the digits a double cannot hold. */
const BIG = '9007199254740993';

let conn: mysql.Connection | null = null;

beforeAll(async () => {
  try {
    conn = await mysql.createConnection({
      host: HOST,
      port: PORT,
      user: 'root',
      password: 'dbadmin',
      database: 'sample',
      connectTimeout: 3000,
    });
    await conn.query('DROP TABLE IF EXISTS bind_probe');
    await conn.query('CREATE TABLE bind_probe (id BIGINT PRIMARY KEY, note TEXT)');
    await conn.query('INSERT INTO bind_probe (id, note) VALUES (?, ?)', [BIG, 'kept']);
  } catch {
    conn = null;
  }
}, 30_000);

afterAll(async () => {
  if (conn) {
    await conn.query('DROP TABLE IF EXISTS bind_probe').catch(() => undefined);
    await conn.end().catch(() => undefined);
  }
});

describe.skipIf(!process.env.TEST_MYSQL_PORT && PORT !== 13306)('MySQL bound parameters', () => {
  it('finds the row when a bigint cell is decoded first', async () => {
    if (!conn) return; // no server reachable
    const cell = tag('bigint', BIG);
    const [rows] = await conn.query('SELECT note FROM bind_probe WHERE id = ?', [
      cellToParam(cell),
    ]);
    expect(Array.isArray(rows) && rows.length).toBe(1);
  });

  it('finds nothing when the cell is passed undecoded — the bug this covers', async () => {
    if (!conn) return;
    // Reproduces the old behaviour exactly: the tagged object reaches the
    // escaper, becomes "[object Object]", and the statement quietly matches no
    // rows instead of failing.
    const cell = tag('bigint', BIG) as unknown;
    const [rows] = await conn.query('SELECT note FROM bind_probe WHERE id = ?', [cell]);
    expect(Array.isArray(rows) && rows.length).toBe(0);
  });

  it('round-trips the value without losing a digit', async () => {
    if (!conn) return;
    const [rows] = await conn.query('SELECT CAST(id AS CHAR) AS id FROM bind_probe WHERE id = ?', [
      cellToParam(tag('bigint', BIG)),
    ]);
    const first = (rows as { id: string }[])[0];
    expect(first?.id).toBe(BIG);
  });
});
