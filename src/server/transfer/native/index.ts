/**
 * The native-tool facade the job runners call (PLAN §7.2, §7.5, §8.4).
 *
 * §7.2 ships two engines on purpose: native delegation for fidelity and speed,
 * the built-in streaming engine for everything else. This module owns the
 * *choice* — native vs built-in, and local vs remote-side — and nothing else.
 *
 * It deliberately does NOT call the built-in engine. When native is not the
 * right answer it returns `{ used: 'builtin', reason }` and the job runner runs
 * its own pipeline; that keeps the decision in one place without coupling the
 * two engines to each other.
 *
 * Server-side only. No React, no Next (PLAN §11).
 */

import type { ExportFormat, ExportOptions } from '../../../lib/api-types';
import type { ConnectionConfig, SshHop } from '../../../lib/connection';
import type { EngineKind } from '../../../lib/schema-model';
import type { ConnectorEvent } from '../../db/types';
import type { ExportSource, RestoreOptions } from '../../jobs/types';
import { accessResolver } from '../../net';
import { connectionsRepo } from '../../store/db';
import { detectNativeTools, hasTool, parseServerMajor } from './detect';
import type { NativeToolName } from './detect';
import {
  mongoDump,
  mongoRestore,
  mysqlDump,
  mysqlRestore,
  pgDump,
  pgDumpAll,
  pgRestore,
  psqlScript,
  redisRdbDump,
  sqliteDump,
  sqliteRestore,
} from './tools';
import type { MysqlDumpOptions, StructureMode, ToolContext, ToolRunResult } from './tools';
import { planRemoteDump, remoteMongoDump, remoteMysqlDump, remotePgDump } from './remote';
import type { RemotePlan } from './remote';

// The public surface: the settings panel wants the tool inventory, the startup
// log wants the summary line, and the job runners want the two entry points.
export {
  detectNativeTools,
  refreshNativeTools,
  nativeToolsSnapshot,
  toolsResponse,
  toolSummaryLine,
  hasTool,
  pgDumpFor,
  pgAvailableMajors,
  ENGINE_TOOLS,
} from './detect';
export type { NativeTools, DetectedTool, NativeToolName, PgInstall } from './detect';
export { NativeToolError, resolveInputPath, resolveOutputPath } from './tools';
export type { ToolContext, ToolRunResult, StructureMode } from './tools';
export { planRemoteDump, probeRemote, remoteToolPath } from './remote';
export type { RemoteCapabilities, RemotePlan } from './remote';

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type NativeOutcome =
  | {
      used: 'native';
      tool: string;
      /** True when the dump ran on the database's own host (§8.4). */
      remote: boolean;
      outputPath?: string;
      bytesOut: number;
      durationMs: number;
      /** Things worth telling the user that were not fatal. */
      warnings: string[];
    }
  | {
      /**
       * Native was not the right (or possible) engine. The job runner falls
       * back to the built-in streaming pipeline of §7.4.
       */
      used: 'builtin';
      reason: string;
    };

export interface NativeDecision {
  native: boolean;
  tool?: NativeToolName;
  /** Always populated: shown in the jobs drawer so the choice is never a mystery. */
  reason: string;
}

export interface NativeDumpOptions {
  source: ExportSource;
  format: ExportFormat;
  /** Destination, resolved inside `CONFIG.exportRoot` (§7.2). */
  outPath: string;
  options: ExportOptions;
  /** `ServerInfo.version`; drives §7.2's `pg_dump >= server` rule. */
  serverVersion?: string;
}

export interface NativeRestoreOptions {
  source: { kind: 'sql' | 'dump'; path: string; compression?: 'none' | 'gzip' };
  target?: { database?: string };
  options: RestoreOptions;
  serverVersion?: string;
}

// ---------------------------------------------------------------------------
// Decisions (§7.2 "Full-database dump/restore prefers native when present;
// everything else uses the built-in engine")
// ---------------------------------------------------------------------------

function dumpToolFor(engine: EngineKind, source: ExportSource): NativeToolName | null {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return 'mysqldump';
    case 'postgres':
      return source.kind === 'server' ? 'pg_dumpall' : 'pg_dump';
    case 'sqlite':
      return 'sqlite3';
    case 'mongodb':
      return 'mongodump';
    case 'redis':
      return 'redis-cli';
  }
}

export function canNativeDump(config: ConnectionConfig, opts: NativeDumpOptions): NativeDecision {
  if (opts.options.useNativeTool === false) {
    return { native: false, reason: 'the request asked for the built-in engine' };
  }
  // Native tools emit their engine's own SQL/archive format. Any other format
  // is a conversion, which only the built-in pipeline does (§7.2 B).
  if (opts.format !== 'sql') {
    return { native: false, reason: `${opts.format} is a converted format, which the built-in engine produces` };
  }
  if (opts.source.kind === 'query') {
    return { native: false, reason: 'a query export is filtered output, which the built-in engine produces' };
  }
  if (opts.source.kind === 'table') {
    return { native: false, reason: 'table-level exports go through the built-in engine (§7.1)' };
  }
  if (config.engine === 'sqlite' && opts.options.useNativeTool !== true) {
    // §7.5: SQLite's best "export database" is the online backup API, which the
    // built-in engine owns. The CLI is the portable alternative, on request.
    return { native: false, reason: 'SQLite exports use the online backup API unless the sqlite3 CLI is requested' };
  }
  if (config.engine === 'redis') {
    if (opts.source.kind !== 'server') {
      return { native: false, reason: 'redis-cli --rdb dumps the whole server; per-key export is built-in (§7.5)' };
    }
    if (opts.options.structure === 'structure-only') {
      return { native: false, reason: 'Redis has no structure-only dump' };
    }
  }
  if (config.engine === 'mongodb' && opts.source.kind === 'database' && (opts.source.tables?.length ?? 0) > 1) {
    return { native: false, reason: 'a multi-collection subset is a filtered export, which the built-in engine does' };
  }
  const tool = dumpToolFor(config.engine, opts.source);
  if (!tool) return { native: false, reason: `no native dump tool exists for ${config.engine}` };
  if (!hasTool(tool)) {
    return {
      native: false,
      reason: `${tool} is not installed (the Docker image bakes it in, §10.1), so the built-in engine is used`,
    };
  }
  return { native: true, tool, reason: `${tool} gives the best fidelity for a full ${config.engine} dump (§7.2)` };
}

export function canNativeRestore(config: ConnectionConfig, opts: NativeRestoreOptions): NativeDecision {
  if (opts.options.useNativeTool === false) {
    return { native: false, reason: 'the request asked for the built-in engine' };
  }
  if (opts.options.dryRun) {
    // §7.4's dry run validates without writing; no native tool can do that.
    return { native: false, reason: 'a dry run validates without writing, which only the built-in runner does' };
  }
  const tool: NativeToolName | null = (() => {
    switch (config.engine) {
      case 'mysql':
      case 'mariadb':
        return 'mysql';
      case 'postgres':
        return opts.source.kind === 'dump' ? 'pg_restore' : 'psql';
      case 'mongodb':
        return 'mongorestore';
      case 'sqlite':
        return opts.options.useNativeTool === true ? 'sqlite3' : null;
      case 'redis':
        return null;
    }
  })();
  if (!tool) {
    return {
      native: false,
      reason:
        config.engine === 'redis'
          ? 'Redis has no native restore: BGSAVE writes to the server\'s filesystem (§7.5)'
          : 'the built-in SQL script runner handles this restore',
    };
  }
  if (!hasTool(tool)) {
    return { native: false, reason: `${tool} is not installed (§10.1), so the built-in runner is used` };
  }
  return { native: true, tool, reason: `${tool} restores this dump natively (§7.2)` };
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function structureOf(options: { structure?: StructureMode }): StructureMode {
  return options.structure ?? 'both';
}

function secretsFor(config: ConnectionConfig): { password?: string; sshSecrets: (string | null)[] } {
  // Reading the vault is server-side only; these never travel to the browser (§9).
  return {
    password: config.hasPassword ? connectionsRepo.password(config.id) : undefined,
    sshSecrets: connectionsRepo.sshSecrets(config.id),
  };
}

function eventLogger(ctx: ToolContext): (e: ConnectorEvent) => void {
  return (e) => {
    if (e.type === 'state') ctx.log(`[access] ${e.state}${e.message ? `: ${e.message}` : ''}`);
    else ctx.log(`[access] ${e.message}`);
  };
}

function sqliteFilePath(config: ConnectionConfig): string {
  if (config.address.kind !== 'file') {
    throw new Error(`SQLite connection ${config.name} does not point at a file address.`);
  }
  return config.address.path;
}

function toOutcome(result: ToolRunResult, remote: boolean, warnings: string[]): NativeOutcome {
  return {
    used: 'native',
    tool: result.tool,
    remote,
    outputPath: result.outputPath,
    bytesOut: result.bytesOut,
    durationMs: result.durationMs,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Dump
// ---------------------------------------------------------------------------

/**
 * Run a full dump with the native tool, choosing local vs remote-side
 * execution. Returns `{ used: 'builtin' }` — never throws — when native is not
 * the right engine for this request; a native run that *fails* still throws, so
 * a broken dump is never mistaken for a successful one.
 */
export async function nativeDump(
  config: ConnectionConfig,
  opts: NativeDumpOptions,
  ctx: ToolContext,
): Promise<NativeOutcome> {
  await detectNativeTools();
  const decision = canNativeDump(config, opts);
  if (!decision.native) return { used: 'builtin', reason: decision.reason };
  ctx.log(`[transfer] ${decision.reason}`);

  const warnings: string[] = [];
  const { password, sshSecrets } = secretsFor(config);
  const structure = structureOf(opts.options);
  const compression = opts.options.compression ?? 'none';
  const serverMajor = parseServerMajor(opts.serverVersion);

  // §8.4: try the remote side FIRST, because it needs no tunnel at all — every
  // byte would otherwise cross the link uncompressed.
  if (opts.options.remoteSide && config.access.via === 'ssh') {
    const hops: SshHop[] = config.access.hops;
    const remoteTool = remoteDumpToolFor(config.engine, opts.source);
    if (!remoteTool) {
      const note = `Remote-side dump not used: ${config.engine} ${
        opts.source.kind === 'server' ? 'server-wide dumps run' : 'runs'
      } locally (§8.4).`;
      ctx.log(`[transfer] ${note}`);
      warnings.push(note);
    } else {
      const plan = await planRemoteDump({
        hops,
        secrets: sshSecrets,
        tool: remoteTool,
        needsPassword: Boolean(password),
      });
      if (!plan.ok) {
        const note = `Remote-side dump not used: ${plan.reason}. Falling back to the local tool (§8.4).`;
        ctx.log(`[transfer] ${note}`);
        warnings.push(note);
      } else {
        try {
          const result = await runRemoteDump(config, opts, ctx, {
            hops,
            sshSecrets,
            password,
            structure,
            serverMajor,
            plan,
          });
          return toOutcome(result, true, warnings);
        } catch (err) {
          // §8.4 says to fall back to the local path; the local run truncates
          // and rewrites the same file, so a partial remote artifact is
          // harmless. A cancelled job is not a fallback case.
          if (ctx.signal?.aborted) throw err;
          const note = `Remote-side dump failed (${(err as Error).message}); retrying locally.`;
          ctx.log(`[transfer] ${note}`);
          warnings.push(note);
        }
      }
    }
  }

  // Local: the AccessResolver hands us an already-dialable address (§8.1), so a
  // tunnelled connection dumps through the same forwarded port a query uses.
  const resolved = await accessResolver.resolve(config, sshSecrets, { onEvent: eventLogger(ctx) });
  try {
    const conn = { address: resolved.address, username: config.username, password, tls: config.tls };
    switch (config.engine) {
      case 'mysql':
      case 'mariadb': {
        const scope: MysqlDumpOptions['scope'] =
          opts.source.kind === 'server'
            ? { kind: 'server' }
            : {
                kind: 'database',
                database: databaseOf(config, opts.source),
                tables: opts.source.kind === 'database' ? opts.source.tables : undefined,
              };
        const result = await mysqlDump(
          {
            ...conn,
            scope,
            structure,
            stripDefiner: opts.options.stripDefiner,
            compression,
            // §8.3: protocol compression pays off on a remote link only.
            compressProtocol: resolved.tunneled || config.options.compress === true,
            outPath: opts.outPath,
          },
          ctx,
        );
        return toOutcome(result, false, warnings);
      }
      case 'postgres': {
        if (serverMajor === null) {
          const note =
            'The PostgreSQL server version is unknown, so the newest installed pg_dump is used instead of the ' +
            'closest match. Pass ServerInfo.version to enforce §7.2\'s "pg_dump >= server" rule exactly.';
          ctx.log(`[transfer] ${note}`);
          warnings.push(note);
        }
        if (opts.source.kind === 'server') {
          const result = await pgDumpAll(
            { ...conn, structure, serverMajor, compression, outPath: opts.outPath },
            ctx,
          );
          return toOutcome(result, false, warnings);
        }
        const pgFormat = opts.options.pgFormat ?? 'custom';
        if (pgFormat === 'custom' && compression === 'gzip') {
          // Worth surfacing: the artifact is a `-Fc` archive, not a .gz, and
          // naming it .gz would make the restore side try to gunzip it.
          const note = 'A custom-format dump is already compressed, so no gzip layer was added (§7.5).';
          ctx.log(`[transfer] ${note}`);
          warnings.push(note);
        }
        const result = await pgDump(
          {
            ...conn,
            database: databaseOf(config, opts.source),
            // §7.5: custom format so pg_restore can do selective and parallel
            // restores; plain SQL when the user wants to read it.
            format: opts.options.pgFormat ?? 'custom',
            structure,
            tables: opts.source.kind === 'database' ? opts.source.tables : undefined,
            serverMajor,
            compression,
            outPath: opts.outPath,
          },
          ctx,
        );
        return toOutcome(result, false, warnings);
      }
      case 'sqlite': {
        const result = await sqliteDump(
          {
            dbPath: sqliteFilePath(config),
            structure,
            tables: opts.source.kind === 'database' ? opts.source.tables : undefined,
            compression,
            outPath: opts.outPath,
          },
          ctx,
        );
        return toOutcome(result, false, warnings);
      }
      case 'mongodb': {
        const tables = opts.source.kind === 'database' ? opts.source.tables : undefined;
        const result = await mongoDump(
          {
            ...conn,
            database: opts.source.kind === 'database' ? opts.source.database : undefined,
            collection: tables?.length === 1 ? tables[0] : undefined,
            authSource: config.options.authSource,
            compression,
            outPath: opts.outPath,
          },
          ctx,
        );
        return toOutcome(result, false, warnings);
      }
      case 'redis': {
        const result = await redisRdbDump({ ...conn, outPath: opts.outPath }, ctx);
        return toOutcome(result, false, warnings);
      }
    }
  } finally {
    await resolved.release();
  }
}

function databaseOf(config: ConnectionConfig, source: ExportSource): string {
  if (source.kind === 'database') return source.database;
  const fallback = config.options.database;
  if (!fallback) throw new Error(`Connection ${config.name} has no default database to dump.`);
  return fallback;
}

/** Engines whose dump tool can usefully run on the far side (§8.4). */
function remoteDumpToolFor(engine: EngineKind, source: ExportSource): NativeToolName | null {
  // A server-wide dump means pg_dumpall/--all-databases; only Postgres changes
  // binary for it, and pg_dumpall has no remote-side advantage worth a second
  // code path, so it stays local.
  if (engine === 'postgres' && source.kind === 'server') return null;
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return 'mysqldump';
    case 'postgres':
      return 'pg_dump';
    case 'mongodb':
      return 'mongodump';
    default:
      // SQLite is a local file and redis-cli --rdb already streams a compact
      // binary snapshot; neither gains anything from running remotely.
      return null;
  }
}

interface RemoteRunArgs {
  hops: SshHop[];
  sshSecrets: (string | null)[];
  password?: string;
  structure: StructureMode;
  serverMajor: number | null;
  plan: Extract<RemotePlan, { ok: true }>;
}

async function runRemoteDump(
  config: ConnectionConfig,
  opts: NativeDumpOptions,
  ctx: ToolContext,
  args: RemoteRunArgs,
): Promise<ToolRunResult> {
  const base = {
    hops: args.hops,
    sshSecrets: args.sshSecrets,
    // §8.4: the dump runs on the far side, so it dials the address as
    // CONFIGURED — the tunnel entrance means nothing over there.
    address: config.address,
    username: config.username,
    password: args.password,
    outPath: opts.outPath,
    plan: args.plan,
  };
  switch (config.engine) {
    case 'mysql':
    case 'mariadb':
      return remoteMysqlDump(
        {
          ...base,
          scope:
            opts.source.kind === 'server'
              ? { kind: 'server' }
              : {
                  kind: 'database',
                  database: databaseOf(config, opts.source),
                  tables: opts.source.kind === 'database' ? opts.source.tables : undefined,
                },
          structure: args.structure,
          stripDefiner: opts.options.stripDefiner,
          // The wire compression IS the artifact's compression: we stream the
          // remote bytes straight to disk, so asking for gzip is what buys the
          // §8.4 win, and asking for none must still produce a plain .sql.
          compressor: opts.options.compression === 'gzip' ? 'gzip' : 'none',
        },
        ctx,
      );
    case 'postgres':
      return remotePgDump(
        {
          ...base,
          database: databaseOf(config, opts.source),
          format: opts.options.pgFormat ?? 'custom',
          structure: args.structure,
          tables: opts.source.kind === 'database' ? opts.source.tables : undefined,
          serverMajor: args.serverMajor,
          // See the mysqldump branch: the pipe's compression is the file's.
          // remotePgDump forces 'none' for a -Fc archive, which is already
          // compressed.
          compressor: opts.options.compression === 'gzip' ? 'gzip' : 'none',
        },
        ctx,
      );
    case 'mongodb':
      return remoteMongoDump(
        {
          ...base,
          database: opts.source.kind === 'database' ? opts.source.database : undefined,
          authSource: config.options.authSource,
          // mongodump compresses each collection stream inside the archive,
          // which beats piping the whole thing through gzip.
          gzip: opts.options.compression === 'gzip',
        },
        ctx,
      );
    default:
      throw new Error(`${config.engine} has no remote-side dump path (§8.4).`);
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore a dump with the native client. Like `nativeDump`, returns
 * `{ used: 'builtin' }` when the built-in runner is the better engine (dry run,
 * SQLite, Redis, or a missing binary) and throws when a native run fails.
 */
export async function nativeRestore(
  config: ConnectionConfig,
  opts: NativeRestoreOptions,
  ctx: ToolContext,
): Promise<NativeOutcome> {
  await detectNativeTools();
  const decision = canNativeRestore(config, opts);
  if (!decision.native) return { used: 'builtin', reason: decision.reason };
  ctx.log(`[transfer] ${decision.reason}`);

  const warnings: string[] = [];
  const { password, sshSecrets } = secretsFor(config);
  const database = opts.target?.database ?? config.options.database;
  const serverMajor = parseServerMajor(opts.serverVersion);
  const structure: StructureMode = 'both';

  const resolved = await accessResolver.resolve(config, sshSecrets, { onEvent: eventLogger(ctx) });
  try {
    const conn = { address: resolved.address, username: config.username, password, tls: config.tls };
    switch (config.engine) {
      case 'mysql':
      case 'mariadb': {
        const result = await mysqlRestore(
          {
            ...conn,
            database,
            inputPath: opts.source.path,
            compression: opts.source.compression,
            // §7.5: DEFINER clauses are the classic "restores fine on the
            // machine that made it, fails everywhere else".
            stripDefiner: opts.options.stripDefiner,
            disableForeignKeys: opts.options.disableForeignKeys,
            continueOnError: opts.options.continueOnError,
            singleTransaction: opts.options.singleTransaction,
          },
          ctx,
        );
        return toOutcome(result, false, warnings);
      }
      case 'postgres': {
        if (!database) throw new Error('A PostgreSQL restore needs a target database.');
        if (opts.source.kind === 'dump') {
          const result = await pgRestore(
            {
              ...conn,
              database,
              inputPath: opts.source.path,
              compression: opts.source.compression,
              parallel: opts.options.parallel,
              dropExisting: opts.options.dropExisting,
              noOwner: opts.options.noOwner,
              noPrivileges: opts.options.noPrivileges,
              structure,
              singleTransaction: opts.options.singleTransaction,
              continueOnError: opts.options.continueOnError,
              serverMajor,
            },
            ctx,
          );
          return toOutcome(result, false, warnings);
        }
        if (opts.options.parallel && opts.options.parallel > 1) {
          const note =
            'Parallel restore needs a custom-format (-Fc) archive; this plain SQL script runs serially (§7.5).';
          ctx.log(`[transfer] ${note}`);
          warnings.push(note);
        }
        const result = await psqlScript(
          {
            ...conn,
            database,
            inputPath: opts.source.path,
            compression: opts.source.compression,
            singleTransaction: opts.options.singleTransaction,
            continueOnError: opts.options.continueOnError,
            serverMajor,
          },
          ctx,
        );
        return toOutcome(result, false, warnings);
      }
      case 'mongodb': {
        const result = await mongoRestore(
          {
            ...conn,
            inputPath: opts.source.path,
            compression: opts.source.compression,
            database,
            authSource: config.options.authSource,
            dropExisting: opts.options.dropExisting,
            continueOnError: opts.options.continueOnError,
            numParallelCollections: opts.options.parallel,
          },
          ctx,
        );
        return toOutcome(result, false, warnings);
      }
      case 'sqlite': {
        const result = await sqliteRestore(
          {
            dbPath: sqliteFilePath(config),
            inputPath: opts.source.path,
            compression: opts.source.compression,
            continueOnError: opts.options.continueOnError,
            // SQLite DDL is transactional, so the whole script can be one unit.
            singleTransaction: opts.options.singleTransaction,
          },
          ctx,
        );
        return toOutcome(result, false, warnings);
      }
      case 'redis':
        return { used: 'builtin', reason: 'Redis restores through the built-in DUMP/RESTORE pipeline (§7.5)' };
    }
  } finally {
    await resolved.release();
  }
}
