/**
 * The connector registry (PLAN §4, §14 "adding an engine should be implement
 * `Connector`, register it, done").
 *
 * This file is the ONLY place that knows which module implements which engine.
 * Everything else — the manager, the routes, the transfer subsystem — asks for a
 * connector by `EngineKind` and gets back something that satisfies the frozen
 * interfaces in ./types.
 *
 * Server-side only: no React, no Next (PLAN §11).
 */

import type { EngineKind } from '../../lib/schema-model';
import { workspaceModeFor, type WorkspaceMode } from '../../lib/connection';
import { DbError, type Capability, type Connector, type ConnectorContext, type ConnectorFactory } from './types';

import { createSqliteConnector } from './connectors/sqlite';
import { createMysqlConnector } from './connectors/mysql';
import { createPostgresConnector } from './connectors/postgres';
import { createRedisConnector } from './connectors/redis';
import { createMongoConnector } from './connectors/mongo';

/**
 * MySQL and MariaDB deliberately share one factory: they are one connector with
 * a flavor flag, taken from `ctx.config.engine` (PLAN §4). Splitting them would
 * duplicate ~2k lines to express a handful of divergences (JSON type, sequences,
 * RETURNING, system-versioned tables).
 */
const FACTORIES: Readonly<Record<EngineKind, ConnectorFactory>> = {
  sqlite: createSqliteConnector,
  mysql: createMysqlConnector,
  mariadb: createMysqlConnector,
  postgres: createPostgresConnector,
  redis: createRedisConnector,
  mongodb: createMongoConnector,
};

/** Every engine this build can talk to, in the order the UI offers them. */
export const SUPPORTED_ENGINES: readonly EngineKind[] = [
  'postgres',
  'mysql',
  'mariadb',
  'sqlite',
  'redis',
  'mongodb',
];

export function isSupportedEngine(engine: string): engine is EngineKind {
  return Object.prototype.hasOwnProperty.call(FACTORIES, engine);
}

/** The factory for an engine, or a typed error naming what we do support. */
export function connectorFactory(engine: EngineKind): ConnectorFactory {
  const factory = FACTORIES[engine];
  if (!factory) {
    throw new DbError(
      `No connector is registered for engine "${engine}". Supported: ${SUPPORTED_ENGINES.join(', ')}.`,
      'UNSUPPORTED_ENGINE',
    );
  }
  return factory;
}

/**
 * Build (but do not open) a connector for a context the caller already resolved.
 * The context carries an already-dialable address — connectors never learn how
 * they were reached (PLAN §8.1).
 */
export function createConnector(ctx: ConnectorContext): Connector {
  return connectorFactory(ctx.config.engine)(ctx);
}

/**
 * Which workspace the UI opens for an engine. Derived from the engine rather
 * than from a live connector so the connection list can render before anything
 * is connected; a live connector's `capabilities` remains the authority once it
 * exists (PLAN §4).
 */
export function workspaceModeForEngine(engine: EngineKind): WorkspaceMode {
  return workspaceModeFor(engine);
}

/** Capability check that reads naturally at call sites. */
export function supports(connector: Connector, capability: Capability): boolean {
  return connector.capabilities.has(capability);
}

/** Throw a typed error when a route needs a capability this engine lacks. */
export function requireCapability(connector: Connector, capability: Capability): void {
  if (!connector.capabilities.has(capability)) {
    throw new DbError(
      `${connector.kind} does not support "${capability}".`,
      'UNSUPPORTED_CAPABILITY',
    );
  }
}
