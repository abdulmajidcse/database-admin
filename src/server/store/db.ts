/**
 * App database access (PLAN §5).
 *
 * better-sqlite3 is synchronous, which is FINE here and only here: this file is
 * a handful of tiny rows. User SQLite databases run in worker threads instead
 * (§6), because a user's `SELECT * FROM huge_table` would otherwise block the
 * event loop and freeze the whole app.
 */

import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CONFIG, paths } from '../config';
import { currentUserId, requireUserId } from '../context';
import { vaultFor } from '../vault';
import type { Address, Access, ConnectionConfig, ConnectionInput, EnvTag, TlsConfig } from '../../lib/connection';
import type { EngineKind, SchemaModel } from '../../lib/schema-model';

const here = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(CONFIG.home, { recursive: true });
  const handle = new Database(paths.appDb());
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  handle.pragma('busy_timeout = 5000');
  const schema = readFileSync(path.join(here, 'schema.sql'), 'utf8');
  handle.exec(schema);
  migrate(handle);
  db = handle;
  return handle;
}

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a database written before connections had owners needs the column added
 * explicitly. Existing rows keep `owner_id = NULL` and are claimed by
 * `claimOrphanConnections()` when the pre-existing account first signs in.
 *
 * The index on `owner_id` is created HERE and not in schema.sql: exec() runs
 * that file in order against an existing database, so an index over a column
 * this function has not added yet fails the whole schema load.
 */
function migrate(handle: Database.Database): void {
  const addColumn = (table: string, column: string, type: string) => {
    const cols = handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  };
  addColumn('connections', 'owner_id', 'TEXT');
  addColumn('query_history', 'owner_id', 'TEXT');
  addColumn('saved_queries', 'owner_id', 'TEXT');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_connections_owner ON connections(owner_id, sort_order, name)');
}

/**
 * Hands rows written before multi-user support to the account that has been
 * using them. Only ever called for the sole account on the install, so a second
 * user signing up later cannot inherit the first user's connections.
 */
export function claimOrphanConnections(userId: string): number {
  const handle = getDb();
  const claim = handle.transaction(() => {
    const r = handle.prepare('UPDATE connections SET owner_id = ? WHERE owner_id IS NULL').run(userId);
    handle.prepare('UPDATE query_history SET owner_id = ? WHERE owner_id IS NULL').run(userId);
    handle.prepare('UPDATE saved_queries SET owner_id = ? WHERE owner_id IS NULL').run(userId);
    return r.changes;
  });
  return claim();
}

export function closeDb(): void {
  db?.close();
  db = null;
}

interface ConnectionRow {
  id: string;
  name: string;
  engine: string;
  address_json: string;
  access_json: string;
  username: string | null;
  secret_blob: Buffer | null;
  secret_nonce: Buffer | null;
  ssh_secrets: Buffer | null;
  ssh_nonce: Buffer | null;
  tls_json: string | null;
  options_json: string;
  read_only: number;
  color: string | null;
  env_tag: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

function rowToConfig(r: ConnectionRow): ConnectionConfig {
  return {
    id: r.id,
    name: r.name,
    engine: r.engine as EngineKind,
    address: JSON.parse(r.address_json) as Address,
    access: JSON.parse(r.access_json) as Access,
    username: r.username ?? undefined,
    hasPassword: r.secret_blob !== null,
    tls: r.tls_json ? (JSON.parse(r.tls_json) as TlsConfig) : undefined,
    options: JSON.parse(r.options_json) as ConnectionConfig['options'],
    readOnly: r.read_only === 1,
    envTag: r.env_tag as EnvTag,
    color: r.color ?? undefined,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Every read and write here is scoped to the signed-in user via
 * `requireUserId()` — see server/context.ts. Nothing takes an ownerId
 * parameter, deliberately: a parameter can be omitted at one call site out of
 * seventeen and leak another user's rows, whereas an absent context throws.
 */
export const connectionsRepo = {
  list(): ConnectionConfig[] {
    const rows = getDb()
      .prepare('SELECT * FROM connections WHERE owner_id = ? ORDER BY sort_order, name')
      .all(requireUserId()) as ConnectionRow[];
    return rows.map(rowToConfig);
  },

  get(id: string): ConnectionConfig | null {
    const r = getDb()
      .prepare('SELECT * FROM connections WHERE id = ? AND owner_id = ?')
      .get(id, requireUserId()) as ConnectionRow | undefined;
    return r ? rowToConfig(r) : null;
  },

  create(input: ConnectionInput): ConnectionConfig {
    const id = randomUUID();
    const owner = requireUserId();
    const vault = vaultFor(owner);
    const now = Date.now();
    const secret = input.password ? vault.encrypt(input.password) : null;
    const sshSecret =
      input.sshSecrets && input.sshSecrets.some((s) => s)
        ? vault.encrypt(JSON.stringify(input.sshSecrets))
        : null;
    getDb()
      .prepare(
        `INSERT INTO connections (id, owner_id, name, engine, address_json, access_json, username,
            secret_blob, secret_nonce, ssh_secrets, ssh_nonce, tls_json, options_json,
            read_only, color, env_tag, sort_order, created_at, updated_at)
         VALUES (@id, @owner, @name, @engine, @address, @access, @username,
            @secretBlob, @secretNonce, @sshSecrets, @sshNonce, @tls, @options,
            @readOnly, @color, @envTag, @sortOrder, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        owner,
        name: input.name,
        engine: input.engine,
        address: JSON.stringify(input.address),
        access: JSON.stringify(input.access),
        username: input.username ?? null,
        secretBlob: secret?.blob ?? null,
        secretNonce: secret?.nonce ?? null,
        sshSecrets: sshSecret?.blob ?? null,
        sshNonce: sshSecret?.nonce ?? null,
        tls: input.tls ? JSON.stringify(input.tls) : null,
        options: JSON.stringify(input.options ?? {}),
        readOnly: input.readOnly ? 1 : 0,
        color: input.color ?? null,
        envTag: input.envTag ?? 'dev',
        sortOrder: input.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      });
    return this.get(id)!;
  },

  update(id: string, input: ConnectionInput): ConnectionConfig {
    const owner = requireUserId();
    const vault = vaultFor(owner);
    const existing = getDb()
      .prepare('SELECT * FROM connections WHERE id = ? AND owner_id = ?')
      .get(id, owner) as ConnectionRow | undefined;
    if (!existing) throw new Error(`No such connection: ${id}`);

    // `password: undefined` keeps the stored secret; `null` clears it.
    let secretBlob = existing.secret_blob;
    let secretNonce = existing.secret_nonce;
    if (input.password === null) {
      secretBlob = null;
      secretNonce = null;
    } else if (typeof input.password === 'string') {
      const s = vault.encrypt(input.password);
      secretBlob = s.blob;
      secretNonce = s.nonce;
    }

    let sshBlob = existing.ssh_secrets;
    let sshNonce = existing.ssh_nonce;
    if (input.sshSecrets) {
      if (input.sshSecrets.some((s) => s)) {
        const s = vault.encrypt(JSON.stringify(input.sshSecrets));
        sshBlob = s.blob;
        sshNonce = s.nonce;
      } else {
        sshBlob = null;
        sshNonce = null;
      }
    }

    getDb()
      .prepare(
        `UPDATE connections SET name=@name, engine=@engine, address_json=@address,
           access_json=@access, username=@username, secret_blob=@secretBlob,
           secret_nonce=@secretNonce, ssh_secrets=@sshSecrets, ssh_nonce=@sshNonce,
           tls_json=@tls, options_json=@options, read_only=@readOnly, color=@color,
           env_tag=@envTag, sort_order=@sortOrder, updated_at=@updatedAt
         WHERE id=@id AND owner_id=@owner`,
      )
      .run({
        id,
        owner,
        name: input.name,
        engine: input.engine,
        address: JSON.stringify(input.address),
        access: JSON.stringify(input.access),
        username: input.username ?? null,
        secretBlob,
        secretNonce,
        sshSecrets: sshBlob,
        sshNonce: sshNonce,
        tls: input.tls ? JSON.stringify(input.tls) : null,
        options: JSON.stringify(input.options ?? {}),
        readOnly: input.readOnly ? 1 : 0,
        color: input.color ?? null,
        envTag: input.envTag ?? 'dev',
        sortOrder: input.sortOrder ?? 0,
        updatedAt: Date.now(),
      });
    return this.get(id)!;
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM connections WHERE id = ? AND owner_id = ?').run(id, requireUserId());
  },

  /** Server-side only. Never expose the result over HTTP. */
  password(id: string): string | undefined {
    const owner = requireUserId();
    const r = getDb()
      .prepare('SELECT secret_blob, secret_nonce FROM connections WHERE id = ? AND owner_id = ?')
      .get(id, owner) as Pick<ConnectionRow, 'secret_blob' | 'secret_nonce'> | undefined;
    if (!r?.secret_blob || !r.secret_nonce) return undefined;
    return vaultFor(owner).decrypt(r.secret_blob, r.secret_nonce);
  },

  sshSecrets(id: string): (string | null)[] {
    const owner = requireUserId();
    const r = getDb()
      .prepare('SELECT ssh_secrets, ssh_nonce FROM connections WHERE id = ? AND owner_id = ?')
      .get(id, owner) as Pick<ConnectionRow, 'ssh_secrets' | 'ssh_nonce'> | undefined;
    if (!r?.ssh_secrets || !r.ssh_nonce) return [];
    return JSON.parse(vaultFor(owner).decrypt(r.ssh_secrets, r.ssh_nonce)) as (string | null)[];
  },

  /** Used when a user changes their password; touches only their own rows. */
  rewrapAll(
    decrypt: (b: Buffer, n: Buffer) => string,
    encrypt: (s: string) => { blob: Buffer; nonce: Buffer },
  ): void {
    const handle = getDb();
    const rows = handle.prepare('SELECT * FROM connections WHERE owner_id = ?').all(requireUserId()) as ConnectionRow[];
    const upd = handle.prepare(
      'UPDATE connections SET secret_blob=?, secret_nonce=?, ssh_secrets=?, ssh_nonce=? WHERE id=?',
    );
    const tx = handle.transaction(() => {
      for (const r of rows) {
        const s = r.secret_blob && r.secret_nonce ? encrypt(decrypt(r.secret_blob, r.secret_nonce)) : null;
        const k = r.ssh_secrets && r.ssh_nonce ? encrypt(decrypt(r.ssh_secrets, r.ssh_nonce)) : null;
        upd.run(s?.blob ?? null, s?.nonce ?? null, k?.blob ?? null, k?.nonce ?? null, r.id);
      }
    });
    tx();
  },
};

export const historyRepo = {
  add(entry: {
    connectionId: string | null;
    sql: string;
    dbContext?: string;
    startedAt: number;
    durationMs: number;
    rowCount?: number;
    status: 'ok' | 'error' | 'cancelled';
    error?: string;
  }): void {
    getDb()
      .prepare(
        `INSERT INTO query_history (owner_id, connection_id, sql, db_context, started_at, duration_ms, row_count, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        // Tolerant rather than strict: history is a convenience, and a row
        // logged outside a request should be dropped from every user's view,
        // not crash the query that produced it.
        currentUserId() ?? null,
        entry.connectionId,
        entry.sql,
        entry.dbContext ?? null,
        entry.startedAt,
        entry.durationMs,
        entry.rowCount ?? null,
        entry.status,
        entry.error ?? null,
      );
  },

  list(opts: { connectionId?: string; search?: string; limit?: number } = {}) {
    const limit = opts.limit ?? 200;
    const where: string[] = ['owner_id = ?'];
    const params: unknown[] = [requireUserId()];
    if (opts.connectionId) {
      where.push('connection_id = ?');
      params.push(opts.connectionId);
    }
    if (opts.search) {
      where.push('sql LIKE ?');
      params.push(`%${opts.search}%`);
    }
    const sql = `SELECT * FROM query_history WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ?`;
    params.push(limit);
    return getDb().prepare(sql).all(...params) as Record<string, unknown>[];
  },

  clear(connectionId?: string): void {
    const owner = requireUserId();
    if (connectionId) {
      getDb()
        .prepare('DELETE FROM query_history WHERE connection_id = ? AND owner_id = ?')
        .run(connectionId, owner);
    } else {
      getDb().prepare('DELETE FROM query_history WHERE owner_id = ?').run(owner);
    }
  },
};

/**
 * Live templates (docs/roadmap.md M10). Owner-scoped like everything else here:
 * a snippet is a private convenience, not shared state.
 */
export const snippetsRepo = {
  list() {
    return getDb()
      .prepare('SELECT * FROM snippets WHERE owner_id = ? ORDER BY prefix')
      .all(requireUserId()) as Record<string, unknown>[];
  },
  upsert(s: { id?: string; prefix: string; label?: string; body: string; engines?: string[] }) {
    const now = Date.now();
    const id = s.id ?? randomUUID();
    getDb()
      .prepare(
        `INSERT INTO snippets (id, owner_id, prefix, label, body, engines, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           prefix = excluded.prefix, label = excluded.label, body = excluded.body,
           engines = excluded.engines, updated_at = excluded.updated_at
         WHERE snippets.owner_id = excluded.owner_id`,
      )
      .run(id, requireUserId(), s.prefix, s.label ?? '', s.body, (s.engines ?? []).join(','), now, now);
    return id;
  },
  remove(id: string) {
    getDb().prepare('DELETE FROM snippets WHERE id = ? AND owner_id = ?').run(id, requireUserId());
  },
};

export const savedQueriesRepo = {
  list() {
    return getDb()
      .prepare('SELECT * FROM saved_queries WHERE owner_id = ? ORDER BY folder, name')
      .all(requireUserId()) as Record<string, unknown>[];
  },
  upsert(q: { id?: string; name: string; folder?: string; sql: string; connectionId?: string | null; params?: unknown[] }) {
    const id = q.id ?? randomUUID();
    const owner = requireUserId();
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO saved_queries (id, owner_id, name, folder, sql, connection_id, params_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, folder=excluded.folder, sql=excluded.sql,
           connection_id=excluded.connection_id, params_json=excluded.params_json, updated_at=excluded.updated_at
         WHERE saved_queries.owner_id = excluded.owner_id`,
      )
      .run(id, owner, q.name, q.folder ?? '', q.sql, q.connectionId ?? null, JSON.stringify(q.params ?? []), now, now);
    return id;
  },
  remove(id: string) {
    getDb().prepare('DELETE FROM saved_queries WHERE id = ? AND owner_id = ?').run(id, requireUserId());
  },
};

/**
 * The schema cache is owner-scoped through its `scope` key, not by a column:
 * the primary key is already (connection_id, scope), and namespacing the key is
 * a smaller change than rebuilding the table to widen the PK.
 *
 * This is not belt-and-braces. A cached model is reachable WITHOUT going
 * through connectionsRepo — that is the whole point of a cache — so without
 * this, one user could read another's table names, columns and row counts by
 * asking for their connection id.
 */
export const schemaCacheRepo = {
  get(connectionId: string, scope: string): { model: SchemaModel; fetchedAt: number } | null {
    const r = getDb()
      .prepare('SELECT model_json, fetched_at FROM schema_cache WHERE connection_id = ? AND scope = ?')
      .get(connectionId, scopedKey(scope)) as { model_json: string; fetched_at: number } | undefined;
    if (!r) return null;
    return { model: JSON.parse(r.model_json) as SchemaModel, fetchedAt: r.fetched_at };
  },
  put(connectionId: string, scope: string, model: SchemaModel): void {
    getDb()
      .prepare(
        `INSERT INTO schema_cache (connection_id, scope, model_json, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(connection_id, scope) DO UPDATE SET model_json=excluded.model_json, fetched_at=excluded.fetched_at`,
      )
      .run(connectionId, scopedKey(scope), JSON.stringify(model), Date.now());
  },
  invalidate(connectionId: string): void {
    getDb()
      .prepare("DELETE FROM schema_cache WHERE connection_id = ? AND scope LIKE ?")
      .run(connectionId, `${requireUserId()}:%`);
  },
};

export const workspaceRepo = {
  /**
   * The open tabs and layout are per user, so the key is namespaced rather than
   * the table gaining a column — the id is already the primary key.
   */
  get(id = 'default'): unknown {
    const r = getDb().prepare('SELECT json FROM workspace WHERE id = ?').get(scopedKey(id)) as
      | { json: string }
      | undefined;
    return r ? JSON.parse(r.json) : null;
  },
  put(value: unknown, id = 'default'): void {
    getDb()
      .prepare(
        `INSERT INTO workspace (id, json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`,
      )
      .run(scopedKey(id), JSON.stringify(value), Date.now());
  },
};

function scopedKey(id: string): string {
  return `${requireUserId()}:${id}`;
}

export const settingsRepo = {
  get(key: string): string | null {
    const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  },
  put(key: string, value: string): void {
    getDb()
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, value);
  },
  all(): Record<string, string> {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
};
