/**
 * Test engine harness (PLAN §13).
 *
 * Introspection SQL cannot be meaningfully unit tested — it has to run against
 * a real server. Rather than docker-in-docker (§10.4 says the suite must not
 * run inside the app container), these tests target the engines already started
 * by `docker compose -f compose.dev.yml --profile dbs up`.
 *
 * Each engine is skipped, loudly, when it is not reachable — a silently skipped
 * test suite is worse than a failing one.
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Address, ConnectionConfig } from '../../src/lib/connection';
import type { EngineKind } from '../../src/lib/schema-model';
import type { ConnectorContext, ResolvedAddress } from '../../src/server/db/types';

export interface EngineTarget {
  engine: EngineKind;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
}

/**
 * Defaults match compose.dev.yml's published ports, so `npm test` works from
 * the host with the dbs profile up. Override with env vars in CI.
 */
export const TARGETS: Record<Exclude<EngineKind, 'sqlite'>, EngineTarget> = {
  mysql: {
    engine: 'mysql',
    host: process.env.TEST_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_MYSQL_PORT ?? 13306),
    username: 'root',
    password: 'dbadmin',
    database: 'sample',
  },
  mariadb: {
    engine: 'mariadb',
    host: process.env.TEST_MARIADB_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_MARIADB_PORT ?? 13307),
    username: 'root',
    password: 'dbadmin',
    database: 'sample',
  },
  postgres: {
    engine: 'postgres',
    host: process.env.TEST_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_PG_PORT ?? 15432),
    username: 'dbadmin',
    password: 'dbadmin',
    database: 'sample',
  },
  redis: {
    engine: 'redis',
    host: process.env.TEST_REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_REDIS_PORT ?? 16379),
  },
  mongodb: {
    engine: 'mongodb',
    host: process.env.TEST_MONGO_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_MONGO_PORT ?? 17017),
    username: 'dbadmin',
    password: 'dbadmin',
    database: 'sample',
  },
};

export function canReach(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** A ResolvedAddress for tests: no tunnel, nothing to release. */
export function directAddress(address: Address): ResolvedAddress {
  return {
    address,
    original: address,
    tunneled: false,
    release: async () => {},
  };
}

export function configFor(target: EngineTarget, overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: randomUUID(),
    name: `test-${target.engine}`,
    engine: target.engine,
    address: { kind: 'tcp', host: target.host, port: target.port },
    access: { via: 'direct' },
    username: target.username,
    hasPassword: !!target.password,
    options: { database: target.database, connectTimeoutMs: 10_000 },
    readOnly: false,
    envTag: 'dev',
    sortOrder: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function contextFor(target: EngineTarget, overrides: Partial<ConnectionConfig> = {}): ConnectorContext {
  const config = configFor(target, overrides);
  return {
    config,
    resolved: directAddress(config.address),
    password: target.password,
  };
}

/** A throwaway SQLite file, since SQLite needs no server at all. */
export function sqliteContext(): ConnectorContext {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbadmin-test-'));
  const file = path.join(dir, 'test.db');
  const address: Address = { kind: 'file', path: file, mode: 'rw' };
  const config: ConnectionConfig = {
    id: randomUUID(),
    name: 'test-sqlite',
    engine: 'sqlite',
    address,
    access: { via: 'direct' },
    hasPassword: false,
    options: {},
    readOnly: false,
    envTag: 'dev',
    sortOrder: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { config, resolved: directAddress(address) };
}

/**
 * Values that drivers silently corrupt (PLAN §6). Any engine claiming type
 * fidelity has to round-trip every one of these.
 */
export const TORTURE_TEXT =
  'comma, "quote", tab\there, newline\nhere, unicode ☃ émoji \u{1F389}, backslash \\ end';
export const BIG_INT_MAX = '9223372036854775807';
export const BIG_INT_MIN = '-9223372036854775808';
export const EXACT_DECIMAL = '12345678901234567890.1234567890';
