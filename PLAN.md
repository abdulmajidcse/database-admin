# Database Admin — Build Plan

A DataGrip/PhpStorm-style database client, running as a **local web app in Docker**.
Single user. Engines: **MySQL, MariaDB, PostgreSQL, SQLite, Redis, MongoDB**. Feature depth: browse + query + edit + import/export + power tools.

---

## 1. Scope

**In scope (v1 target)**

| Area | What it means |
| --- | --- |
| Connections | CRUD, encrypted credential vault, test-connection, colors/env tags |
| **Local & remote** | Every engine reachable locally (TCP, unix socket, SQLite file) or remotely (direct TCP, TLS, SSH tunnel with bastion chains, `kubectl port-forward`/cloud proxies), with latency-aware behavior, auto-reconnect and read-only prod guards. See §8 |
| Navigation | Lazy schema tree (server → db → schema → table/view/routine → column/index/FK), search-anything |
| Data browsing | Virtualized grid, server-side paging/sort/filter, cell viewers (JSON/BLOB/text/image), row detail panel |
| SQL editor | CodeMirror 6, schema-aware autocomplete, multi-statement, run-under-cursor, cancel, multiple result tabs |
| Editing | Inline cell edit → pending changeset → SQL diff preview → transactional apply. Row insert/delete |
| DDL | Create/alter table UI, index & FK management, generated DDL scripts, drop with guardrails |
| Redis | Keyspace browser (SCAN-based), type-aware viewers, TTL, CLI console, pub/sub + MONITOR |
| MongoDB | DB/collection tree, document tree+JSON editor, find/aggregate runner, index management, explain |
| **Import / export** | Full database & per-table dump/restore, result-set export (CSV/JSON/NDJSON/XLSX/SQL/Markdown), CSV import wizard with column mapping, SQL dump runner, native-tool delegation (`mysqldump`/`pg_dump`/`mongodump`), background jobs with progress + cancel. See §7 |
| Power tools | ER diagram, schema compare + migration DDL, EXPLAIN visualizer, query history, saved queries, session/process monitor |

**Explicitly out of scope for now:** multi-user auth, RBAC, audit logs, cloud hosting, mobile.
The server boundary (§11) is kept clean so any of these can be added later without a rewrite.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Browser (localhost only)                                    │
│  Next.js App Router · React · Tailwind + shadcn/ui          │
│  ├─ Workspace shell: resizable panels, tabs, command palette│
│  ├─ SQL mode UI   (tree + grid + CodeMirror)                │
│  ├─ Redis mode UI (keyspace + value editors + console)      │
│  └─ Mongo mode UI (collections + doc tree + pipeline)       │
│  state: TanStack Query (server) + Zustand (workspace/tabs)  │
└───────────────┬──────────────── HTTP + WebSocket ───────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│ DOCKER CONTAINER  ·  published on 127.0.0.1:3456 only (§10) │
│ Node process  (custom server.js: http → Next handler + ws)  │
│                                                             │
│  Route handlers  /api/connections  /api/query  /api/schema… │
│  WS channels     query-progress · redis-monitor · processes │
│                                                             │
│  ┌── src/server/ (zero React imports) ────────────────────┐ │
│  │  AccessResolver  direct│unix│ssh tunnel│proxy process │ │
│  │  ConnectionManager  pools, sessions, keepalive, cancel │ │
│  │  Connector registry ──┬─ mysql / mariadb (mysql2)      │ │
│  │                       ├─ postgres (pg, pg-cursor)      │ │
│  │                       ├─ sqlite (better-sqlite3+worker)│ │
│  │                       ├─ redis (ioredis)               │ │
│  │                       └─ mongo (mongodb)               │ │
│  │  Introspection + schema cache                          │ │
│  │  Changeset → SQL generator                             │ │
│  │  Vault (AES-256-GCM)   ·  SSH tunnels (ssh2)           │ │
│  │  App store (SQLite, better-sqlite3)  → volume /data/app│ │
│  └────────────────────────────────────────────────────────┘ │
│  baked-in CLI tools: mysqldump · pg_dump{16,17} · sqlite3   │
│                      mongodump · redis-cli · ssh            │
└──────┬──────────────────┬───────────────────────┬───────────┘
       │                  │                       │
  host.docker      other containers          remote hosts
  .internal        (shared network)          (direct · TLS · SSH tunnel)
   ↳ DBs on your Mac      ↳ compose `dbs` profile      ↳ §8
```

**Why a custom `server.js` instead of plain `next start`:** we need WebSockets (Redis MONITOR, live process list, long-query progress) and long-lived connection pools. A Node HTTP server that delegates to Next's request handler and owns the `upgrade` event gives us both in one process. Everything must run on the **Node runtime** — never Edge; drivers are raw TCP.

---

## 3. Stack decisions

| Choice | Pick | Why |
| --- | --- | --- |
| Framework | Next.js (App Router), TypeScript strict | You asked for it; RSC for the shell, route handlers for the API |
| Server | custom `server.ts` + `ws` | WebSockets + persistent pools |
| SQL editor | **CodeMirror 6** (`@codemirror/lang-sql`) | Lighter than Monaco, accepts a schema object for autocomplete natively, easy custom completion sources |
| Data grid | **Glide Data Grid** (canvas) | Handles 100k+ rows at 60fps with editable cells. Fallback: TanStack Table + TanStack Virtual |
| Diagrams | `@xyflow/react` + `elkjs` layout | ER diagram with draggable tables and FK edges |
| App storage | SQLite via `better-sqlite3` | Sync API, zero-config, single-user; holds connections, history, cache, layout |
| Drivers | `mysql2`, `pg` (+`pg-cursor`, `pg-copy-streams`), `better-sqlite3`, `ioredis`, `mongodb`, `ssh2` | Mainstream, streaming-capable |
| UI | Tailwind + shadcn/ui, `react-resizable-panels`, `cmdk` | Fast to build an IDE-shaped layout |
| Runtime | **Docker** — multi-stage image + compose, `node:22-bookworm-slim` | Reproducible, no host Node needed, and native dump tools ship in the image (§10) |
| Tests | Vitest + **testcontainers** + **toxiproxy** | Introspection SQL can only be trusted against real engines; toxiproxy simulates remote latency and dropped links |

---

## 4. The connector abstraction

The mistake to avoid is one giant interface pretending Redis is a SQL database. Use a **narrow base + capability-gated extensions**; the UI picks a workspace mode from capabilities.

```ts
// src/server/db/types.ts
export type EngineKind = 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'redis' | 'mongodb';

export type Capability =
  | 'sql' | 'transactions' | 'explain' | 'ddl' | 'routines'
  | 'keyspace' | 'documents' | 'aggregation' | 'processList';

export interface Connector {
  readonly kind: EngineKind;
  readonly capabilities: ReadonlySet<Capability>;

  open(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<ServerInfo>;              // version, edition, uptime
  listNodes(path: TreePath): Promise<TreeNode[]>;   // lazy tree, one level at a time
}

export interface SqlConnector extends Connector {
  query(sql: string, opts: RunOpts): Promise<ResultSet>;     // capped rows + cursor handle
  fetchMore(cursorId: string, n: number): Promise<ResultChunk>;
  stream(sql: string, opts: RunOpts): AsyncIterable<Row[]>;  // for export/import, never buffered
  cancel(runId: string): Promise<void>;
  introspect(scope: Scope): Promise<SchemaModel>;            // canonical model, engine-neutral
  generateDdl(object: SchemaObject): Promise<string>;
  applyChangeset(cs: Changeset): Promise<ApplyResult>;       // one transaction, preview-able
  explain(sql: string, analyze: boolean): Promise<ExplainPlan>;
}

export interface KeyValueConnector extends Connector {
  scanKeys(cur: ScanCursor): Promise<{ keys: KeyMeta[]; next: ScanCursor }>;
  readKey(key: string): Promise<TypedValue>;
  writeKey(key: string, v: TypedValue, ttl?: number): Promise<void>;
  command(argv: string[]): Promise<unknown>;     // raw CLI console
  subscribe(ch: string, sink: Sink): Unsubscribe;
}

export interface DocumentConnector extends Connector {
  find(ns: Namespace, filter: object, opts: FindOpts): Promise<ResultSet>;
  aggregate(ns: Namespace, pipeline: object[]): Promise<ResultSet>;
  upsert(ns: Namespace, doc: object): Promise<void>;
  indexes(ns: Namespace): Promise<IndexInfo[]>;
}
```

`SchemaModel` is the **canonical, engine-neutral** shape (tables → columns with normalized type descriptors → indexes → constraints). Everything downstream — tree, autocomplete, ER diagram, schema diff, DDL generation — reads only this model. Engine quirks stop at the connector boundary. Getting this type right early is the single highest-leverage decision in the project.

MySQL and MariaDB share one connector with a `flavor` flag; they diverge on JSON type, sequences (MariaDB 10.3+), `RETURNING`, and system-versioned tables.

**SQLite is the useful stress test of this design.** It's a `SqlConnector` with no host, no port, no user, no password, no pool, and no SSH tunnel — the connection target is a *file path* (or `:memory:`). If your config type is a flat `{host, port, user, password, database}`, SQLite breaks it — and so does every local unix-socket connection and every `mongodb+srv://` URI. Model it as two orthogonal unions from day one: **where the database is**, and **how you reach it** (see §8):

```ts
type Address =
  | { kind: 'tcp';  host: string; port: number }
  | { kind: 'unix'; socketPath: string }                        // local MySQL / PG / Redis
  | { kind: 'file'; path: string; mode: 'rw' | 'ro';            // SQLite
      attach?: { alias: string; path: string }[] }
  | { kind: 'uri';  uri: string };                              // mongodb+srv:// · rediss:// · libsql://

type Access =
  | { via: 'direct' }
  | { via: 'ssh'; hops: SshHop[] }                              // ProxyJump chain
  | { via: 'process'; argv: string[]; readyPattern?: string };  // kubectl port-forward, cloud-sql-proxy

type ConnectionConfig = {
  engine: EngineKind; address: Address; access: Access;
  auth?: Auth; tls?: TlsConfig; readOnly?: boolean; envTag?: 'dev' | 'staging' | 'prod';
};
```

Build SQLite **first** in M1, before MySQL and Postgres: zero setup, instant feedback, and it forces the union early instead of retrofitting it after two TCP engines have baked the wrong shape in. It also doubles as the fastest fixture for every later feature — grid, editor, changesets, ER diagram, export — with no container to boot.

---

## 5. App database (SQLite)

```sql
connections(id, name, kind, address_json,  -- tcp | unix | file | uri  (§4)
            access_json,                   -- direct | ssh (hop chain) | process proxy  (§8)
            secret_blob, secret_nonce,     -- AES-256-GCM; null for SQLite / agent auth
            tls_json, options_json, read_only, color, env_tag, sort, created_at)
query_history(id, connection_id, sql, started_at, ms, rows, status, error, db_context)
saved_queries(id, name, folder, sql, connection_id, params_json, updated_at)
schema_cache(connection_id, scope, model_json, fetched_at)   -- refresh on demand + TTL
jobs(id, kind, connection_id, params_json, status, progress_json,
     log_tail, started_at, ended_at, error)                  -- import/export/restore/copy (§7.3)
transfer_presets(id, name, kind, params_json)                -- reusable export/import configs
workspace(id, json)                                          -- open tabs, layout, pinned sessions
settings(key, value)
```

Lives in `$DBADMIN_HOME` (default `~/.dbadmin/`). Everything is one directory you can back up or delete.

---

## 6. Hard problems, and how we solve them

These are the things that separate a demo from a tool you actually use. Budget real time for them.

**Type fidelity.** Drivers lose data by default. `BIGINT` overflows JS numbers, `NUMERIC` loses precision, dates get timezone-mangled, `BLOB`s become garbage.
→ Configure `pg.types.setTypeParser` for int8/numeric/date/timestamp/timestamptz to return **strings**; set mysql2 `supportBigNumbers` + `bigNumberStrings` + a `typeCast` for DATE/BLOB. Define one wire format and use it everywhere:
```ts
type Cell = null | string | number | boolean
          | { $t: 'bigint'|'decimal'|'date'|'time'|'timestamp'|'bytes'|'json'|'array'|'geo'|'uuid', v: string };
```
For Mongo, serialize with **Extended JSON** (`bson`'s `EJSON`) so ObjectId/Decimal128/Date survive the trip.

**Statement splitting.** Naive `sql.split(';')` breaks on the first string literal. Write a small hand-rolled lexer (not a full parser) that understands: single/double quotes with escapes, backtick identifiers, `--` and `/* */` comments, Postgres `$tag$…$tag$` dollar-quoting, and MySQL `DELIMITER //`. This also powers *run statement under cursor*.

**Query cancellation.** Closing the socket doesn't stop the server.
→ Postgres: keep `client.processID`, then `SELECT pg_cancel_backend($1)` on a *second* connection. MySQL: keep `connection.threadId`, issue `KILL QUERY <id>` on a second connection. Mongo: `killOp`. Track a `runId → {pool, backendId}` map in `ConnectionManager`.

**Sessions vs pools.** Transactions, temp tables and `SET` variables need a *pinned* connection, not a pool checkout. Each SQL editor tab gets an optional pinned session (UI toggle, like DataGrip's tx mode) with an idle timeout so you don't hold locks forever.

**Big results.** Never buffer. Query returns first N rows (default 500) + a server-side cursor id; "fetch more" advances it; export streams driver → transform → file/response and never touches React. Postgres uses `pg-cursor`; MySQL uses `query().stream()`.

**Grid editing.** Require a detectable unique key (PK or unique index) — otherwise the grid is read-only, and the UI says why. Edits accumulate into a `Changeset`; "Preview" renders the exact SQL; "Apply" runs it in one transaction with an affected-rows sanity check that aborts on a mismatch (protects against a `WHERE` clause matching more rows than expected).

**Redis at scale.** `KEYS *` will hang a production box. Use `SCAN` with `MATCH`/`COUNT` and cursor pagination, batch `TYPE`+`TTL`+`MEMORY USAGE` lookups through a pipeline, and scan every master node in cluster mode. `MONITOR` and pub/sub each need their own dedicated connection, streamed to the UI over WebSocket with a ring buffer.

**SQLite's four traps.** Cheap engine, sharp edges:
1. *`better-sqlite3` is synchronous.* A user's `SELECT * FROM huge_table` would block the event loop and freeze the entire app — UI, WebSockets, every other connection. Run **user** SQLite connections inside a `worker_thread` pool (one worker per connection), and keep the sync-on-main-thread usage strictly for the tiny app store. Cancellation becomes "terminate the worker", which is also the only interrupt mechanism the driver gives you.
2. *Dynamic typing.* Type affinity means a single column can genuinely hold an integer in one row and a string in the next (unless it's a `STRICT` table). The grid must render per-*cell* types, not per-column — don't let the SQL engines' assumption leak into shared components.
3. *`ALTER TABLE` barely exists.* Beyond add-column, rename, and drop-column (3.35+), any real change needs the 12-step rebuild: create new table → copy → drop old → rename → recreate indexes/triggers/views, with `PRAGMA foreign_keys=off` around it. The DDL editor must generate that script, and show it before running.
4. *Single writer.* `SQLITE_BUSY` / "database is locked" when something else holds the write lock. Enable WAL, set a `busy_timeout`, and surface lock errors as a clear message rather than a stack trace.

Introspection uses `sqlite_master` + `PRAGMA table_info` / `foreign_key_list` / `index_list` / `index_info` — no `information_schema`, so it's a genuinely separate code path from the other SQL engines.

**Schema cache freshness.** Autocomplete needs the schema in memory; introspecting on every keystroke is unusable. Cache in SQLite, refresh on explicit action, after any DDL we execute, and on TTL. Show a subtle "schema from 12m ago" indicator with a refresh button.

---

## 7. Import & export

The feature people actually judge a DB client on. Treat it as a subsystem, not a button.

### 7.1 Scope levels

| Level | Export | Import |
| --- | --- | --- |
| Cell / selection | Copy as CSV, JSON, or SQL literal | Paste into grid → changeset |
| Result set | CSV, TSV, JSON, NDJSON, XLSX, Markdown, HTML, SQL `INSERT`s | — |
| Table | DDL + data, or a filtered/`WHERE`-limited subset | CSV / JSON / NDJSON → existing or new table, via mapping wizard |
| Schema / database | Full dump: DDL, data, views, routines, triggers, sequences; grants optional | Restore a dump; run a `.sql` script |
| Server | All databases in one archive | — |

Every level supports optional gzip/zstd streaming compression, and a **structure-only / data-only / both** switch.

### 7.2 Two engines, deliberately

**A. Native tool delegation** — shell out to `mysqldump`/`mysql`, `pg_dump`/`pg_restore`/`psql`, `sqlite3`, `mongodump`/`mongorestore`, `redis-cli --rdb`.
Best fidelity (definers, collations, partitions, extensions, `SECURITY DEFINER` routines — all the things a hand-rolled dumper gets subtly wrong) and fastest. Cost: the binaries must exist and be version-compatible.

**B. Built-in streaming engine** — built on `SqlConnector.stream()` from M1.
Always available, uniform progress reporting, and the only way to do filtered exports, format conversion, and cross-engine copy.

**Use both.** Because we ship in Docker (§10.1), every native tool is baked into the image — so detection always succeeds and the "tool not installed" fallback exists only for the rare case of connecting to a server newer than the bundled client. Still probe `PATH` at startup and record versions, shown in a Settings panel. Full-database dump/restore prefers native when present; everything else uses the built-in engine. Version rule worth enforcing: `pg_dump` must be **≥** the server's major version, otherwise refuse with a clear message rather than producing a broken dump.

**Shelling out safely:** `spawn` with an argv array, never a shell string. Never put a password in argv — it's world-visible in `ps`. Use `PGPASSWORD`/`MYSQL_PWD` in the child env, or a temp options file written `0600` and deleted in a `finally`. Validate that any user-supplied output path resolves inside an allowed directory.

### 7.3 Jobs, because these run for hours

A 50 GB dump cannot live inside an HTTP request. Add a `JobManager` to the server layer:

```ts
type Job = {
  id: string; kind: 'export' | 'import' | 'restore' | 'copy';
  connectionId: string; params: JobParams;
  status: 'queued' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';
  progress: { phase: string; tablesDone: number; tablesTotal: number;
              rowsDone: number; bytesOut: number; etaMs?: number };
  startedAt: number; endedAt?: number; log: string[];  // ring buffer, tailed live
};
```

Create → run detached → stream progress over the existing WebSocket → cancel (kills the child process *and* the DB-side query) → persist to a `jobs` table with a log tail you can reopen. The UI gets a jobs drawer that survives page reloads. This is reusable later for long DDL and migrations, so build it once, properly.

### 7.4 Built-in pipeline

```
source        → transform      → writer        → [compress] → sink
cursor/stream   type-encoding    CSV/JSON/SQL     gzip/zstd    file | HTTP response
```

Node `stream.pipeline()` end to end, so backpressure is real and memory stays flat regardless of table size. The type-encoding stage reuses the §6 wire format, with an explicit policy for binary in text formats (base64 or hex, configurable) — the single most common source of silently corrupted dumps.

**Import fast paths** matter enormously; naive row-by-row `INSERT` is 50–100× slower:

| Engine | Fast path |
| --- | --- |
| Postgres | `COPY … FROM STDIN` via `pg-copy-streams` |
| MySQL/MariaDB | `LOAD DATA LOCAL INFILE` when `local_infile` is enabled both sides; else batched multi-row `INSERT` sized against `max_allowed_packet` |
| SQLite | one transaction around a prepared-statement loop (`better-sqlite3` is fastest this way — no batching needed) |
| MongoDB | unordered `bulkWrite` in batches |
| Redis | pipelined `RESTORE` of serialized payloads |

**Import knobs:** on-conflict strategy (insert / upsert / replace / ignore), truncate-before-load, FK checks off during load (`SET FOREIGN_KEY_CHECKS=0`; Postgres `session_replication_role = replica` needs superuser — fall back to deferring constraints), batch size, wrap-in-transaction, continue-on-error with a collected error report, and a **dry run** that validates without writing.

**CSV import wizard:** sniff delimiter, encoding and BOM; detect header row; preview 50 rows; per-column mapping to target columns with type coercion and an explicit date format; NULL-literal and trim settings; then a validation pass that reports bad rows *before* touching the table.

### 7.5 Consistency and engine-specific traps

- **Consistency.** `mysqldump --single-transaction --skip-lock-tables`; `pg_dump` is snapshot-consistent by default. The built-in engine wraps a multi-table export in one `REPEATABLE READ` transaction, otherwise your "dump" is a set of tables from different points in time — which restores into FK violations.
- **Restore ordering.** Load data before creating indexes and FKs, then build them. Roughly an order of magnitude faster, and it sidesteps insertion-order dependencies.
- **MySQL.** Dumps embed `DEFINER=user@host` clauses that fail when restored on another host. Offer a strip-definer toggle. Watch charset/collation mismatches (`utf8` vs `utf8mb4`) on restore.
- **Postgres.** Prefer custom format (`-Fc`) so `pg_restore` can do selective and parallel restore; offer plain SQL when readability matters. Extensions and ownership need `--no-owner`/`--no-privileges` options exposed.
- **SQLite.** The best "export database" here isn't a dump at all — it's the **online backup API** (`db.backup()`), which produces a consistent copy of a live database into a single file without blocking writers. Offer that as the default, `.dump`-style SQL as the portable alternative, and note that plain file-copy of a WAL-mode database is *not* safe (you'd miss the `-wal` and `-shm` sidecars). Native tool is the `sqlite3` CLI (`.dump` / `.import`), though the built-in engine covers SQLite completely, so detection is optional here.
- **Redis.** There is no per-key file format. Use `DUMP`/`RESTORE` binary payloads wrapped in an NDJSON envelope (note: payloads are RDB-version-sensitive and won't restore to an older Redis), or `redis-cli --rdb` for a true RDB via replication. `BGSAVE` writes to the *server's* filesystem, which you can't reach from here — don't offer it as an export.
- **MongoDB.** `mongodump` BSON preserves types exactly; EJSON is readable but larger and lossy for some types. Recreate indexes after the data load.

### 7.6 Cross-engine copy (stretch, high value)

Table → table between two different connections — MySQL → Postgres, Postgres → Mongo. Same pipeline, different sink; the canonical `SchemaModel` from §4 does the type mapping, with a review step showing the proposed target DDL and any lossy conversions before it runs. This is the payoff for having built a real abstraction instead of five one-off dumpers.

---

## 8. Local **and** remote connectivity

Every engine must work against a database on this laptop, on the LAN, or in a datacenter. The app runs locally either way — only the path to the server changes.

### 8.1 The core rule

**Connectors never know how they were reached.** The access layer resolves first and hands the connector an already-usable `Address`; an SSH tunnel simply rewrites `db.internal:5432` into `127.0.0.1:<ephemeral>` before the connector is constructed.

```
ConnectionConfig ──▶ AccessResolver ──▶ resolved Address ──▶ Connector
                     (tunnel / proxy      127.0.0.1:54321
                      process / direct)
```

This keeps every connector transport-agnostic, means SSH and `kubectl port-forward` are written once instead of five times, and makes native dump tools (§7) work remotely for free — they get the same forwarded port.

The resolver owns: ephemeral local port allocation, tunnel lifecycle and refcounting (N connections sharing one tunnel), health checks, and teardown.

### 8.2 Access paths

| Path | Use | Notes |
| --- | --- | --- |
| Direct TCP | LAN, dev containers, cloud DBs with a public endpoint | Pair with TLS whenever it leaves the machine |
| Unix socket | Local MySQL/PG/Redis | Faster, and often the *only* thing that works — Postgres `peer` and MySQL `auth_socket` authenticate by OS user, so no password exists to type. Auto-detect the usual paths (`/tmp/mysql.sock`, `/var/run/postgresql`) and offer them in the connection form |
| SSH tunnel | The common case for production | Password, private key + passphrase, **ssh-agent**, and `ProxyJump`/bastion chains. Parse `~/.ssh/config` so a saved host name just works |
| Process proxy | `kubectl port-forward`, `cloud-sql-proxy`, `aws ssm start-session` | Spawn, wait for a ready pattern, own the lifecycle, restart on exit |
| Local file | SQLite | See the network-filesystem warning below |

**Cloud specifics worth pre-building**, because each has cost you an evening before: AWS RDS/Aurora (IAM auth tokens that expire every 15 min → regenerate on reconnect; bundled RDS CA), GCP Cloud SQL (proxy process path), Azure (TLS mandatory), MongoDB Atlas (`mongodb+srv://` needs DNS SRV lookups, plus IP allowlisting), ElastiCache/Upstash Redis (TLS + auth token).

**TLS** is per-engine-flag but one concept: CA bundle, optional client cert/key, and a verify mode. Expose `verify-full` / `require` / `skip` honestly — and when someone picks skip, say plainly that it's vulnerable to MITM rather than hiding it behind "allow insecure".

**SQLite over a network filesystem is unsafe** — SQLite's locking is broken over NFS/SMB and will corrupt the file. Don't quietly allow it. Instead offer the safe remote path: **fetch the file over SFTP into a local cache and open it read-only**, with an explicit "push changes back" step if they want write access. For genuinely remote SQLite, support `libsql://` (Turso) as a URI address instead.

### 8.3 Latency changes the design, not just the feel

Local is sub-millisecond. Remote is 50–300 ms per round trip, and that turns invisible patterns into unusable ones:

- **Introspection must be batched.** A per-table `SHOW CREATE TABLE` loop over a 500-table schema is 500 round trips — under 2 s locally, over 90 s on a 180 ms link. Introspect with a *fixed* number of queries (all columns, all indexes, all constraints in one `information_schema`/`pg_catalog` query each), then assemble the model in JS. Design it this way from M1; retrofitting it means rewriting every connector.
- **Adaptive defaults.** Measure RTT at connect time and use it: smaller default page size, longer schema-cache TTL, and more aggressive prefetch on slow links. Enable `mysql2` protocol compression for remote connections only.
- **Idle connections die.** NAT and firewalls silently drop idle TCP, and SSH tunnels are the worst offenders. Set TCP keepalives, a tunnel-level keepalive, and a pool idle timeout below the typical 5-minute NAT window.
- **Reconnect properly.** Auto-reconnect with exponential backoff, a visible connection-state indicator per connection, and — critically — the editor tab keeps your query text and results when the link drops. Losing an unsaved query to a dropped tunnel is the kind of thing that makes people stop using a tool.
- **Every remote operation needs a timeout and a cancel button.** Nothing may hang forever with a spinner.

### 8.4 Remote-side dumps (a real win)

Running `mysqldump` locally against a remote server pulls every row across the wire uncompressed. For large remote databases, offer the alternative: run the dump **on the remote host** over SSH and stream compressed bytes back —

```
ssh host 'mysqldump --single-transaction db | gzip -1' > local/db.sql.gz
```

Often 5–10× faster on a slow link. Requires the tool to exist remotely, so probe first and fall back to the local path. Same trick for `pg_dump` and `mongodump`.

### 8.5 Remote means production, so guard it

Remote connections are far more likely to be something you can't afford to break. Per-connection `envTag` drives real behavior, not just a color: `prod` gets a red header bar, a typed confirmation for destructive statements, and the option of a **read-only connection** — enforced both server-side (`default_transaction_read_only` on Postgres, read-only session on MySQL, a read-only user on Mongo, a client-side write-command blocklist for Redis) and client-side by statement classification. Belt and braces, because either one alone has holes.

---

## 9. Security model (localhost is not automatically safe)

Single-user and local, but three things still matter:

1. **Bind to `127.0.0.1` only.** Never `0.0.0.0`. A LAN-exposed DB admin with saved credentials is a very bad day. Under Docker this is the *publish* flag, and it's easy to get wrong: `-p 127.0.0.1:3456:3456`, never `-p 3456:3456`. Note that Docker's port publishing writes iptables/pf rules that bypass a host firewall, so the bind address is the real control.
2. **CSRF / DNS-rebinding.** Any website you visit can issue requests to the app's localhost port. Defenses: an account sign-in whose session cookie is `HttpOnly` + `SameSite=Strict` (so a cross-site request never carries it, which is what a header token was standing in for), strict `Origin` and `Host` validation on every request including reads, and session validation at the WebSocket upgrade.

   *Revised during implementation.* The original design used a random per-install token in an `X-DBAdmin-Token` header. It was sound but unusable: the only way in was to copy a 64-character string out of the container logs, and a rebuilt container silently invalidated it. `SameSite=Strict` gives the same guarantee against cross-site requests, so the token bought nothing the cookie does not.

   *Extended to multiple accounts.* Sign-up is open (the port is loopback-only), and **connections are private to the account that created them**. Two independent mechanisms enforce that, because one is not enough:

   - **Scoping.** A `globalThis`-pinned `AsyncLocalStorage` entered at the edge in `server.ts` carries the user down the whole async chain, so `store/db.ts` scopes every query without any of the seventeen call sites passing an id. Code that reaches owner-scoped data with no context throws rather than matching every row.
   - **Encryption.** One vault per user, keyed by their own password. Another user's secrets are not merely filtered out — they are undecryptable.

   Scoping the *tables* is the easy part and not where the leaks were. Both real leaks were in things that sit in FRONT of the tables: the schema cache (persisted and in-process, keyed by connection id alone) and the **connection pool**, which returns a live handle by id and only consulted ownership when it had to open one — so the leak appeared only after the owner had used the connection. `tests/e2e/user-isolation.mjs` warms the pool as the owner before probing, for exactly that reason.

   **The `globalThis` hazard is structural, not incidental.** `server.ts` runs under tsx while route handlers live in Next's webpack bundle: any module both sides import is instantiated *twice in one process*, and module-scoped state silently splits in half. This bit three separate stores — sessions (sign-in succeeded, the edge still rejected), the user context, and the WebSocket hub, where sockets registered in the tsx copy while `jobs/index.ts` broadcast into the Next copy, so **every** job-progress, Redis MONITOR and process-list stream delivered nothing while still reporting a healthy socket. Anything stateful shared across that boundary must be pinned with `Symbol.for()`.
3. **Credentials.** Encrypt with AES-256-GCM; key derived via scrypt/argon2id from a master passphrase entered once per app start and held **in memory only**. Passwords never travel back to the browser — the API returns `hasPassword: true`, never the value. Optional OS keychain integration (`@napi-rs/keyring`) later.

Plus the ordinary guardrails: parameterize everything the user didn't type; identifiers built by *us* (DDL, changesets) go through a per-engine quoting function, never string concatenation. Destructive statements (`DROP`, `TRUNCATE`, unqualified `DELETE`/`UPDATE`) get a confirm dialog that names the target and row count. Connections tagged `prod` get a red header and a stricter confirm.

---

## 10. Packaging: Docker

The app builds and runs as a container. That removes the "install Node first" step (this machine has none — only Homebrew, Docker 29.7.2 and the system `sqlite3`), makes the environment reproducible, and lets us **bake every native dump tool into the image** so §7.2's detection always succeeds. It also introduces one significant problem — a container's `localhost` is not your Mac's `localhost` — which §10.3 handles head-on.

### 10.1 Image

Multi-stage, `node:22-bookworm-slim` base. **Not Alpine:** `better-sqlite3` and friends have no musl prebuilds, so Alpine forces a fragile source build. Next.js `output: 'standalone'` keeps the runtime layer small.

```dockerfile
FROM node:22-bookworm-slim AS deps       # npm ci — native modules compiled for the image's arch
FROM deps AS build                       # next build (standalone)

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      default-mysql-client \                        # mysqldump / mysql
      postgresql-client-16 postgresql-client-17 \   # pg_dump must be >= server major (§7.2)
      sqlite3 redis-tools openssh-client ca-certificates
      # + mongodb-database-tools from MongoDB's apt repo
USER node
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1))"
```

Never copy `node_modules` from the Mac into the image — `better-sqlite3` is compiled per platform and a macOS build won't load on Linux. Build inside the container, targeting `linux/arm64` on Apple Silicon.

Shipping **multiple Postgres client versions** is deliberate: §7.2 refuses to dump when `pg_dump` is older than the server, and now we can satisfy that rule by selecting the right binary per connection instead of failing.

### 10.2 Compose

`compose.yml` runs the app; `compose.test.yml` holds the five engines and nothing else, brought up only while the tests need them — worth having, since none are installed on this machine. Development itself happens on the host (`npm run dev`), pinned to the same bundler the production build uses.

```
docker compose up                    # app only
docker compose -f compose.test.yml up -d   # MySQL, MariaDB, Postgres, Redis, Mongo on one network
```

| Setting | Value | Why |
| --- | --- | --- |
| `ports` | `127.0.0.1:${DBADMIN_PORT:-3456}:…` | **Not** a bare `3456:3456` — that binds `0.0.0.0` and exposes a credentialed DB admin to your whole LAN, defeating §9 |
| `volumes` | `dbadmin-data:/data/app` | The app DB. Without it, recreating the container wipes every saved connection |
| `volumes` | `~/sqlite:/data/sqlite` | SQLite files must be visible *inside* the container to be openable |
| `volumes` | `~/.ssh:/home/node/.ssh:ro` | Keys and `~/.ssh/config` for §8.2 tunnels |
| `user` | `${UID}:${GID}` | So exports and SQLite edits aren't root-owned on the host |
| `extra_hosts` | `host.docker.internal:host-gateway` | Linux parity with Docker Desktop |

### 10.3 The `localhost` problem — surface it in the UI

Inside the container, `localhost` is the container. Someone typing `localhost:3306` to reach MySQL on their Mac gets a connection refused, and this will be the single most confusing failure the app produces. The connection form should ask which case applies instead of letting people guess:

| The database is… | Use | Notes |
| --- | --- | --- |
| On the host machine | `host.docker.internal` | Provided by Docker Desktop; Linux needs the `extra_hosts` line above. The DB must also listen on the host's external interface, not only `127.0.0.1` |
| In another container | the service/container name | Requires sharing a Docker network — `docker network connect` for containers this compose file didn't start |
| Remote | the real hostname | Works exactly as §8 describes; containerization changes nothing |

Implementation: detect containerization at startup (`/.dockerenv`), and when a connection targets `localhost`/`127.0.0.1`, show an inline warning offering one-click rewrite to `host.docker.internal`. Cheap to build, saves hours of confusion.

**Unix sockets don't survive containerization on macOS.** §8.2 recommends them for local Postgres/MySQL, but Docker Desktop does not proxy bind-mounted unix sockets from the macOS host — socket connections work only when app and database are both on Linux, or both in containers sharing a volume. On macOS, local connections go over TCP via `host.docker.internal`. Say so in the connection form rather than failing mysteriously.

**SSH agent forwarding** needs Docker Desktop's magic socket: mount `/run/host-services/ssh-auth.sock` and point `SSH_AUTH_SOCK` at it. Without it, mounted keys still work but agent-only setups don't.

### 10.4 Consequences elsewhere

- **Testcontainers can't easily run inside the app container** — it would need the Docker socket mounted, which is a privilege-escalation path. Run the test suite on the host or in CI against the same image.
- **Every file path in the UI is a container path.** The SQLite browser and export-destination picker must browse the *container's* filesystem, default to a mounted directory (`/data/sqlite`, `/data/exports`), and show which host directory it maps to.
- **Secrets stay out of the image and the compose file.** The §9 master passphrase is entered at runtime; no DB credentials in `environment:` blocks, which leak into shell history and `docker inspect`.

---

## 11. Repo layout

Single Next.js app — a monorepo is overhead you don't need yet. What matters is the **directory boundary**: `src/server/**` imports zero React and zero Next types, so it can be lifted into a package (or an Electron main process) later without touching a line.

```
src/
  app/                    # routes + API route handlers (thin: validate → call server → serialize)
  components/             # shell, tree, grid, editor, viewers
  features/               # sql-workspace/ redis-workspace/ mongo-workspace/ er-diagram/ transfer/ …
  server/
    db/
      types.ts            # Connector interfaces + canonical SchemaModel
      manager.ts          # pools, sessions, cancel registry, tunnels
      sql/                # shared SQL helpers: lexer, quoting, changeset→SQL
      connectors/mysql/ postgres/ sqlite/ redis/ mongo/
    net/                  # AccessResolver: ssh tunnels, proxy processes, port alloc, keepalive (§8)
    jobs/                 # JobManager, progress events, persistence (§7.3)
    transfer/
      export/             # writers: csv, json, ndjson, xlsx, sql, markdown
      import/             # readers + mapping + fast paths (COPY, LOAD DATA, bulkWrite)
      native/             # binary detection + spawn wrappers for mysqldump/pg_dump/…
    store/                # sqlite schema + repositories
    vault.ts  tunnel.ts
  lib/                    # shared pure types between client & server
server.ts                 # http + next handler + ws upgrade
Dockerfile                # multi-stage: deps → build → runtime w/ native CLI tools (§10.1)
compose.yml               # app; 127.0.0.1 publish, named volume, mounts
compose.test.yml          # the five engines, no app service — up only while testing
.dockerignore             # must exclude node_modules — never ship a macOS-built native module
```

---

## 12. Milestones

Each ships something usable. Sizes assume solo work.

| # | Milestone | Deliverable | Done when |
| --- | --- | --- | --- |
| **M0** | Foundations + Docker + connectivity (~2w) | **Dockerfile + compose (app, plus an engines-only test stack) from commit one** — nothing is ever built on the host; scaffold, custom server, app-db store on a named volume, vault, connection CRUD UI over the `Address` × `Access` union, **`AccessResolver`** (direct, unix socket, SSH tunnel w/ agent + key + bastion chain, proxy process), `host.docker.internal` rewrite hint, TLS config, test-connection, auto-reconnect | `docker compose -f compose.test.yml up -d` gives you five running engines; a mounted SQLite file, a compose-network Postgres, a Mac-host MySQL via `host.docker.internal`, and a remote one behind a bastion all show green — and survive the laptop sleeping |
| **M1** | SQL core (~2.5w) | **SQLite connector first** (+ worker-thread pool), then MySQL + PG; ConnectionManager, introspection → canonical model, schema tree, data grid w/ paging + sort + filter | You can browse any table in any of the three engines and page through 1M rows smoothly |
| **M2** | SQL editor (~2w) | CodeMirror, schema autocomplete, statement lexer, run / run-under-cursor / run-selection, multi result tabs, cancel, query history, **quick export of a result set to CSV/JSON** | You'd reach for this instead of `psql` for everyday queries |
| **M3** | Editing & DDL (~2w) | Cell editing → changeset → diff preview → transactional apply, insert/delete rows, table/index/FK editors, DDL generation & export, SQLite 12-step `ALTER` rebuild | You can fix a bad row and create a table without writing SQL |
| **M4** | Redis (~1w) | Keyspace browser, type-aware viewers/editors, TTL, CLI console, MONITOR + pub/sub over WS | Replaces RedisInsight for daily use |
| **M5** | MongoDB (~1.5w) | Collection tree, doc tree + JSON editor, find/aggregate runner, indexes, explain | Replaces Compass for daily use |
| **M6** | Power tools (~1.5w) | ER diagram, EXPLAIN visualizer, process/session monitor, saved queries | The reasons you'd otherwise open DataGrip are mostly gone |
| **M7** | **Import & export (~2.5w)** | `JobManager` + jobs drawer; built-in streaming export (CSV/JSON/NDJSON/XLSX/SQL/MD, gzip); CSV import wizard w/ mapping + dry run; SQL dump runner; native-tool detection and delegated full dump/restore per engine (incl. SQLite online-backup export); import fast paths (`COPY`, `LOAD DATA`, `bulkWrite`) | Round-trip a 10 GB database out and back with correct types, cancel mid-run, and see progress the whole time |
| **M8** | Schema compare (~1w) | Introspect two scopes → canonical diff → generated migration DDL with review UI | Diff dev vs prod schema and get a runnable script |
| **M9** | Polish (~1w) | Command palette, keyboard map, light/dark, app-db backup/restore, first-run wizard, image slimming + published tag, README covering the §10.3 networking cases | You'd hand it to a friend |

Ordering notes:
- M1's canonical `SchemaModel` is load-bearing for M3, M6, M7 and M8. If it feels wrong by the end of M1, fix it *then* — not after four features depend on it.
- M7 depends on M1's `stream()` and M2's statement lexer (the SQL dump runner is that lexer plus progress), so it can't move earlier — but the *quick* result-set export lands in M2, which covers the common daily case long before the full subsystem exists.
- If import/export matters more to you than diagramming, swap M6 and M7. Nothing in M7 depends on M6.

---

## 13. Testing

- **Connector integration tests (the important ones):** testcontainers spins real MySQL 8, MariaDB 11, Postgres 16/17, Redis 7, Mongo 7 — SQLite needs no container, so wire it up first and get a fast conformance suite running on day one. Each connector runs the same suite: connect → create fixture schema → introspect → assert canonical model → query type-fidelity table (bigint, decimal, timestamptz, bytea, json, arrays) → apply changeset → cancel a long query.
- **Round-trip tests (import/export):** the highest-value test in the project. For each engine: build a fixture schema covering every nasty type (bigint, decimal, timestamptz, bytea/blob, json, arrays, enums, NULL vs empty string, unicode, embedded newlines and delimiters in text), export it in each format, re-import into a clean container, then assert the canonical schema model *and* a full row-level checksum match the original. Run it for both the native-tool path and the built-in engine.
- **Unit:** statement lexer (a nasty fixture corpus), changeset→SQL generator, canonical schema differ, quoting functions, CSV sniffer/writer edge cases.
- **Remote-condition tests:** put **toxiproxy** (it has a testcontainers module) in front of a containerized engine and inject 200 ms latency, bandwidth caps, and mid-query connection drops. Assert that introspection stays within its round-trip budget, that reconnect works, and that a dropped link never loses editor state. This is the only way to catch remote-only bugs without waiting to hit them in production.
- **Component:** grid virtualization + editing state, tree lazy loading.
- **Manual smoke:** one checklist per engine per milestone, run against the `docker compose -f compose.test.yml` stack.

Tests run on the host (or in CI) against the built image — **not inside the app container**, which would need the Docker socket mounted and is a privilege-escalation path (§10.4). Since there's no Node on this machine, the practical runner is a dedicated `test` compose service with the socket mounted deliberately, or GitHub Actions.

---

## 14. Deferred / open

Work beyond M9 is planned in [docs/roadmap.md](docs/roadmap.md), which supersedes the loose ends
below where the two overlap.

- Packaging as a desktop app (Electron/Tauri) — the `src/server` boundary keeps this cheap if you want it later.
- Multi-user + audit log — same.
- More engines: ClickHouse, DuckDB, Cassandra, DynamoDB, MSSQL. Adding one should be "implement `Connector`, register it, done" — if it isn't, the abstraction leaked.
- AI assist (natural-language → SQL with schema context) — natural fit once the schema cache exists.
