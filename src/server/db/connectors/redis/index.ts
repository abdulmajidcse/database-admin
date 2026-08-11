/**
 * Redis connector — a `KeyValueConnector`, not a SQL database wearing a hat
 * (PLAN §4).
 *
 * The governing constraint is PLAN §6 "Redis at scale": `KEYS *` will hang a
 * production box, so it is never issued from this file. Key browsing is SCAN
 * with MATCH/COUNT and real cursor pagination — per-node in cluster mode —
 * and the per-key metadata (TYPE, PTTL, MEMORY USAGE) is batched through a
 * pipeline instead of N round trips, which is what makes the browser usable on
 * a 180 ms link (§8.3).
 *
 * Two more things Redis forces on the design:
 *  - MONITOR and pub/sub put a connection into a mode where no other command
 *    works, so each gets its own dedicated socket that we own and tear down.
 *  - There is no server-side read-only session, so a read-only connection is
 *    enforced with a client-side write-command blocklist (§8.5).
 *
 * Server-only module: no React, no Next imports (PLAN §11).
 */

import { Cluster, Redis } from 'ioredis';
import type { ClusterNode, ClusterOptions, RedisOptions } from 'ioredis';
import { Buffer } from 'node:buffer';
import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';

import type { TlsConfig } from '../../../../lib/connection';
import type { EngineKind } from '../../../../lib/schema-model';
import type {
  KeyMeta,
  ProcessInfo,
  RedisValueType,
  ScanCursor,
  ServerInfo,
  TreeNode,
  TreePath,
  TypedValue,
} from '../../../../lib/results';
import { loopbackAdvice } from '../../../config';
import type { Capability, ConnectorContext, ConnectorEvent, KeyValueConnector } from '../../types';
import { DbError } from '../../types';
import {
  asDbError,
  asValueType,
  execBatch,
  flattenStrings,
  lengthCommand,
  parseScanReply,
  readTypedValue,
  toInt,
  toText,
  writeTypedValue,
  type BatchMode,
  type RedisLike,
} from './value';

// ---------------------------------------------------------------------------
// Read-only enforcement (PLAN §8.5)
// ---------------------------------------------------------------------------

/**
 * Redis has no `default_transaction_read_only` equivalent, so "read-only
 * connection" is a client-side blocklist. It is deliberately generous: a
 * command that *can* write (SORT with STORE, EVAL, GEORADIUS with STORE) is
 * blocked and the explicitly read-only variant (`SORT_RO`, `EVAL_RO`,
 * `GEORADIUS_RO`) is offered instead.
 */
const WRITE_COMMANDS = new Set<string>([
  // generic / keyspace
  'del', 'unlink', 'expire', 'expireat', 'pexpire', 'pexpireat', 'persist', 'rename', 'renamenx',
  'move', 'copy', 'restore', 'restore-asking', 'migrate', 'sort', 'swapdb', 'flushdb', 'flushall',
  // strings
  'set', 'setnx', 'setex', 'psetex', 'setrange', 'append', 'incr', 'incrby', 'incrbyfloat',
  'decr', 'decrby', 'getset', 'getdel', 'getex', 'mset', 'msetnx', 'setbit', 'bitfield', 'bitop',
  // lists
  'lpush', 'rpush', 'lpushx', 'rpushx', 'lpop', 'rpop', 'lset', 'ltrim', 'linsert', 'lrem',
  'lmove', 'lmpop', 'rpoplpush', 'blpop', 'brpop', 'blmove', 'blmpop', 'brpoplpush',
  // sets
  'sadd', 'srem', 'spop', 'smove', 'sinterstore', 'sunionstore', 'sdiffstore',
  // sorted sets
  'zadd', 'zincrby', 'zrem', 'zremrangebyscore', 'zremrangebyrank', 'zremrangebylex',
  'zpopmin', 'zpopmax', 'bzpopmin', 'bzpopmax', 'zmpop', 'bzmpop', 'zrangestore',
  'zdiffstore', 'zinterstore', 'zunionstore',
  // hashes
  'hset', 'hsetnx', 'hmset', 'hdel', 'hincrby', 'hincrbyfloat', 'hgetex', 'hgetdel',
  'hexpire', 'hpexpire', 'hexpireat', 'hpexpireat', 'hpersist',
  // hyperloglog / geo
  'pfadd', 'pfmerge', 'pfdebug', 'geoadd', 'georadius', 'georadiusbymember', 'geosearchstore',
  // streams
  'xadd', 'xdel', 'xtrim', 'xsetid', 'xgroup', 'xack', 'xclaim', 'xautoclaim', 'xreadgroup',
  // pub/sub side effects
  'publish', 'spublish',
  // scripting (the _RO variants stay allowed)
  'eval', 'evalsha', 'fcall',
  // admin
  'bgrewriteaof', 'bgsave', 'save', 'shutdown', 'slaveof', 'replicaof', 'failover', 'debug',
]);

/**
 * Container commands whose read-only subcommands are fine. Anything not listed
 * here is blocked on a read-only connection.
 */
const READONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  acl: new Set(['cat', 'getuser', 'list', 'users', 'whoami', 'help']),
  client: new Set(['getname', 'getredir', 'id', 'info', 'list', 'trackinginfo', 'help']),
  cluster: new Set([
    'countkeysinslot', 'getkeysinslot', 'info', 'keyslot', 'links', 'myid', 'nodes',
    'replicas', 'shards', 'slaves', 'slots', 'help',
  ]),
  command: new Set(['count', 'docs', 'getkeys', 'getkeysandflags', 'info', 'list', 'help']),
  config: new Set(['get', 'help']),
  function: new Set(['dump', 'list', 'stats', 'help']),
  latency: new Set(['doctor', 'graph', 'history', 'latest', 'help']),
  memory: new Set(['doctor', 'malloc-stats', 'stats', 'usage', 'help']),
  module: new Set(['list', 'help']),
  object: new Set(['encoding', 'freq', 'idletime', 'refcount', 'help']),
  pubsub: new Set(['channels', 'numpat', 'numsub', 'shardchannels', 'shardnumsub', 'help']),
  script: new Set(['exists', 'help']),
  slowlog: new Set(['get', 'len', 'help']),
  xinfo: new Set(['consumers', 'groups', 'stream', 'help']),
};

/** Module commands are not in the table above; these verbs give them away. */
const MODULE_WRITE_VERB = /\.(set|del|add|incr|decr|insert|merge|append|create|drop|alter|update|delete|forget|reserve|madd|mset|numincrby|strappend|arrappend|arrinsert|arrpop|arrtrim|toggle|clear)$/i;

/**
 * Commands that would leave the shared connection in a state where nothing
 * else works. The console refuses them and points at the panels that own a
 * dedicated socket instead.
 */
const STATEFUL_COMMANDS = new Set<string>([
  'monitor', 'subscribe', 'psubscribe', 'ssubscribe', 'unsubscribe', 'punsubscribe',
  'sunsubscribe', 'sync', 'psync', 'reset', 'hello',
  'multi', 'exec', 'discard', 'watch', 'unwatch',
]);

/** @returns why the command is refused on a read-only connection, or null. */
function writeBlockReason(name: string, sub: string | undefined): string | null {
  const allowed = READONLY_SUBCOMMANDS[name];
  if (allowed) {
    if (sub && allowed.has(sub)) return null;
    return `This connection is read-only: ${name.toUpperCase()} ${(sub ?? '').toUpperCase()} may modify server state. Allowed: ${[...allowed].join(', ').toUpperCase()}.`;
  }
  if (WRITE_COMMANDS.has(name)) {
    const ro = `${name}_ro`;
    const hint = ['sort', 'eval', 'evalsha', 'fcall', 'georadius', 'georadiusbymember', 'bitfield'].includes(name)
      ? ` Use ${ro.toUpperCase()} instead.`
      : '';
    return `This connection is read-only: ${name.toUpperCase()} writes.${hint}`;
  }
  if (MODULE_WRITE_VERB.test(name)) {
    return `This connection is read-only: ${name.toUpperCase()} looks like a module write command.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Option building
// ---------------------------------------------------------------------------

type DriverOptions = Record<string, string | number | boolean>;

/**
 * ioredis' constructors infer their reply-mapping generic from the options
 * object, and `RedisOptions.replyMapping` is the wide `ReplyMappingMode`. These
 * aliases pin it to `legacy` — which is also what every reply parser in
 * ./value.ts assumes — so `new Redis(...)` yields a plain `Redis`.
 * `ClusterOptionsWithReplyMapping` is not exported, hence the hand-rolled shape.
 */
type LegacyRedisOptions = RedisOptions & { replyMapping?: 'legacy' };
type LegacyNodeOptions = NonNullable<ClusterOptions['redisOptions']> & { replyMapping?: 'legacy' };
type LegacyClusterOptions = ClusterOptions & { redisOptions?: LegacyNodeOptions };

/** driverOptions keys this connector interprets; everything else is passed through. */
const RECOGNIZED_DRIVER_KEYS = new Set([
  'mode', 'clusterNodes', 'sentinels', 'sentinelName', 'masterName', 'sentinelRole',
  'sentinelUsername', 'sentinelPassword', 'scaleReads', 'slotsRefreshInterval',
]);

function optStr(o: DriverOptions, key: string): string | undefined {
  const v = o[key];
  return v === undefined || v === '' ? undefined : String(v);
}

/** `host:port,[::1]:6380,host2` → node list, with a per-family default port. */
function parseNodeList(raw: string, defaultPort: number): { host: string; port: number }[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(entry);
      if (bracketed) return { host: bracketed[1], port: Number(bracketed[2] ?? defaultPort) };
      const idx = entry.lastIndexOf(':');
      if (idx === -1) return { host: entry, port: defaultPort };
      const port = Number(entry.slice(idx + 1));
      return { host: entry.slice(0, idx), port: Number.isFinite(port) ? port : defaultPort };
    });
}

/** §8.2: TLS material is either inline PEM or a path inside the container. */
function pem(value: string): string {
  return value.includes('-----BEGIN') ? value : readFileSync(value, 'utf8');
}

function tlsOptions(tls: TlsConfig | undefined, host: string | undefined): TlsConnectionOptions | undefined {
  if (!tls?.enabled) return undefined;
  const out: TlsConnectionOptions = {};
  if (tls.caCert) out.ca = [pem(tls.caCert)];
  if (tls.clientCert) out.cert = pem(tls.clientCert);
  if (tls.clientKey) out.key = pem(tls.clientKey);

  const servername = tls.serverName ?? host;
  if (servername && isIP(servername) === 0) out.servername = servername;

  switch (tls.verify) {
    case 'skip':
      // §8.2 says to be honest about this rather than calling it "allow insecure".
      out.rejectUnauthorized = false;
      break;
    case 'require':
      // Encrypt and verify the chain, but tolerate a hostname mismatch — that
      // is exactly the difference between `require` and `verify-full`.
      out.rejectUnauthorized = true;
      out.checkServerIdentity = () => undefined;
      break;
    default:
      out.rejectUnauthorized = true;
  }
  return out;
}

/** redis:// · rediss:// · host:port · /path/to.sock */
function optionsFromUri(uri: string): RedisOptions {
  if (uri.startsWith('/')) return { path: uri };
  const url = new URL(uri.includes('://') ? uri : `redis://${uri}`);
  const out: RedisOptions = {};
  if (url.hostname) out.host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.port) out.port = Number(url.port);
  if (url.username) out.username = decodeURIComponent(url.username);
  if (url.password) out.password = decodeURIComponent(url.password);
  const path = url.pathname.replace(/^\//, '');
  if (/^\d+$/.test(path)) out.db = Number(path);
  // `rediss://` means TLS; an explicit TlsConfig replaces this default later.
  if (url.protocol === 'rediss:') out.tls = {};
  return out;
}

/** ClusterOptions.redisOptions forbids the per-node address keys. */
function nodeOptionsFrom(base: RedisOptions): LegacyNodeOptions {
  const copy: Record<string, unknown> = { ...base };
  for (const key of [
    'host', 'port', 'path', 'sentinels', 'name', 'role', 'retryStrategy',
    'enableOfflineQueue', 'readOnly', 'himportFieldsets',
  ]) {
    delete copy[key];
  }
  return copy as LegacyNodeOptions;
}

/**
 * SCAN MATCH takes a glob. A namespace name lifted out of real key text is
 * literal, so `cache[v2]` must not become a character class.
 */
function globEscape(literal: string): string {
  return literal.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
}

function versionNumber(version: string): number | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : undefined;
}

/** `# Server\nredis_version:7.2.4` → `{ server: { redis_version: '7.2.4' } }` */
export function parseInfo(raw: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = 'server';
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith('#')) {
      section = text.slice(1).trim().toLowerCase() || 'other';
      out[section] ??= {};
      continue;
    }
    const idx = text.indexOf(':');
    if (idx === -1) continue;
    (out[section] ??= {})[text.slice(0, idx)] = text.slice(idx + 1);
  }
  return out;
}

/** One `CLIENT LIST` line: `id=3 addr=1.2.3.4:5 … cmd=client|list user=default`. */
function parseClientList(raw: string, nodeLabel?: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const fields: Record<string, string> = {};
    for (const pair of text.split(' ')) {
      const idx = pair.indexOf('=');
      if (idx > 0) fields[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    if (!fields.id) continue;
    const ageSeconds = Number(fields.age);
    out.push({
      // Cluster ids repeat per node, so the node address disambiguates them
      // (and killProcess routes on that prefix).
      id: nodeLabel ? `${nodeLabel}#${fields.id}` : fields.id,
      user: fields.user || undefined,
      client: fields.addr || undefined,
      database: fields.db,
      state: fields.flags,
      command: fields.cmd,
      durationMs: Number.isFinite(ageSeconds) ? ageSeconds * 1000 : undefined,
      waitEvent: fields.events || undefined,
      // No structured slot for the rest, and the raw line is genuinely useful
      // in the session monitor (qbuf, omem, resp, lib-name …).
      query: text,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/**
 * Methods beyond `KeyValueConnector` that the Redis connector also provides.
 * `KeyValueConnector` has no process-list members, so callers narrow with
 * {@link redisExtras} after checking the `processList` capability.
 */
export interface RedisExtras {
  listProcesses(): Promise<ProcessInfo[]>;
  killProcess(id: string): Promise<void>;
}

type Topology = 'standalone' | 'sentinel' | 'cluster';

/** Keys sampled per tree level before the node counts are marked approximate. */
const TREE_SAMPLE_CAP = 5000;
/** Individual keys rendered at one tree level. */
const TREE_LEAF_CAP = 500;
const TREE_SCAN_ITERATIONS = 50;
const NAMESPACE_SEPARATOR = ':';

class RedisConnector implements KeyValueConnector, RedisExtras {
  readonly kind: EngineKind = 'redis';
  readonly capabilities: ReadonlySet<Capability>;

  private readonly ctx: ConnectorContext;
  private readonly topology: Topology;
  private readonly isCluster: boolean;
  private readonly baseOptions: LegacyRedisOptions;
  private readonly clusterNodes: ClusterNode[];
  private readonly clusterOptions: LegacyClusterOptions;
  private readonly connectionName: string;
  private readonly baseDb: number;

  private redis: Redis | null = null;
  private cluster: Cluster | null = null;
  /** One pinned connection per non-default database (§6 "Sessions vs pools"). */
  private readonly dbClients = new Map<number, Redis>();
  /** MONITOR / pub-sub sockets, tracked so close() can tear them all down. */
  private readonly streams = new Set<Redis>();
  private activeDb: number;
  private released = false;

  constructor(ctx: ConnectorContext) {
    this.ctx = ctx;
    const { config } = ctx;
    const driver: DriverOptions = config.options.driverOptions ?? {};
    this.connectionName = `dbadmin:${config.name}`.slice(0, 60);

    const base: LegacyRedisOptions = {};
    const address = ctx.resolved.address;
    switch (address.kind) {
      case 'tcp':
        base.host = address.host;
        base.port = address.port;
        break;
      case 'unix':
        base.path = address.socketPath;
        break;
      case 'uri':
        Object.assign(base, optionsFromUri(address.uri));
        break;
      case 'file':
        throw new DbError('Redis cannot be reached through a file path.', 'BAD_ADDRESS');
    }

    if (config.username) base.username = config.username;
    if (ctx.password !== undefined) base.password = ctx.password;
    if (config.options.redisDb !== undefined) base.db = config.options.redisDb;

    const tls = tlsOptions(config.tls, base.host);
    if (tls) base.tls = tls;

    base.connectTimeout = config.options.connectTimeoutMs ?? 10_000;
    if (config.options.statementTimeoutMs && config.options.statementTimeoutMs > 0) {
      base.commandTimeout = config.options.statementTimeoutMs;
    }
    // §8.3: NAT and firewalls silently drop idle TCP, and tunnels are the worst
    // offenders. Keepalives below the usual 5-minute window, fail fast on retry
    // so the UI can show a real error instead of spinning.
    base.keepAlive = 30_000;
    base.noDelay = true;
    base.maxRetriesPerRequest = 3;
    base.enableReadyCheck = true;
    base.lazyConnect = true;
    base.connectionName = this.connectionName;
    // NOTE: ioredis' own `readOnly` option means "read from cluster replicas".
    // It is NOT config.readOnly — that is enforced by the blocklist above (§8.5).

    const sentinelList = optStr(driver, 'sentinels');
    const clusterList = optStr(driver, 'clusterNodes');
    const declared = optStr(driver, 'mode')?.toLowerCase();
    this.topology =
      declared === 'cluster' || declared === 'sentinel' || declared === 'standalone'
        ? (declared as Topology)
        : clusterList
          ? 'cluster'
          : sentinelList
            ? 'sentinel'
            : 'standalone';
    this.isCluster = this.topology === 'cluster';

    if (this.topology === 'sentinel') {
      if (!sentinelList) {
        throw new DbError(
          'Sentinel mode needs driverOptions.sentinels, e.g. "s1:26379,s2:26379".',
          'BAD_OPTIONS',
        );
      }
      base.sentinels = parseNodeList(sentinelList, 26379);
      base.name = optStr(driver, 'sentinelName') ?? optStr(driver, 'masterName') ?? 'mymaster';
      const role = optStr(driver, 'sentinelRole');
      base.role = role === 'slave' ? 'slave' : 'master';
      const sentinelUser = optStr(driver, 'sentinelUsername');
      if (sentinelUser) base.sentinelUsername = sentinelUser;
      const sentinelPassword = optStr(driver, 'sentinelPassword');
      if (sentinelPassword) base.sentinelPassword = sentinelPassword;
      if (tls) base.enableTLSForSentinelMode = true;
      // The Sentinel connector resolves the master itself; the seed address is
      // only used when the user left the sentinel list empty.
      delete base.host;
      delete base.port;
    }

    // Pass unrecognized driverOptions straight through, as ConnectionOptions promises.
    for (const [key, value] of Object.entries(driver)) {
      if (!RECOGNIZED_DRIVER_KEYS.has(key)) (base as Record<string, unknown>)[key] = value;
    }
    // Pinned last: every reply parser in ./value.ts is written against the
    // RESP2-compatible shapes, and this holds even when ioredis negotiates RESP3.
    base.replyMapping = 'legacy';

    this.baseOptions = base;
    this.baseDb = base.db ?? 0;
    this.activeDb = this.baseDb;

    this.clusterNodes = clusterList
      ? parseNodeList(clusterList, base.port ?? 6379)
      : base.host
        ? [{ host: base.host, port: base.port ?? 6379 }]
        : [];
    const scaleReads = optStr(driver, 'scaleReads');
    this.clusterOptions = {
      redisOptions: nodeOptionsFrom(base),
      lazyConnect: true,
      enableReadyCheck: true,
      scaleReads: scaleReads === 'slave' || scaleReads === 'all' ? scaleReads : 'master',
      slotsRefreshInterval: Number(optStr(driver, 'slotsRefreshInterval') ?? 5000),
      // §8.3: concurrent commands get coalesced into one pipeline per node,
      // which is what makes the `fanout` batch mode cost one round trip.
      enableAutoPipelining: true,
    };

    const caps: Capability[] = ['keyspace', 'processList', 'streaming'];
    // SELECT does not exist in cluster mode — there is one logical database.
    if (!this.isCluster) caps.push('multipleDatabases');
    this.capabilities = new Set(caps);
  }

  // -- lifecycle ------------------------------------------------------------

  async open(): Promise<void> {
    this.emit({ type: 'state', state: 'connecting' });
    try {
      if (this.isCluster) {
        if (this.clusterNodes.length === 0) {
          throw new DbError('Cluster mode needs at least one seed node.', 'BAD_OPTIONS');
        }
        const cluster = new Cluster(this.clusterNodes, this.clusterOptions);
        this.wire(cluster);
        this.cluster = cluster;
        await cluster.connect();
      } else {
        const redis = new Redis(this.baseOptions);
        this.wire(redis);
        this.redis = redis;
        await redis.connect();
      }
      this.emit({ type: 'state', state: 'connected' });
    } catch (err) {
      await this.close().catch(() => undefined);
      throw this.connectError(err);
    }
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.disconnect();
    this.streams.clear();
    for (const client of this.dbClients.values()) await quietQuit(client);
    this.dbClients.clear();
    if (this.redis) {
      await quietQuit(this.redis);
      this.redis = null;
    }
    if (this.cluster) {
      await quietQuit(this.cluster);
      this.cluster = null;
    }
    // §8.1: the resolver refcounts the tunnel; this connector held one reference
    // for its whole lifetime and gives it back exactly once.
    if (!this.released) {
      this.released = true;
      await this.ctx.resolved.release().catch(() => undefined);
    }
    this.emit({ type: 'state', state: 'closed' });
  }

  async ping(): Promise<ServerInfo> {
    const client = this.requireClient();
    const started = performance.now();
    await client.call('ping', []);
    // §8.3: RTT drives adaptive page sizes and cache TTLs upstream.
    const rttMs = performance.now() - started;

    const sections = await this.info();
    const server = sections.server ?? {};
    const memory = sections.memory ?? {};
    const clients = sections.clients ?? {};
    const replication = sections.replication ?? {};
    const version = server.redis_version ?? server.valkey_version ?? 'unknown';

    const details: Record<string, string> = { topology: this.topology };
    for (const [label, value] of [
      ['mode', server.redis_mode],
      ['role', replication.role],
      ['os', server.os],
      ['clients', clients.connected_clients],
      ['usedMemory', memory.used_memory_human],
      ['maxmemoryPolicy', memory.maxmemory_policy],
      ['activeDb', String(this.activeDb)],
    ] as const) {
      if (value) details[label] = value;
    }

    return {
      version,
      versionNumber: versionNumber(version),
      edition: server.redis_mode,
      uptimeSeconds: server.uptime_in_seconds ? Number(server.uptime_in_seconds) : undefined,
      rttMs,
      details,
    };
  }

  // -- tree (PLAN §6: databases, then key namespaces) -----------------------

  async listNodes(path: TreePath): Promise<TreeNode[]> {
    const segments = path.segments ?? [];
    if (segments.length === 0) return this.databaseNodes();

    const dbSegment = segments.find((s) => s.startsWith('db:'));
    if (!dbSegment) return [];
    const db = Number(dbSegment.slice(3));
    if (!Number.isInteger(db) || db < 0) return [];

    // Namespaces nest: `db:0/keyspace:user/keyspace:session` → prefix `user:session:`.
    const names = segments.filter((s) => s.startsWith('keyspace:')).map((s) => s.slice('keyspace:'.length));
    const prefix = names.length ? `${names.join(NAMESPACE_SEPARATOR)}${NAMESPACE_SEPARATOR}` : '';
    return this.keyspaceNodes(db, prefix, segments.join('/'));
  }

  private async databaseNodes(): Promise<TreeNode[]> {
    const databases = await this.listDatabases();
    return databases.map((db) => ({
      id: `db:${db.index}`,
      kind: 'database' as const,
      label: `db${db.index}`,
      detail: `${db.keys} keys`,
      hasChildren: db.keys > 0,
      meta: { db: db.index, keys: db.keys, topology: this.topology },
    }));
  }

  private async keyspaceNodes(db: number, prefix: string, base: string): Promise<TreeNode[]> {
    const { pages, truncated } = await this.sampleKeys(db, `${globEscape(prefix)}*`, TREE_SAMPLE_CAP);

    const groups = new Map<string, number>();
    const leaves: string[] = [];
    for (const page of pages) {
      for (const key of page.keys) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(NAMESPACE_SEPARATOR);
        if (idx > 0) {
          const name = rest.slice(0, idx);
          groups.set(name, (groups.get(name) ?? 0) + 1);
        } else {
          leaves.push(key);
        }
      }
    }

    const namespaceNodes: TreeNode[] = [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({
        id: `${base}/keyspace:${name}`,
        kind: 'keyspace' as const,
        label: name,
        detail: `${count}${truncated ? '+' : ''} keys`,
        hasChildren: true,
        meta: { db, prefix: `${prefix}${name}${NAMESPACE_SEPARATOR}`, approximate: truncated },
      }));

    // Describe only the keys actually rendered, per originating node so the
    // pipeline stays inside one cluster slot group.
    const shown = new Set(leaves.sort((a, b) => a.localeCompare(b)).slice(0, TREE_LEAF_CAP));
    const metas: KeyMeta[] = [];
    for (const page of pages) {
      const subset = page.keys.filter((k) => shown.has(k));
      if (subset.length) metas.push(...(await this.describeKeys(page.client, subset, 'pipeline')));
    }
    metas.sort((a, b) => a.key.localeCompare(b.key));

    const keyNodes: TreeNode[] = metas.map((meta) => ({
      id: `${base}/key:${meta.key}`,
      kind: 'key' as const,
      label: meta.key.slice(prefix.length),
      detail: meta.length === undefined ? meta.type : `${meta.type} · ${meta.length}`,
      hasChildren: false,
      meta: { db, key: meta.key, type: meta.type, ttlMs: meta.ttlMs, sizeBytes: meta.sizeBytes },
    }));

    return [...namespaceNodes, ...keyNodes];
  }

  // -- keyspace -------------------------------------------------------------

  /**
   * One page of SCAN. Never KEYS (§6). In cluster mode every master is scanned
   * with its own cursor, tracked in `ScanCursor.nodeCursors` keyed by
   * `host:port`; a node whose cursor came back `0` is recorded as `done` so the
   * next page can tell "finished" apart from "start again".
   */
  async scanKeys(cur: ScanCursor): Promise<{ keys: KeyMeta[]; next: ScanCursor; done: boolean }> {
    const match = cur.match && cur.match.length > 0 ? cur.match : '*';
    const count = Math.min(Math.max(cur.count ?? 500, 10), 10_000);
    const db = this.isCluster ? 0 : (cur.db ?? this.activeDb);
    // Browsing a database makes it the one readKey/writeKey act on.
    if (!this.isCluster) this.activeDb = db;

    if (this.isCluster) {
      const masters = this.masters();
      const previous = cur.nodeCursors;
      const nodeCursors: Record<string, string> = { ...(previous ?? {}) };

      const pending = masters.filter((node) => (previous?.[nodeKey(node)] ?? '0') !== 'done');
      const scans = await Promise.all(
        pending.map(async (node) => {
          const key = nodeKey(node);
          const from = previous?.[key] ?? '0';
          const page = await this.scanPage(node, from, match, count);
          return { key, node, page };
        }),
      );

      const metas: KeyMeta[] = [];
      for (const scan of scans) {
        nodeCursors[scan.key] = scan.page.cursor === '0' ? 'done' : scan.page.cursor;
        // The node owns these keys, so its own connection can pipeline the
        // metadata without tripping the cluster's same-slot-group rule.
        if (scan.page.keys.length) metas.push(...(await this.describeKeys(scan.node, scan.page.keys, 'pipeline')));
      }
      for (const node of masters) nodeCursors[nodeKey(node)] ??= '0';

      const done = masters.every((node) => nodeCursors[nodeKey(node)] === 'done');
      return { keys: metas, next: { cursor: done ? '0' : 'cluster', match, count, db: 0, nodeCursors }, done };
    }

    const client = await this.clientForDb(db);
    const page = await this.scanPage(client, cur.cursor || '0', match, count);
    return {
      keys: await this.describeKeys(client, page.keys, 'pipeline'),
      next: { cursor: page.cursor, match, count, db },
      // A page can be empty with a non-zero cursor; only cursor 0 means done.
      done: page.cursor === '0',
    };
  }

  async readKey(key: string, opts?: { offset?: number; limit?: number }): Promise<TypedValue> {
    const client = await this.clientForDb(this.activeDb);
    const type = asValueType(toText(await client.call('type', [key])));
    return readTypedValue(client, key, type, opts ?? {});
  }

  async writeKey(key: string, value: TypedValue, ttlMs?: number): Promise<void> {
    this.assertWritable('writeKey');
    const client = await this.clientForDb(this.activeDb);
    await writeTypedValue(client, key, value, ttlMs);
  }

  async deleteKeys(keys: string[]): Promise<number> {
    this.assertWritable('deleteKeys');
    if (keys.length === 0) return 0;
    const client = await this.clientForDb(this.activeDb);
    const mode = this.batchMode(client);

    // UNLINK reclaims memory on a background thread; DEL blocks the server on a
    // large collection. One command per key, because a multi-key UNLINK would
    // be CROSSSLOT in cluster mode.
    let replies = await execBatch(client, keys.map((k) => ['unlink', k]), mode);
    if (replies.some(([err]) => err && /unknown command/i.test(err.message))) {
      replies = await execBatch(client, keys.map((k) => ['del', k]), mode); // Redis < 4
    }

    let deleted = 0;
    for (const [err, value] of replies) {
      if (err) throw asDbError(err, 'UNLINK');
      deleted += toInt(value);
    }
    return deleted;
  }

  async renameKey(from: string, to: string): Promise<void> {
    this.assertWritable('renameKey');
    const client = await this.clientForDb(this.activeDb);
    try {
      await client.call('rename', [from, to]);
    } catch (err) {
      const error = asDbError(err, 'RENAME');
      if (/CROSSSLOT/i.test(error.message)) {
        throw new DbError(
          `RENAME needs both keys on the same cluster node. Wrap the shared part in a hash tag, e.g. {${from}}:new.`,
          'CROSSSLOT',
        );
      }
      throw error;
    }
  }

  /** `null` clears the expiry (PERSIST); anything else sets it in ms (PEXPIRE). */
  async expireKey(key: string, ttlMs: number | null): Promise<void> {
    this.assertWritable('expireKey');
    const client = await this.clientForDb(this.activeDb);
    if (ttlMs === null) {
      // PERSIST answers 0 when the key simply had no TTL — not an error.
      await client.call('persist', [key]);
      return;
    }
    const applied = await client.call('pexpire', [key, Math.max(1, Math.trunc(ttlMs))]);
    if (toInt(applied) !== 1) throw new DbError(`No such key: ${key}`, 'NO_SUCH_KEY');
  }

  // -- console --------------------------------------------------------------

  async command(argv: string[]): Promise<unknown> {
    if (argv.length === 0) throw new DbError('Empty command.', 'EMPTY_COMMAND');
    const name = String(argv[0]).toLowerCase();
    const sub = argv.length > 1 ? String(argv[1]).toLowerCase() : undefined;

    if (STATEFUL_COMMANDS.has(name)) {
      throw new DbError(
        `${name.toUpperCase()} would leave this connection in a mode where no other command works. ` +
          'Use the Monitor / Pub-Sub panel, which opens its own connection.',
        'CONNECTION_MODE',
      );
    }

    if (this.ctx.config.readOnly) {
      const reason = writeBlockReason(name, sub);
      if (reason) throw new DbError(reason, 'READONLY_CONNECTION');
    }

    // SELECT is intercepted rather than sent: issuing it on a shared connection
    // would silently re-point every other in-flight read. Switching the active
    // database instead moves subsequent calls to that database's own pinned
    // connection (§6 "Sessions vs pools").
    if (name === 'select') {
      if (this.isCluster) {
        throw new DbError('Redis Cluster has a single database; SELECT is not supported.', 'CLUSTER_NO_SELECT');
      }
      const index = Number(argv[1]);
      if (!Number.isInteger(index) || index < 0) throw new DbError('SELECT needs a database index.', 'BAD_ARG');
      await this.clientForDb(index);
      this.activeDb = index;
      return 'OK';
    }

    if (name === 'keys') {
      // §6: we never issue KEYS ourselves. When someone types it we still run
      // it — this is a raw console — but we say out loud what it costs.
      this.emit({
        type: 'notice',
        message: 'KEYS walks the entire keyspace and blocks the server. The key browser uses SCAN instead.',
      });
    }

    const client = await this.clientForDb(this.activeDb);
    try {
      return normalizeReply(await client.call(name, argv.slice(1)));
    } catch (err) {
      throw asDbError(err);
    }
  }

  // -- streaming (dedicated connections) ------------------------------------

  /**
   * §6: MONITOR puts a connection into a mode where every other command is
   * rejected, so it gets a socket of its own. The returned function tears that
   * socket down; callers pump `sink` into a WebSocket with a ring buffer.
   */
  monitor(sink: (line: string) => void): () => void {
    const conn = this.openStream({ monitor: true }, 'monitor');
    conn.on('monitor', (time: string, args: string[], source: string, database: string) => {
      // redis-cli's MONITOR format: <ts> [<db> <addr>] "cmd" "arg" …
      const rendered = (args ?? []).map((arg) => JSON.stringify(String(arg))).join(' ');
      sink(`${time} [${database} ${source}] ${rendered}`);
    });
    return () => this.closeStream(conn);
  }

  /**
   * §6: a subscriber connection cannot run normal commands either. Glob
   * characters switch to PSUBSCRIBE so `events:*` works as typed.
   */
  subscribe(channel: string, sink: (msg: unknown) => void): () => void {
    const conn = this.openStream({}, 'pubsub');
    const isPattern = /[*?[]/.test(channel);

    if (isPattern) {
      conn.on('pmessage', (pattern: string, ch: string, message: string) => {
        sink({ channel: ch, pattern, message, at: Date.now() });
      });
      conn.psubscribe(channel).catch((err: unknown) => {
        this.emit({ type: 'error', message: asDbError(err, `PSUBSCRIBE ${channel}`).message });
      });
    } else {
      conn.on('message', (ch: string, message: string) => {
        sink({ channel: ch, message, at: Date.now() });
      });
      conn.subscribe(channel).catch((err: unknown) => {
        this.emit({ type: 'error', message: asDbError(err, `SUBSCRIBE ${channel}`).message });
      });
    }

    return () => this.closeStream(conn);
  }

  // -- server facts ---------------------------------------------------------

  async listDatabases(): Promise<{ index: number; keys: number }[]> {
    if (this.isCluster) {
      const sizes = await Promise.all(this.masters().map((node) => node.dbsize().catch(() => 0)));
      return [{ index: 0, keys: sizes.reduce((sum, n) => sum + toInt(n), 0) }];
    }

    // INFO keyspace only reports non-empty databases, so CONFIG GET databases
    // fills in the empty ones. Managed Redis usually disables CONFIG — then the
    // list is just whatever has keys, which is still correct, only shorter.
    const keyspace = (await this.info()).keyspace ?? {};
    const counts = new Map<number, number>();
    for (const [name, value] of Object.entries(keyspace)) {
      const index = /^db(\d+)$/.exec(name);
      if (!index) continue;
      const keys = /keys=(\d+)/.exec(value);
      counts.set(Number(index[1]), keys ? Number(keys[1]) : 0);
    }

    let configured = 0;
    try {
      const flat = flattenStrings(await this.requireClient().call('config', ['get', 'databases']));
      if (flat.length >= 2) configured = Number(flat[1]) || 0;
    } catch {
      configured = 0;
    }

    const highest = Math.max(configured, ...[...counts.keys()].map((n) => n + 1), this.baseDb + 1, 1);
    return Array.from({ length: highest }, (_unused, index) => ({ index, keys: counts.get(index) ?? 0 }));
  }

  async info(): Promise<Record<string, Record<string, string>>> {
    const client = this.infoTarget();
    try {
      // `everything` adds commandstats/latencystats; older servers reject it.
      return parseInfo(toText(await client.call('info', ['everything'])));
    } catch {
      return parseInfo(toText(await client.call('info', [])));
    }
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    if (this.isCluster) {
      const nodes = this.masters();
      const lists = await Promise.all(
        nodes.map(async (node) => {
          try {
            return parseClientList(toText(await node.call('client', ['list'])), nodeKey(node));
          } catch {
            return [] as ProcessInfo[];
          }
        }),
      );
      return lists.flat();
    }
    return parseClientList(toText(await this.requireClient().call('client', ['list'])));
  }

  async killProcess(id: string): Promise<void> {
    this.assertWritable('killProcess');
    const hash = id.lastIndexOf('#');
    if (this.isCluster && hash > 0) {
      const label = id.slice(0, hash);
      const node = this.masters().find((n) => nodeKey(n) === label);
      if (!node) throw new DbError(`Unknown cluster node: ${label}`, 'NO_SUCH_NODE');
      await node.call('client', ['kill', 'id', id.slice(hash + 1)]);
      return;
    }
    await this.requireClient().call('client', ['kill', 'id', id]);
  }

  // -- internals ------------------------------------------------------------

  private emit(event: ConnectorEvent): void {
    this.ctx.onEvent?.(event);
  }

  private assertWritable(operation: string): void {
    // §8.5: belt and braces — the same rule the console blocklist applies.
    if (this.ctx.config.readOnly) {
      throw new DbError(
        `This connection is read-only (${this.ctx.config.envTag}); ${operation} is blocked.`,
        'READONLY_CONNECTION',
      );
    }
  }

  private requireClient(): RedisLike {
    const client = this.cluster ?? this.redis;
    if (!client) throw new DbError('Redis connection is not open.', 'NOT_CONNECTED');
    return client;
  }

  private infoTarget(): RedisLike {
    // A cluster-wide INFO is meaningless; ask a specific master.
    if (this.cluster) return this.masters()[0];
    return this.requireClient();
  }

  private masters(): Redis[] {
    if (!this.cluster) throw new DbError('Redis connection is not open.', 'NOT_CONNECTED');
    const nodes = this.cluster.nodes('master');
    if (nodes.length === 0) throw new DbError('No cluster master is reachable.', 'CLUSTERDOWN');
    return nodes;
  }

  /** Cluster pipelines cannot span node groups; the Cluster client fans out instead. */
  private batchMode(client: RedisLike): BatchMode {
    return this.cluster !== null && (client as unknown) === (this.cluster as unknown) ? 'fanout' : 'pipeline';
  }

  private async clientForDb(db: number): Promise<RedisLike> {
    if (this.isCluster) {
      if (db !== 0) throw new DbError('Redis Cluster has a single database; SELECT is not supported.', 'CLUSTER_NO_SELECT');
      return this.requireClient();
    }
    const main = this.redis;
    if (!main) throw new DbError('Redis connection is not open.', 'NOT_CONNECTED');
    if (db === this.baseDb) return main;

    const cached = this.dbClients.get(db);
    if (cached) return cached;

    // A shared SELECT would race with every in-flight command, so each extra
    // database gets a pinned connection instead (§6 "Sessions vs pools").
    const extra = main.duplicate({ db, lazyConnect: true, connectionName: `${this.connectionName}:db${db}` });
    extra.on('error', (err: Error) => this.emit({ type: 'error', message: err.message }));
    try {
      await extra.connect();
    } catch (err) {
      extra.disconnect();
      throw this.connectError(err);
    }
    this.dbClients.set(db, extra);
    return extra;
  }

  private async scanPage(
    client: RedisLike,
    cursor: string,
    match: string,
    count: number,
  ): Promise<{ cursor: string; keys: string[] }> {
    try {
      const page = parseScanReply(await client.call('scan', [cursor, 'MATCH', match, 'COUNT', count]));
      return { cursor: page.cursor, keys: page.items.map(toText) };
    } catch (err) {
      throw asDbError(err, 'SCAN');
    }
  }

  /**
   * PLAN §6: TYPE + PTTL + MEMORY USAGE for a whole page go through ONE
   * pipeline — 3N commands, one round trip instead of 3N. A second pipeline
   * adds the cardinality, which is still O(1) round trips per page (§8.3).
   */
  private async describeKeys(client: RedisLike, keys: string[], mode: BatchMode): Promise<KeyMeta[]> {
    if (keys.length === 0) return [];

    // MEMORY USAGE has no key spec ioredis can route on, so a Cluster client
    // would send it to an arbitrary node and get a nil back. Only ask for it
    // when the connection is already pinned to the node that owns the keys.
    const withMemory = mode === 'pipeline';
    const stride = withMemory ? 3 : 2;

    const cmds: unknown[][] = [];
    for (const key of keys) {
      cmds.push(['type', key], ['pttl', key]);
      if (withMemory) cmds.push(['memory', 'usage', key]);
    }
    const replies = await execBatch(client, cmds, mode);

    const metas: KeyMeta[] = keys.map((key, i) => {
      const type: RedisValueType = asValueType(toText(replies[i * stride]?.[1]));
      // PTTL answers -1 for "no expiry" and -2 for "gone"; both are passed
      // through untouched so the UI can tell them apart.
      const ttlMs = toInt(replies[i * stride + 1]?.[1], -1);
      const memory = withMemory ? replies[i * stride + 2] : undefined;
      const sizeBytes = memory && !memory[0] && memory[1] !== null ? toInt(memory[1]) : undefined;
      return { key, type, ttlMs, sizeBytes };
    });

    const targets: number[] = [];
    const lengthCmds: unknown[][] = [];
    metas.forEach((meta, i) => {
      const cmd = lengthCommand(meta.type, meta.key);
      if (cmd) {
        targets.push(i);
        lengthCmds.push(cmd);
      }
    });
    const lengths = await execBatch(client, lengthCmds, mode);
    targets.forEach((index, i) => {
      const reply = lengths[i];
      if (reply && !reply[0]) metas[index].length = toInt(reply[1]);
    });

    return metas;
  }

  /**
   * Bounded sample used to build the tree. Returns keys grouped by the
   * connection that produced them, so the caller can pipeline follow-up
   * commands against the node that actually owns them.
   */
  private async sampleKeys(
    db: number,
    match: string,
    cap: number,
  ): Promise<{ pages: { client: RedisLike; keys: string[] }[]; truncated: boolean }> {
    const scanners: RedisLike[] = this.isCluster ? this.masters() : [await this.clientForDb(db)];
    const pages: { client: RedisLike; keys: string[] }[] = [];
    let total = 0;
    let truncated = false;

    for (const client of scanners) {
      const keys: string[] = [];
      let cursor = '0';
      for (let i = 0; i < TREE_SCAN_ITERATIONS; i++) {
        const page = await this.scanPage(client, cursor, match, 1000);
        cursor = page.cursor;
        for (const key of page.keys) {
          if (total >= cap) {
            truncated = true;
            break;
          }
          keys.push(key);
          total++;
        }
        if (cursor === '0' || truncated) break;
      }
      if (cursor !== '0') truncated = true;
      pages.push({ client, keys });
      if (truncated) break;
    }

    return { pages, truncated };
  }

  /** A socket that exists only to carry MONITOR or pub/sub traffic. */
  private openStream(override: Partial<LegacyRedisOptions>, label: string): Redis {
    const options: LegacyRedisOptions = {
      ...this.baseOptions,
      ...this.streamAddress(),
      ...override,
      lazyConnect: false,
      connectionName: `${this.connectionName}:${label}`,
    };
    const conn = new Redis(options);
    conn.on('error', (err: Error) => this.emit({ type: 'error', message: `${label}: ${err.message}` }));
    this.streams.add(conn);
    return conn;
  }

  private closeStream(conn: Redis): void {
    this.streams.delete(conn);
    conn.disconnect();
  }

  /**
   * MONITOR and pub/sub are per-node, so in cluster mode they attach to one
   * master (the first) rather than pretending to cover the whole cluster.
   */
  private streamAddress(): Partial<LegacyRedisOptions> {
    if (!this.cluster) return {};
    const node = this.masters()[0];
    return { host: node.options.host, port: node.options.port, path: undefined, db: 0, sentinels: undefined };
  }

  /** §8.3: the connection-state indicator is the whole point of these events. */
  private wire(client: Redis | Cluster): void {
    // Both classes are EventEmitters; going through the base interface avoids
    // resolving ioredis' per-event overloads across the union.
    const emitter: EventEmitter = client;
    // An unhandled 'error' on an ioredis client crashes the process, so this
    // listener is mandatory rather than cosmetic.
    emitter.on('error', (err: Error) => this.emit({ type: 'error', message: err.message }));
    emitter.on('ready', () => this.emit({ type: 'state', state: 'connected' }));
    emitter.on('reconnecting', () => this.emit({ type: 'state', state: 'reconnecting' }));
    emitter.on('end', () => this.emit({ type: 'state', state: 'closed' }));
  }

  /** §10.3: a container's `localhost` is the container, and that failure looks like nothing else. */
  private connectError(err: unknown): DbError {
    const error = asDbError(err);
    const host = this.baseOptions.host;
    if (host && /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT/i.test(`${error.code ?? ''} ${error.message}`)) {
      const advice = loopbackAdvice(host);
      if (advice) return new DbError(`${error.message}\n\n${advice}`, error.code);
    }
    return error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeKey(node: Redis): string {
  return `${node.options.host ?? '?'}:${node.options.port ?? 0}`;
}

/** Structural shape shared by Redis and Cluster, avoiding a union-overload call. */
interface Closable {
  quit(): Promise<unknown>;
  disconnect(): void;
}

async function quietQuit(client: Closable): Promise<void> {
  try {
    await client.quit();
  } catch {
    // QUIT fails if the link is already gone; drop the socket either way.
    client.disconnect();
  }
}

/** Console replies: Buffers become text, nested errors become inspectable objects. */
function normalizeReply(reply: unknown): unknown {
  if (reply instanceof Error) return { error: reply.message };
  if (Array.isArray(reply)) return reply.map(normalizeReply);
  if (reply !== null && typeof reply === 'object' && !Buffer.isBuffer(reply)) {
    return Object.fromEntries(Object.entries(reply as Record<string, unknown>).map(([k, v]) => [k, normalizeReply(v)]));
  }
  if (Buffer.isBuffer(reply)) return reply.toString('utf8');
  return reply;
}

/**
 * Narrow a Redis `KeyValueConnector` to the process-list methods it also
 * provides. `KeyValueConnector` cannot declare them, so callers gate on the
 * `processList` capability and use this.
 */
export function redisExtras(connector: KeyValueConnector): RedisExtras | null {
  return connector instanceof RedisConnector ? connector : null;
}

export function createRedisConnector(ctx: ConnectorContext): KeyValueConnector {
  return new RedisConnector(ctx);
}
