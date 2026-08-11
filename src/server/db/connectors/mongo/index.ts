/**
 * MongoDB connector — a `DocumentConnector`, not a SQL database wearing a hat
 * (PLAN §4).
 *
 * What actually matters here:
 *
 *  • **Type fidelity (§6).** Every read operation runs with `promoteValues:
 *    false` / `promoteLongs: false` / `promoteBuffers: false` / `bsonRegExp:
 *    true`, so the driver hands us real `Int32`/`Double`/`Long`/`Binary`/
 *    `BSONRegExp` instances instead of lossily promoted JS values. ./ejson.ts
 *    then encodes those into the wire format and decodes edits back. Server
 *    *metadata* commands keep the driver's default promotion — nobody needs an
 *    `Int32` wrapper around `uptime`.
 *
 *  • **`skip` is O(n) (§8.3).** The server walks and discards every skipped
 *    document, so page 200 of a collection costs 200 pages of work. When the
 *    caller gives no sort we sort by `_id` (free — it is always indexed), which
 *    makes paging *stable* and lets us remember each page's last `_id` and turn
 *    the next page into a range scan `{_id: {$gt: last}}` with no skip at all.
 *
 *  • **`mongodb+srv://` (§8.2).** A URI address is handed to `MongoClient`
 *    untouched so the driver performs the DNS SRV + TXT lookups Atlas needs.
 *
 *  • **Cancellation (§6).** `killOp`, driven from the session monitor.
 *
 * Per PLAN §8.1 this file never learns how the server was reached: it dials
 * `ctx.resolved.address`, which the AccessResolver has already made dialable.
 *
 * Server-only module: no React, no Next imports (PLAN §11).
 */

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { MongoClient } from 'mongodb';
import type {
  Collection,
  CountDocumentsOptions,
  Db,
  Document,
  Filter,
  FindOptions,
  IndexDirection,
  IndexSpecification,
  MongoClientOptions,
  OptionalUnlessRequiredId,
  ServerHeartbeatFailedEvent,
  Sort,
} from 'mongodb';

import type { Address, TlsConfig } from '../../../../lib/connection';
import type { EngineKind } from '../../../../lib/schema-model';
import type {
  ExplainNode,
  ExplainPlan,
  FindOpts,
  IndexInfo,
  Namespace,
  ProcessInfo,
  ResultSet,
  ServerInfo,
  TreeNode,
  TreePath,
} from '../../../../lib/results';
import { CONFIG, loopbackAdvice } from '../../../config';
import {
  DbError,
  type Capability,
  type ConnectorContext,
  type ConnectorEvent,
  type DocumentConnector,
} from '../../types';
import {
  documentFromRow,
  ejsonText,
  flattenDocuments,
  numberOf,
  toBsonDocument,
  toBsonPipeline,
  toBsonValue,
} from './ejson';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * BSON options for *data* reads. Without these the driver silently promotes
 * Long → number (losing precision past 2^53), Double → number (losing the
 * type), Binary → Buffer and BSONRegExp → RegExp (losing flags JS has no
 * spelling for). PLAN §6.
 */
const DOC_BSON_OPTIONS = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
} as const;

/** Hard ceiling on one page, whatever the caller asks for (PLAN §6 "Big results"). */
const MAX_PAGE_SIZE = 10_000;

/** Collections we will fan out `estimatedDocumentCount` across; beyond this the tree stays count-less (§8.3). */
const COUNT_FANOUT_LIMIT = 50;

/** Filters whose page boundaries we remember, for the `_id` range cursor. */
const POSITION_CACHE_MAX = 64;

/** Stages that write. They are refused on a read-only connection (§8.5). */
const WRITE_STAGES = new Set(['$out', '$merge']);

/** Index key types Mongo accepts as a string direction. */
const INDEX_KEY_TYPES = new Set(['2d', '2dsphere', '2dsphereVersion', 'text', 'hashed', 'geoHaystack']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface MongoErrorish {
  message?: string;
  code?: number | string;
  codeName?: string;
  errmsg?: string;
  name?: string;
}

function toDbError(err: unknown, context?: string): DbError {
  if (err instanceof DbError) return err;
  const e = (err ?? {}) as MongoErrorish;
  const message = e.errmsg ?? e.message ?? String(err);
  const code = e.codeName ?? (e.code !== undefined ? String(e.code) : undefined);
  return new DbError(message, code, context);
}

/** §8.2: TLS material is either inline PEM or a path inside the container. */
function pem(value: string): string {
  return value.includes('-----BEGIN') ? value : readFileSync(value, 'utf8');
}

/** IPv6 literals have to be bracketed inside a connection string. */
function formatHost(host: string): string {
  if (host.startsWith('[')) return host;
  return isIP(host) === 6 ? `[${host}]` : host;
}

function clampPage(n: number | undefined, fallback: number): number {
  const value = n === undefined || !Number.isFinite(n) ? fallback : Math.trunc(n);
  return Math.min(Math.max(value, 1), MAX_PAGE_SIZE);
}

function truncateText(text: string, max = 4000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function nonEmpty<T extends object>(value: T | undefined): T | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

function parseSegment(segment: string): { kind: string; name: string } {
  const idx = segment.indexOf(':');
  return idx === -1 ? { kind: segment, name: '' } : { kind: segment.slice(0, idx), name: segment.slice(idx + 1) };
}

function pipelineWrites(stages: Document[]): boolean {
  return stages.some((stage) => Object.keys(stage).some((key) => WRITE_STAGES.has(key)));
}

/** `$out`/`$merge` must stay last, so the limit guard is not appended after them. */
function endsWithWriteStage(stages: Document[]): boolean {
  const last = stages[stages.length - 1];
  return !!last && Object.keys(last).some((key) => WRITE_STAGES.has(key));
}

// ---------------------------------------------------------------------------
// Explain mapping (PLAN §6 power tools → ExplainPlan)
// ---------------------------------------------------------------------------

/** Sub-plans hang off these keys, one child each. */
const EXPLAIN_CHILD_KEYS = ['inputStage', 'queryPlan', 'thenStage', 'elseStage', 'innerStage', 'outerStage'];
/** …and these, one child per array entry. */
const EXPLAIN_CHILD_ARRAY_KEYS = ['inputStages', 'shards', 'stages'];

/** Facts worth showing on the node line. */
const EXPLAIN_DETAIL_KEYS = [
  'indexName',
  'keyPattern',
  'direction',
  'filter',
  'sortPattern',
  'limitAmount',
  'skipAmount',
  'transformBy',
  'shardName',
  'indexBounds',
];

/**
 * Keys the mapper consumes itself (they become ExplainNode fields, children, or
 * are pure bookkeeping noise). Everything else — `docsExamined`,
 * `keysExamined`, `works`, `advanced`, `seeks`, `spills` … — falls through to
 * `ExplainNode.extra`, which is exactly what that field is for.
 */
const EXPLAIN_CONSUMED_KEYS = new Set([
  'nReturned',
  'executionTimeMillisEstimate',
  'executionTimeMillis',
  'needYield',
  'saveState',
  'restoreState',
  'isEOF',
  'stage',
  'executionStages',
  'allPlansExecution',
  'rejectedPlans',
  'inputStage',
  'inputStages',
  'queryPlan',
  // A megabyte of SBE bytecode that helps nobody in a tree view.
  'slotBasedPlan',
  'shards',
  'stages',
  'thenStage',
  'elseStage',
  'innerStage',
  'outerStage',
]);

function explainNodeFrom(raw: unknown, fallbackLabel: string): ExplainNode {
  if (raw === null || typeof raw !== 'object') {
    return { label: fallbackLabel, detail: raw === undefined ? undefined : String(raw), children: [] };
  }
  const doc = raw as Document;
  const stage = typeof doc.stage === 'string' ? doc.stage : undefined;
  const shard = typeof doc.shardName === 'string' ? doc.shardName : undefined;
  const node: ExplainNode = {
    label: stage ?? shard ?? fallbackLabel,
    children: [],
  };

  const details: string[] = [];
  const extra: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(doc)) {
    if (value === null || value === undefined) continue;
    if (EXPLAIN_DETAIL_KEYS.includes(key)) {
      details.push(`${key}=${typeof value === 'object' ? ejsonText(value, { relaxed: true }) : String(value)}`);
      continue;
    }
    if (EXPLAIN_CONSUMED_KEYS.has(key)) continue;
    extra[key] = typeof value === 'object' ? ejsonText(value, { relaxed: true }) : value;
  }

  const nReturned = numberOf(doc.nReturned);
  if (nReturned !== undefined) node.actualRows = nReturned;
  const time = numberOf(doc.executionTimeMillisEstimate) ?? numberOf(doc.executionTimeMillis);
  if (time !== undefined) node.actualTimeMs = time;

  for (const key of EXPLAIN_CHILD_KEYS) {
    const child = doc[key];
    if (child && typeof child === 'object') node.children.push(explainNodeFrom(child, key));
  }
  for (const key of EXPLAIN_CHILD_ARRAY_KEYS) {
    const list = doc[key];
    if (!Array.isArray(list)) continue;
    list.forEach((child, i) => node.children.push(explainNodeFrom(child, `${key} #${i + 1}`)));
  }
  // A shard entry nests its own executionStages under the shard document.
  if (doc.executionStages && typeof doc.executionStages === 'object') {
    node.children.push(explainNodeFrom(doc.executionStages, 'executionStages'));
  }

  if (details.length > 0) node.detail = truncateText(details.join(', '), 400);
  if (Object.keys(extra).length > 0) node.extra = extra;
  return node;
}

/**
 * Mongo reports `executionTimeMillisEstimate` *cumulatively* for a subtree, so
 * the flame bar has to use self time — otherwise every parent looks like 100%.
 */
function applyExplainShares(node: ExplainNode, total: number): number {
  let childCumulative = 0;
  for (const child of node.children) childCumulative += applyExplainShares(child, total);
  const cumulative = node.actualTimeMs ?? childCumulative;
  if (total > 0 && node.actualTimeMs !== undefined) {
    node.share = Math.max(0, Math.min(1, (cumulative - childCumulative) / total));
  }
  return cumulative;
}

export function mapMongoExplain(raw: Document): ExplainPlan {
  const planner = (raw.queryPlanner ?? {}) as Document;
  const stats = raw.executionStats as Document | undefined;
  const analyzed = !!stats;

  const rootSource = stats?.executionStages ?? planner.winningPlan ?? raw;
  const root = explainNodeFrom(rootSource, 'plan');

  if (typeof planner.namespace === 'string') {
    root.label = `${root.label} (${planner.namespace})`;
  }

  const totalTimeMs = numberOf(stats?.executionTimeMillis);
  if (analyzed) applyExplainShares(root, totalTimeMs ?? 0);

  // Rejected plans are the most useful thing in an explain and are easy to
  // lose, so they hang off the root as a sibling subtree.
  const rejected = planner.rejectedPlans;
  if (Array.isArray(rejected) && rejected.length > 0) {
    root.children.push({
      label: `rejected plans (${rejected.length})`,
      children: rejected.map((plan, i) => explainNodeFrom(plan, `rejected #${i + 1}`)),
    });
  }

  const totalKeys = numberOf(stats?.totalKeysExamined);
  const totalDocs = numberOf(stats?.totalDocsExamined);
  if (totalKeys !== undefined || totalDocs !== undefined) {
    root.extra = {
      ...(root.extra ?? {}),
      totalKeysExamined: totalKeys,
      totalDocsExamined: totalDocs,
    };
  }

  return {
    engine: 'mongodb',
    analyzed,
    root,
    totalTimeMs,
    raw: ejsonText(raw, { relaxed: true, indent: 2 }),
  };
}

// ---------------------------------------------------------------------------
// currentOp mapping
// ---------------------------------------------------------------------------

export function mapCurrentOp(op: Document): ProcessInfo | null {
  const opid = op.opid;
  if (opid === null || opid === undefined) return null;

  const micros = numberOf(op.microsecs_running);
  const secs = numberOf(op.secs_running);
  const durationMs = micros !== undefined ? micros / 1000 : secs !== undefined ? secs * 1000 : undefined;

  const users = op.effectiveUsers;
  const user =
    Array.isArray(users) && users.length > 0 && typeof users[0]?.user === 'string' ? String(users[0].user) : undefined;

  const command = op.command ?? op.originatingCommand;
  const ns = typeof op.ns === 'string' ? op.ns : undefined;

  const info: ProcessInfo = {
    // A mongos reports `shard:opid`, which is also what killOp wants back.
    id: typeof opid === 'string' ? opid : String(numberOf(opid) ?? opid),
    user,
    client: typeof op.client === 'string' ? op.client : typeof op.client_s === 'string' ? op.client_s : undefined,
    database: ns ? ns.split('.')[0] : undefined,
    state: op.waitingForLock === true ? 'waiting' : op.active === true ? 'active' : 'idle',
    command: typeof op.op === 'string' ? op.op : undefined,
    durationMs,
    query: command && typeof command === 'object' ? truncateText(ejsonText(command, { relaxed: true }), 2000) : ns,
  };

  if (op.waitingForLock === true) info.waitEvent = 'lock';
  else if (op.waitingForLatch && typeof op.waitingForLatch === 'object') {
    const capture = (op.waitingForLatch as Document).captureName;
    if (typeof capture === 'string') info.waitEvent = capture;
  }
  return info;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

interface PagePositions {
  /** absolute offset → the `_id` of the document just before it. */
  boundaries: Map<number, unknown>;
  touchedAt: number;
}

class MongoConnector implements DocumentConnector {
  readonly kind: EngineKind = 'mongodb';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'documents',
    'aggregation',
    'multipleDatabases',
    'explain',
    'processList',
    'cancel',
  ]);

  private readonly ctx: ConnectorContext;
  private readonly uri: string;
  private readonly options: MongoClientOptions;
  private readonly maxTimeMS: number | undefined;
  /** ConnectionOptions.database — the database used when a caller names none. */
  private readonly defaultDatabase: string | undefined;
  /** Remembered `_id` page boundaries, keyed by namespace+filter (see the header). */
  private readonly positions = new Map<string, PagePositions>();

  private client: MongoClient | null = null;
  private released = false;
  private unhealthy = false;

  constructor(ctx: ConnectorContext) {
    this.ctx = ctx;
    const { config } = ctx;

    this.uri = buildUri(ctx.resolved.address);
    this.defaultDatabase = config.options.database || undefined;

    const options: MongoClientOptions = {
      // Shows up in currentOp and the server log, which is how you find your
      // own runaway query in the session monitor.
      appName: `dbadmin:${config.name}`.slice(0, 120),
      connectTimeoutMS: config.options.connectTimeoutMs ?? 10_000,
      serverSelectionTimeoutMS: config.options.connectTimeoutMs ?? 10_000,
      // §8.3: NAT and firewalls silently drop idle TCP and tunnels are the
      // worst offenders — keep the pool below the usual 5-minute window and
      // keep the sockets warm.
      maxIdleTimeMS: CONFIG.poolIdleMs,
      keepAliveInitialDelay: 30_000,
      maxPoolSize: config.options.poolSize ?? 10,
      minPoolSize: 0,
      retryReads: true,
    };

    if (config.options.statementTimeoutMs && config.options.statementTimeoutMs > 0) {
      // Applied per operation as maxTimeMS: §8.3 "every remote operation needs
      // a timeout". socketTimeoutMS would kill the socket, not the query.
      this.maxTimeMS = config.options.statementTimeoutMs;
      options.socketTimeoutMS = config.options.statementTimeoutMs + 30_000;
    } else {
      this.maxTimeMS = undefined;
    }

    if (config.username) {
      // Credentials go in the options rather than the URI so that passwords
      // containing `@`, `:` or `/` do not have to be escaped by hand.
      options.auth = { username: config.username, password: ctx.password ?? '' };
    }
    if (config.options.authSource) options.authSource = config.options.authSource;
    if (config.options.replicaSet) options.replicaSet = config.options.replicaSet;

    // §8.3: compression is worth it on remote links only.
    if (config.options.compress) options.compressors = ['zlib'];

    applyTls(options, config.tls);

    // §8.1/§8.2: through a tunnel the seed host is a local forwarded port, but
    // SDAM would replace it with the replica set's *internal* hostnames from
    // the hello response — which are not reachable from here. Pin to the one
    // host we were given unless the user explicitly named a replica set.
    if (ctx.resolved.tunneled && !options.replicaSet && !this.uri.startsWith('mongodb+srv://')) {
      options.directConnection = true;
    }

    // ConnectionOptions promises driverOptions are passed through untouched.
    Object.assign(options, config.options.driverOptions ?? {});

    this.options = options;
  }

  // -- lifecycle ------------------------------------------------------------

  async open(): Promise<void> {
    this.emit({ type: 'state', state: 'connecting' });
    try {
      const client = new MongoClient(this.uri, this.options);
      this.wire(client);
      await client.connect();
      this.client = client;
      this.unhealthy = false;
      this.emit({ type: 'state', state: 'connected' });
    } catch (err) {
      await this.close().catch(() => undefined);
      throw this.connectError(err);
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      const client = this.client;
      this.client = null;
      await client.close().catch(() => undefined);
    }
    this.positions.clear();
    // §8.1: the resolver refcounts the tunnel; this connector held one
    // reference for its whole lifetime and gives it back exactly once.
    if (!this.released) {
      this.released = true;
      await this.ctx.resolved.release().catch(() => undefined);
    }
    this.emit({ type: 'state', state: 'closed' });
  }

  async ping(): Promise<ServerInfo> {
    const admin = this.requireClient().db('admin').admin();
    const started = performance.now();
    await admin.ping();
    // §8.3: RTT drives adaptive page sizes and cache TTLs upstream.
    const rttMs = performance.now() - started;

    const build = await admin.buildInfo().catch(() => ({}) as Document);
    let status: Document | null = null;
    try {
      status = await admin.serverStatus();
    } catch {
      // serverStatus needs the clusterMonitor role, which shared Atlas tiers
      // do not grant. Uptime is optional; the version is not.
    }

    const version = typeof build.version === 'string' ? build.version : 'unknown';
    const versionArray = Array.isArray(build.versionArray) ? build.versionArray.map((n) => numberOf(n) ?? 0) : [];
    const versionNumber =
      versionArray.length >= 3
        ? versionArray[0] * 10000 + versionArray[1] * 100 + versionArray[2]
        : undefined;

    const modules = Array.isArray(build.modules) ? build.modules.map(String) : [];
    const details: Record<string, string> = { tunneled: String(this.ctx.resolved.tunneled) };
    const put = (key: string, value: unknown): void => {
      if (value !== undefined && value !== null && value !== '') details[key] = String(value);
    };
    put('host', status?.host);
    put('process', status?.process);
    put('storageEngine', (status?.storageEngine as Document | undefined)?.name);
    put('replicaSet', (status?.repl as Document | undefined)?.setName);
    put('connections', numberOf((status?.connections as Document | undefined)?.current));
    put('maxBsonObjectSize', numberOf(build.maxBsonObjectSize));
    put('srv', String(this.uri.startsWith('mongodb+srv://')));

    return {
      version,
      versionNumber,
      edition: modules.includes('enterprise') ? 'enterprise' : modules.length > 0 ? modules.join(',') : 'community',
      uptimeSeconds: numberOf(status?.uptime),
      rttMs,
      details,
    };
  }

  // -- tree: database → collection → indexes (PLAN §6) ----------------------

  async listNodes(path: TreePath): Promise<TreeNode[]> {
    const segments = (path.segments ?? []).map(parseSegment);
    const prefix = (path.segments ?? []).length > 0 ? `${path.segments.join('/')}/` : '';
    const database = segments.find((s) => s.kind === 'db' || s.kind === 'database')?.name;
    const collection = segments.find((s) => s.kind === 'collection')?.name;
    const folder = segments.filter((s) => s.kind.endsWith('-folder')).pop();

    if (!database) {
      const dbs = await this.listDatabases();
      return dbs.map((db) => ({
        id: `db:${db.name}`,
        kind: 'database' as const,
        label: db.name,
        detail: db.sizeBytes !== undefined ? formatBytes(db.sizeBytes) : undefined,
        hasChildren: true,
        meta: { database: db.name, sizeBytes: db.sizeBytes },
      }));
    }

    if (!collection) {
      const collections = await this.listCollections(database);
      return collections.map((c) => ({
        id: `${prefix}collection:${c.name}`,
        kind: 'collection' as const,
        label: c.name,
        detail: c.type !== 'collection' ? c.type : c.count !== undefined ? `${c.count} docs` : undefined,
        hasChildren: true,
        meta: { database, collection: c.name, type: c.type, count: c.count },
      }));
    }

    if (!folder) {
      return [
        {
          id: `${prefix}index-folder:indexes`,
          kind: 'index-folder',
          label: 'Indexes',
          hasChildren: true,
          meta: { database, collection },
        },
      ];
    }

    if (folder.kind === 'index-folder') {
      const indexes = await this.indexes({ database, collection });
      return indexes.map((ix) => ({
        id: `${prefix}mongo-index:${ix.name}`,
        kind: 'mongo-index' as const,
        label: ix.name,
        detail: [
          Object.entries(ix.keys)
            .map(([k, v]) => `${k}:${v}`)
            .join(', '),
          ix.unique ? 'unique' : null,
          ix.ttlSeconds !== undefined ? `ttl ${ix.ttlSeconds}s` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        hasChildren: false,
        meta: { database, collection, index: ix.name, keys: ix.keys, unique: ix.unique, sizeBytes: ix.sizeBytes },
      }));
    }

    return [];
  }

  // -- catalog --------------------------------------------------------------

  async listDatabases(): Promise<{ name: string; sizeBytes?: number }[]> {
    try {
      const result = await this.requireClient().db('admin').admin().listDatabases();
      return result.databases.map((db) => ({ name: db.name, sizeBytes: numberOf(db.sizeOnDisk) }));
    } catch (err) {
      throw toDbError(err, 'listDatabases');
    }
  }

  async listCollections(database: string): Promise<{ name: string; type: string; count?: number }[]> {
    const db = this.db(database);
    let infos: Document[];
    try {
      infos = await db.listCollections({}, { nameOnly: false }).toArray();
    } catch (err) {
      throw toDbError(err, `listCollections(${database})`);
    }

    const collections = infos
      .map((info) => ({ name: String(info.name), type: typeof info.type === 'string' ? info.type : 'collection' }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // §8.3: one estimatedDocumentCount per collection is N round trips, so it
    // is issued concurrently and only for a tree-sized list. estimated ⇒ it
    // reads collection metadata rather than counting, so it stays O(1) server
    // side. Views have no metadata count and are skipped.
    const countable = collections.filter((c) => c.type === 'collection');
    if (countable.length === 0 || countable.length > COUNT_FANOUT_LIMIT) return collections;

    const counts = await Promise.all(
      countable.map(async (c) => {
        try {
          return await db.collection(c.name).estimatedDocumentCount({ maxTimeMS: this.maxTimeMS });
        } catch {
          return undefined;
        }
      }),
    );
    const byName = new Map<string, number | undefined>(
      countable.map((c, i): [string, number | undefined] => [c.name, counts[i]]),
    );
    return collections.map((c) => ({ ...c, count: byName.get(c.name) }));
  }

  // -- reads ----------------------------------------------------------------

  async find(ns: Namespace, filter: unknown, opts: FindOpts): Promise<ResultSet> {
    const started = performance.now();
    const query = toBsonDocument(filter, 'filter');
    const limit = clampPage(opts.limit, CONFIG.defaultPageSize);
    const skip = Math.max(0, Math.trunc(opts.skip ?? 0));
    const sort = nonEmpty(opts.sort);
    const projection = nonEmpty(opts.projection);

    const findOptions: FindOptions = {
      ...DOC_BSON_OPTIONS,
      // One extra document tells us whether more remain without a second query.
      limit: limit + 1,
      maxTimeMS: this.maxTimeMS,
    };
    if (projection) findOptions.projection = projection as Document;

    let effective: Document = query;
    const notices: string[] = [];

    if (sort) {
      findOptions.sort = sort as Sort;
      if (skip > 0) findOptions.skip = skip;
    } else {
      // No sort: impose `_id` order. It is free (the `_id` index always
      // exists), it makes paging stable instead of relying on unspecified
      // natural order, and it is what makes the range cursor below correct.
      findOptions.sort = { _id: 1 };
      const boundary = skip > 0 ? this.pageBoundary(ns, query, skip) : undefined;
      if (boundary !== undefined) {
        const range: Document = { _id: { $gt: boundary } };
        effective = Object.keys(query).length > 0 ? { $and: [query, range] } : range;
        notices.push(`Paged with an _id range cursor instead of skip(${skip}).`);
      } else if (skip > 0) {
        // PLAN §8.3: the server walks and discards every skipped document.
        findOptions.skip = skip;
        notices.push(`skip(${skip}) scans and discards ${skip} documents server-side; page forward to avoid it.`);
      }
    }

    let docs: Document[];
    try {
      docs = await this.collection(ns).find(effective as Filter<Document>, findOptions).toArray();
    } catch (err) {
      throw toDbError(err, `find on ${ns.database}.${ns.collection}`);
    }

    const truncated = docs.length > limit;
    if (truncated) docs.length = limit;

    if (!sort && docs.length > 0) {
      this.rememberBoundary(ns, query, skip + docs.length, docs[docs.length - 1]._id);
    }

    const page = flattenDocuments(docs, { database: ns.database, collection: ns.collection });
    // Mongo always returns `_id` unless the projection explicitly drops it, so
    // editability is decided from the request rather than from what this
    // particular page happened to contain (an empty page has no columns).
    const keepsId = !projection || projection._id !== 0;

    return {
      statement: renderFind(ns, query, { sort, projection, limit, skip }),
      columns: page.columns,
      rows: page.rows,
      truncated,
      durationMs: performance.now() - started,
      notices: notices.length > 0 ? notices : undefined,
      // PLAN §6 "Grid editing": `_id` is always unique, so the grid is editable
      // as long as the projection kept it.
      editTarget: keepsId ? { schema: ns.database, table: ns.collection, keyColumns: ['_id'] } : null,
      readOnlyReason: keepsId ? undefined : 'The projection excludes _id, so rows cannot be identified for editing.',
    };
  }

  async count(ns: Namespace, filter: unknown): Promise<number> {
    const query = toBsonDocument(filter, 'filter');
    const col = this.collection(ns);
    const options: CountDocumentsOptions = { maxTimeMS: this.maxTimeMS };
    try {
      // An unfiltered count reads collection metadata (O(1)); a filtered one
      // has to run an aggregation over the matching documents.
      if (Object.keys(query).length === 0) return await col.estimatedDocumentCount({ maxTimeMS: this.maxTimeMS });
      return await col.countDocuments(query as Filter<Document>, options);
    } catch (err) {
      throw toDbError(err, `count on ${ns.database}.${ns.collection}`);
    }
  }

  async aggregate(ns: Namespace, pipeline: unknown[], opts?: { limit?: number }): Promise<ResultSet> {
    const started = performance.now();
    const stages = toBsonPipeline(pipeline);
    if (pipelineWrites(stages)) this.assertWritable('an aggregation with $out/$merge');

    const limit = clampPage(opts?.limit, CONFIG.defaultPageSize);
    // Limit guard (PLAN §6 "Big results"): an unbounded pipeline can stream a
    // whole collection into memory. $out/$merge must stay last, so a writing
    // pipeline is run as written.
    const writes = endsWithWriteStage(stages);
    const guarded = writes ? stages : [...stages, { $limit: limit + 1 }];

    let docs: Document[];
    try {
      docs = await this.collection(ns)
        .aggregate(guarded, { ...DOC_BSON_OPTIONS, maxTimeMS: this.maxTimeMS })
        .toArray();
    } catch (err) {
      throw toDbError(err, `aggregate on ${ns.database}.${ns.collection}`);
    }

    const truncated = !writes && docs.length > limit;
    if (truncated) docs.length = limit;

    const page = flattenDocuments(docs, { database: ns.database, collection: ns.collection });
    return {
      statement: truncateText(`${ns.database}.${ns.collection}.aggregate(${ejsonText(stages, { relaxed: true })})`),
      columns: page.columns,
      rows: page.rows,
      truncated,
      durationMs: performance.now() - started,
      notices: truncated ? [`Stopped at ${limit} documents; add a $limit stage to control this.`] : undefined,
      // The output of a pipeline is computed, not a stored document.
      editTarget: null,
      readOnlyReason: 'Aggregation output is computed and cannot be edited in place.',
    };
  }

  // -- writes (PLAN §8.5: read-only connections are enforced server-side) ---

  async insert(ns: Namespace, docs: unknown[]): Promise<{ inserted: number }> {
    this.assertWritable('insert');
    if (!Array.isArray(docs) || docs.length === 0) return { inserted: 0 };
    const documents = docs.map((d, i) => toBsonDocument(d, `document #${i + 1}`));
    try {
      // PLAN §7.4: Mongo imports go in as unordered batches, so one bad
      // document does not abort the rest.
      const result = await this.collection(ns).insertMany(
        documents as OptionalUnlessRequiredId<Document>[],
        { ordered: false },
      );
      return { inserted: result.insertedCount };
    } catch (err) {
      throw toDbError(err, `insert into ${ns.database}.${ns.collection}`);
    }
  }

  async replace(ns: Namespace, id: unknown, doc: unknown): Promise<{ modified: number }> {
    this.assertWritable('replace');
    const key = toBsonValue(id);
    if (key === undefined || key === null) throw new DbError('replace needs the _id of the document.', 'BAD_ARG');
    const replacement = toBsonDocument(doc, 'replacement document');

    // Mongo rejects a replacement that changes `_id`. Dropping a matching `_id`
    // makes "read the document, edit it, save it" work unchanged.
    if (Object.prototype.hasOwnProperty.call(replacement, '_id')) {
      if (ejsonText(replacement._id) !== ejsonText(key)) {
        throw new DbError('A document’s _id is immutable; delete and re-insert to change it.', 'IMMUTABLE_ID');
      }
      delete replacement._id;
    }

    try {
      const result = await this.collection(ns).replaceOne({ _id: key } as Filter<Document>, replacement);
      if (result.matchedCount === 0) {
        // The affected-rows sanity check of PLAN §6 "Grid editing": a save that
        // matched nothing means the document moved underneath the grid.
        throw new DbError('No document matched that _id; it may have been deleted already.', 'NOT_FOUND');
      }
      return { modified: result.modifiedCount };
    } catch (err) {
      throw toDbError(err, `replace in ${ns.database}.${ns.collection}`);
    }
  }

  async deleteDocs(ns: Namespace, ids: unknown[]): Promise<{ deleted: number }> {
    this.assertWritable('delete');
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
    // `_id: null` is a legal document id, so only genuinely absent ids drop out.
    const keys = ids.map(toBsonValue).filter((k) => k !== undefined);
    if (keys.length === 0) return { deleted: 0 };
    try {
      const result = await this.collection(ns).deleteMany({ _id: { $in: keys } } as unknown as Filter<Document>);
      return { deleted: result.deletedCount };
    } catch (err) {
      throw toDbError(err, `delete from ${ns.database}.${ns.collection}`);
    }
  }

  // -- indexes --------------------------------------------------------------

  async indexes(ns: Namespace): Promise<IndexInfo[]> {
    let raw: Document[];
    try {
      raw = await this.collection(ns).indexes();
    } catch (err) {
      throw toDbError(err, `indexes of ${ns.database}.${ns.collection}`);
    }
    const sizes = await this.indexSizes(ns);

    return raw.map((ix) => {
      const name = String(ix.name ?? '');
      const keys: Record<string, 1 | -1 | string> = {};
      for (const [field, direction] of Object.entries((ix.key ?? {}) as Document)) {
        const n = numberOf(direction);
        keys[field] = n === 1 ? 1 : n === -1 ? -1 : String(direction);
      }
      const info: IndexInfo = { name, keys };
      if (ix.unique === true) info.unique = true;
      if (ix.sparse === true) info.sparse = true;
      const ttl = numberOf(ix.expireAfterSeconds);
      if (ttl !== undefined) info.ttlSeconds = ttl;
      const size = sizes[name];
      if (size !== undefined) info.sizeBytes = size;
      return info;
    });
  }

  async createIndex(ns: Namespace, spec: IndexInfo): Promise<void> {
    this.assertWritable('createIndex');
    const entries = Object.entries(spec.keys ?? {});
    if (entries.length === 0) throw new DbError('An index needs at least one key.', 'BAD_ARG');

    const keys: Record<string, IndexDirection> = {};
    for (const [field, direction] of entries) {
      if (direction === 1 || direction === -1) {
        keys[field] = direction;
        continue;
      }
      const text = String(direction);
      if (text === '1' || text === '-1') {
        keys[field] = text === '1' ? 1 : -1;
        continue;
      }
      if (!INDEX_KEY_TYPES.has(text)) {
        throw new DbError(
          `Unsupported index key type "${text}" on ${field}. Use 1, -1, or one of: ${[...INDEX_KEY_TYPES].join(', ')}.`,
          'BAD_INDEX_TYPE',
        );
      }
      keys[field] = text as IndexDirection;
    }

    try {
      await this.collection(ns).createIndex(keys as IndexSpecification, {
        name: spec.name || undefined,
        unique: spec.unique,
        sparse: spec.sparse,
        expireAfterSeconds: spec.ttlSeconds,
      });
    } catch (err) {
      throw toDbError(err, `createIndex on ${ns.database}.${ns.collection}`);
    }
  }

  async dropIndex(ns: Namespace, name: string): Promise<void> {
    this.assertWritable('dropIndex');
    if (name === '_id_') throw new DbError('The _id index cannot be dropped.', 'IMMUTABLE_INDEX');
    try {
      await this.collection(ns).dropIndex(name);
    } catch (err) {
      throw toDbError(err, `dropIndex on ${ns.database}.${ns.collection}`);
    }
  }

  // -- explain --------------------------------------------------------------

  async explainFind(ns: Namespace, filter: unknown, opts: FindOpts): Promise<ExplainPlan> {
    const query = toBsonDocument(filter, 'filter');
    // Default BSON promotion here on purpose: explain output is all counters,
    // and mapMongoExplain reads them through numberOf() either way.
    const findOptions: FindOptions = { maxTimeMS: this.maxTimeMS };
    const projection = nonEmpty(opts.projection);
    const sort = nonEmpty(opts.sort);
    if (projection) findOptions.projection = projection as Document;
    // Mirror what find() actually sends, including the implicit `_id` sort —
    // otherwise the plan shown is not the plan the grid ran.
    findOptions.sort = sort ? (sort as Sort) : { _id: 1 };
    if (opts.limit) findOptions.limit = clampPage(opts.limit, CONFIG.defaultPageSize);
    if (opts.skip) findOptions.skip = Math.max(0, Math.trunc(opts.skip));

    try {
      const raw = await this.collection(ns)
        .find(query as Filter<Document>, findOptions)
        .explain('executionStats');
      return mapMongoExplain(raw);
    } catch (err) {
      throw toDbError(err, `explain on ${ns.database}.${ns.collection}`);
    }
  }

  // -- session monitor (PLAN §6 "Query cancellation": Mongo cancels with killOp)

  async listProcesses(): Promise<ProcessInfo[]> {
    const admin = this.requireClient().db('admin');
    let ops: unknown[] = [];
    try {
      // $currentOp is the supported form; the currentOp *command* is
      // deprecated but is all an older or restricted server will answer.
      const docs = await admin
        .aggregate([{ $currentOp: { allUsers: true, idleConnections: false } }])
        .toArray();
      ops = docs;
    } catch {
      try {
        const legacy = await admin.admin().command({ currentOp: 1 });
        ops = Array.isArray(legacy.inprog) ? legacy.inprog : [];
      } catch (err) {
        throw toDbError(err, 'currentOp');
      }
    }

    const out: ProcessInfo[] = [];
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      const info = mapCurrentOp(op as Document);
      if (info) out.push(info);
    }
    return out.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  }

  async killProcess(id: string): Promise<void> {
    this.assertWritable('killProcess');
    // A mongos opid is `shardName:number`; a mongod opid is a plain number.
    const op: string | number = /^-?\d+$/.test(id) ? Number(id) : id;
    try {
      await this.requireClient().db('admin').admin().command({ killOp: 1, op });
    } catch (err) {
      throw toDbError(err, `killOp ${id}`);
    }
  }

  // -- internals ------------------------------------------------------------

  private emit(event: ConnectorEvent): void {
    this.ctx.onEvent?.(event);
  }

  private assertWritable(operation: string): void {
    // §8.5: belt and braces. The recommended setup is also a read-only Mongo
    // user, but a client-side gate cannot be forgotten.
    if (this.ctx.config.readOnly) {
      throw new DbError(
        `This connection is read-only (${this.ctx.config.envTag}); ${operation} is blocked.`,
        'READONLY_CONNECTION',
      );
    }
  }

  private requireClient(): MongoClient {
    if (!this.client) throw new DbError('MongoDB connection is not open.', 'NOT_CONNECTED');
    return this.client;
  }

  private db(name?: string): Db {
    const target = name || this.defaultDatabase;
    if (!target) throw new DbError('A database name is required.', 'BAD_ARG');
    return this.requireClient().db(target);
  }

  private collection(ns: Namespace): Collection<Document> {
    if (!ns?.collection) throw new DbError('A collection name is required.', 'BAD_ARG');
    return this.db(ns.database).collection<Document>(ns.collection);
  }

  /** Per-index storage sizes; best effort, since collStats needs privileges. */
  private async indexSizes(ns: Namespace): Promise<Record<string, number>> {
    const read = (stats: unknown): Record<string, number> => {
      const sizes = (stats as Document | undefined)?.indexSizes as Document | undefined;
      if (!sizes) return {};
      const out: Record<string, number> = {};
      for (const [name, value] of Object.entries(sizes)) {
        const n = numberOf(value);
        if (n !== undefined) out[name] = n;
      }
      return out;
    };

    try {
      const [doc] = await this.collection(ns)
        .aggregate([{ $collStats: { storageStats: {} } }])
        .toArray();
      return read(doc?.storageStats);
    } catch {
      try {
        // Pre-6.2 servers only have the collStats command.
        return read(await this.db(ns.database).command({ collStats: ns.collection }));
      } catch {
        return {};
      }
    }
  }

  // -- `_id` range cursor (PLAN §8.3: skip is O(n)) -------------------------

  private positionKey(ns: Namespace, filter: Document): string {
    return `${ns.database}.${ns.collection}|${ejsonText(filter)}`;
  }

  private pageBoundary(ns: Namespace, filter: Document, offset: number): unknown {
    const entry = this.positions.get(this.positionKey(ns, filter));
    if (!entry) return undefined;
    entry.touchedAt = Date.now();
    return entry.boundaries.get(offset);
  }

  /** Record the `_id` that ends the page at `offset`, so the next page is a range scan. */
  private rememberBoundary(ns: Namespace, filter: Document, offset: number, id: unknown): void {
    if (id === undefined) return;
    const key = this.positionKey(ns, filter);
    let entry = this.positions.get(key);
    if (!entry) {
      if (this.positions.size >= POSITION_CACHE_MAX) {
        let oldestKey: string | null = null;
        let oldest = Infinity;
        for (const [k, v] of this.positions) {
          if (v.touchedAt < oldest) {
            oldest = v.touchedAt;
            oldestKey = k;
          }
        }
        if (oldestKey) this.positions.delete(oldestKey);
      }
      entry = { boundaries: new Map(), touchedAt: Date.now() };
      this.positions.set(key, entry);
    }
    entry.touchedAt = Date.now();
    entry.boundaries.set(offset, id);
  }

  /** §8.3: a visible connection-state indicator is what makes a dropped tunnel diagnosable. */
  private wire(client: MongoClient): void {
    client.on('serverHeartbeatFailed', (event: ServerHeartbeatFailedEvent) => {
      if (!this.unhealthy) {
        this.unhealthy = true;
        this.emit({ type: 'state', state: 'reconnecting', message: event.failure?.message });
      }
    });
    client.on('serverHeartbeatSucceeded', () => {
      if (this.unhealthy) {
        this.unhealthy = false;
        this.emit({ type: 'state', state: 'connected' });
      }
    });
    client.on('topologyClosed', () => this.emit({ type: 'state', state: 'closed' }));
    // The driver emits 'error' on the client for unrecoverable problems; an
    // unhandled one on an EventEmitter would take the process down.
    client.on('error', (err: Error) => this.emit({ type: 'error', message: err.message }));
  }

  /** §10.3: a container's `localhost` is the container, and that failure looks like nothing else. */
  private connectError(err: unknown): DbError {
    const error = toDbError(err);
    const address = this.ctx.resolved.address;
    const host =
      address.kind === 'tcp'
        ? address.host
        : address.kind === 'uri'
          ? hostFromUri(address.uri)
          : undefined;
    // The driver usually surfaces a refused connection as "Server selection
    // timed out", which is why the plain socket codes are not enough here.
    const signature = `${error.code ?? ''} ${error.message}`;
    if (host && /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|server selection|connect ECONN/i.test(signature)) {
      const advice = loopbackAdvice(host);
      if (advice) return new DbError(`${error.message}\n\n${advice}`, error.code);
    }
    return error;
  }
}

// ---------------------------------------------------------------------------
// Address / options
// ---------------------------------------------------------------------------

function buildUri(address: Address): string {
  switch (address.kind) {
    case 'uri':
      // §8.2 / §8.3: handed to the driver untouched so `mongodb+srv://` gets
      // its DNS SRV + TXT resolution (this is how Atlas hands out its hosts).
      return address.uri;
    case 'tcp':
      return `mongodb://${formatHost(address.host)}:${address.port}`;
    case 'unix':
      // A socket path is a host component, so its slashes must be escaped.
      return `mongodb://${encodeURIComponent(address.socketPath)}`;
    case 'file':
      throw new DbError('MongoDB cannot be reached through a file path.', 'BAD_ADDRESS');
  }
}

function hostFromUri(uri: string): string | undefined {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?,]+)/i.exec(uri);
  if (!m) return undefined;
  const hostPort = m[1];
  if (hostPort.startsWith('[')) return hostPort.slice(1, hostPort.indexOf(']'));
  const idx = hostPort.lastIndexOf(':');
  return idx === -1 ? hostPort : hostPort.slice(0, idx);
}

/** §8.2: one TLS concept — CA bundle, optional client cert/key, honest verify modes. */
function applyTls(options: MongoClientOptions, tls: TlsConfig | undefined): void {
  if (!tls?.enabled) return;
  options.tls = true;
  if (tls.caCert) options.ca = pem(tls.caCert);
  if (tls.clientCert) options.cert = pem(tls.clientCert);
  if (tls.clientKey) options.key = pem(tls.clientKey);
  if (tls.serverName) options.servername = tls.serverName;

  switch (tls.verify) {
    case 'skip':
      // Said plainly in the UI: this is vulnerable to MITM.
      options.tlsAllowInvalidCertificates = true;
      options.tlsAllowInvalidHostnames = true;
      break;
    case 'require':
      // Verify the chain but tolerate a hostname mismatch — exactly the
      // difference between `require` and `verify-full`, and the normal state of
      // affairs when connecting through a forwarded local port.
      options.tlsAllowInvalidHostnames = true;
      break;
    default:
      break;
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The shell-shaped label the result tab shows. */
function renderFind(
  ns: Namespace,
  filter: Document,
  opts: { sort?: Record<string, 1 | -1>; projection?: Record<string, 0 | 1>; limit: number; skip: number },
): string {
  const args = [ejsonText(filter, { relaxed: true })];
  if (opts.projection) args.push(ejsonText(opts.projection, { relaxed: true }));
  let text = `${ns.database}.${ns.collection}.find(${args.join(', ')})`;
  if (opts.sort) text += `.sort(${ejsonText(opts.sort, { relaxed: true })})`;
  if (opts.skip > 0) text += `.skip(${opts.skip})`;
  text += `.limit(${opts.limit})`;
  return truncateText(text);
}

// ---------------------------------------------------------------------------

export function createMongoConnector(ctx: ConnectorContext): DocumentConnector {
  return new MongoConnector(ctx);
}

/**
 * Re-exported for the document editor, which rebuilds a document out of the
 * grid row it edited before handing it to {@link DocumentConnector.replace}.
 */
export { documentFromRow };
