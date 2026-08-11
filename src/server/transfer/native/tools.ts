/**
 * Spawn wrappers for the native dump/restore tools (PLAN §7.2 "A. Native tool
 * delegation", with the consistency and per-engine rules from §7.5).
 *
 * THE SECURITY RULES (§7.2), which every function here obeys without exception:
 *
 *  1. `spawn(bin, argvArray)` — never a shell string, never `shell: true`. No
 *     value a user typed is ever concatenated into a command line.
 *  2. A password NEVER appears in argv: `ps` is world-readable. Postgres and
 *     Redis take theirs from the child's environment (`PGPASSWORD`,
 *     `REDISCLI_AUTH`); MySQL and the Mongo tools take theirs from a temp
 *     options file written `0600` and unlinked in a `finally`.
 *  3. Any user-supplied output path goes through
 *     `resolveWithin(CONFIG.exportRoot, …)` before anything is opened.
 *
 * Every tool's stderr is split into lines, appended to the job log and parsed
 * into progress for the jobs drawer (§7.3).
 *
 * Server-side only. No React, no Next (PLAN §11).
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { Address, TlsConfig } from '../../../lib/connection';
import { CONFIG, paths, resolveWithin } from '../../config';
import type { CancelHook, JobChild, JobProgress } from '../../jobs/types';
import type { NativeToolName } from './detect';
import {
  detectNativeTools,
  minimalEnv,
  missingToolMessage,
  pgAvailableMajors,
  pgBinaryFor,
  pgNewest,
  resolveToolPath,
  toolFlavor,
} from './detect';
import type { PgBinaryName } from './detect';

// ---------------------------------------------------------------------------
// Context, errors, results
// ---------------------------------------------------------------------------

/**
 * What a runner needs from its job. `JobContext` (§7.3) satisfies this
 * structurally, so the job runners pass their context straight through and the
 * transfer layer keeps no dependency on the JobManager's internals.
 */
export interface ToolContext {
  /** Aborted when the user cancels (§7.3). */
  readonly signal?: AbortSignal;
  log(line: string): void;
  progress?(patch: Partial<JobProgress>): void;
  /** Registered children get SIGTERM then SIGKILL on cancel (§7.3). */
  registerChild?(child: JobChild): void;
  onCancel?(hook: CancelHook): void;
}

export class NativeToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly exitCode: number | null = null,
    readonly stderrTail: string = '',
  ) {
    super(message);
    this.name = 'NativeToolError';
  }
}

export interface ToolRunResult {
  tool: string;
  binPath: string;
  /** Exactly what was spawned. Contains no secrets — that is rule 2 above. */
  argv: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  /** Only set for `capture` sinks (small outputs: version strings, table lists). */
  stdout?: string;
  bytesOut: number;
  durationMs: number;
  outputPath?: string;
}

export type StructureMode = 'both' | 'structure-only' | 'data-only';

/** Grace period between SIGTERM and SIGKILL when a job is cancelled (§7.3). */
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_BYTES = 8 * 1024;
const CAPTURE_CAP_BYTES = 4 * 1024 * 1024;
/** Progress is coalesced by the manager anyway; don't spam it per chunk. */
const PROGRESS_INTERVAL_MS = 400;

type TimerHandle = ReturnType<typeof setTimeout>;

function unrefTimer(timer: TimerHandle): void {
  (timer as { unref?: () => void }).unref?.();
}

// ---------------------------------------------------------------------------
// Paths (§7.2 rule 3)
// ---------------------------------------------------------------------------

/** Confine an export destination to `CONFIG.exportRoot` and create its parent. */
export async function resolveOutputPath(candidate: string): Promise<string> {
  const abs = resolveWithin(CONFIG.exportRoot, candidate);
  await mkdir(path.dirname(abs), { recursive: true });
  return abs;
}

/**
 * A restore source is user-supplied too. It may live under the export root (a
 * dump this app produced) or under `$DBADMIN_HOME/tmp` (an upload staged by the
 * jobs layer, §7.3) — and nowhere else.
 */
export function resolveInputPath(candidate: string): string {
  const roots = [CONFIG.exportRoot, paths.tmp()];
  for (const root of roots) {
    try {
      return resolveWithin(root, candidate);
    } catch {
      /* try the next root */
    }
  }
  throw new Error(
    `Refusing to read ${candidate}: restore sources must be inside ${roots.join(' or ')} (§7.2).`,
  );
}

async function tmpDir(): Promise<string> {
  const dir = paths.tmp();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * A secret written where only this user can read it, and deleted in a `finally`
 * by the caller. The alternative — a password in argv — is visible to every
 * process on the box (§7.2).
 */
async function writeSecretFile(contents: string, suffix: string): Promise<string> {
  const file = path.join(await tmpDir(), `dbadmin-${randomBytes(9).toString('hex')}${suffix}`);
  // `wx` so we never write into a file someone else pre-created.
  await writeFile(file, contents, { mode: 0o600, flag: 'wx' });
  return file;
}

async function removeQuietly(files: readonly string[]): Promise<void> {
  await Promise.all(files.map((f) => rm(f, { force: true }).catch(() => undefined)));
}

/** TLS material is "PEM contents or a path" (`TlsConfig`); normalize to a path. */
async function materializePem(value: string | undefined, cleanup: string[]): Promise<string | undefined> {
  if (!value) return undefined;
  if (!value.includes('-----BEGIN')) return value;
  const file = await writeSecretFile(value.endsWith('\n') ? value : `${value}\n`, '.pem');
  cleanup.push(file);
  return file;
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

export class ByteCounter extends Transform {
  bytes = 0;
  constructor(private readonly onBytes?: (total: number) => void) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void): void {
    this.bytes += chunk.length;
    this.onBytes?.(this.bytes);
    cb(null, chunk);
  }
}

/**
 * Strip `DEFINER=user@host` (§7.5): MySQL dumps embed it, and restoring on a
 * host where that user does not exist fails outright. mysqldump has no flag for
 * this — the usual answer is a `sed` in a shell pipe, which §7.2 forbids, so it
 * is a Transform instead.
 *
 * Works on bytes decoded as latin1, which is a byte-exact round trip in Node, so
 * multi-byte UTF-8 in the data is passed through untouched while the ASCII-only
 * patterns still match. A tail of `CARRY` bytes is held back each chunk so a
 * clause split across a chunk boundary is still rewritten as one string.
 */
const DEFINER_CARRY_BYTES = 1024;
const DEFINER_RE =
  /DEFINER\s*=\s*(`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s@]+)@(`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s(]+)\s*/g;
const DEFINER_COMMENT_RE = /\/\*!\d{5} DEFINER\s*=[^*]*\*\//g;

export class DefinerStripper extends Transform {
  private carry = Buffer.alloc(0);

  private rewrite(text: string): string {
    if (!text.includes('DEFINER')) return text;
    return text
      .replace(DEFINER_COMMENT_RE, '')
      .replace(DEFINER_RE, '')
      .replace(/SQL SECURITY DEFINER/g, 'SQL SECURITY INVOKER');
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void): void {
    const buf = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    const keep = Math.min(DEFINER_CARRY_BYTES, buf.length);
    const body = buf.subarray(0, buf.length - keep);
    this.carry = Buffer.from(buf.subarray(buf.length - keep));
    if (body.length === 0) {
      cb();
      return;
    }
    cb(null, Buffer.from(this.rewrite(body.toString('latin1')), 'latin1'));
  }

  override _flush(cb: (e?: Error | null, d?: Buffer) => void): void {
    const tail = this.carry;
    this.carry = Buffer.alloc(0);
    cb(null, tail.length ? Buffer.from(this.rewrite(tail.toString('latin1')), 'latin1') : undefined);
  }
}

/** One Readable from several sources, so a script can be framed without a shell. */
function concatStreams(parts: (() => Readable | Iterable<Buffer | string>)[]): Readable {
  async function* generate(): AsyncGenerator<Buffer | string> {
    for (const part of parts) {
      const source = part();
      if (source instanceof Readable) {
        yield* source;
      } else {
        yield* source;
      }
    }
  }
  return Readable.from(generate());
}

export function splitLines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let carry = '';
  return (chunk: Buffer): void => {
    carry += chunk.toString('utf8');
    let nl = carry.indexOf('\n');
    while (nl >= 0) {
      const line = carry.slice(0, nl).replace(/\r$/, '');
      carry = carry.slice(nl + 1);
      if (line.length > 0) onLine(line);
      nl = carry.indexOf('\n');
    }
    // A tool that never emits a newline must not grow this forever.
    if (carry.length > 64 * 1024) {
      onLine(carry);
      carry = '';
    }
  };
}

// ---------------------------------------------------------------------------
// Progress parsing (§7.3 "stream progress")
// ---------------------------------------------------------------------------

export interface ToolProgress {
  phase?: string;
  /** A table/collection finished. */
  unitDone?: boolean;
  /** Rows reported so far for the CURRENT unit (absolute). */
  unitRows?: number;
  /** Rows the finished unit contained, when the tool states it. */
  unitTotal?: number;
}

export type StderrParser = (line: string) => ToolProgress | null;

/**
 * Progress counters shared by a tool's stderr parser and its output byte
 * counter, emitted at most every PROGRESS_INTERVAL_MS.
 */
class ProgressTracker {
  private completedRows = 0;
  private currentRows = 0;
  private tablesDone = 0;
  private bytes = 0;
  private phase = '';
  private lastEmit = 0;

  constructor(private readonly ctx: ToolContext) {}

  setBytes(total: number): void {
    this.bytes = total;
    this.maybeEmit();
  }

  apply(p: ToolProgress): void {
    if (p.phase) this.phase = p.phase;
    if (p.unitRows !== undefined) this.currentRows = p.unitRows;
    if (p.unitDone) {
      this.tablesDone += 1;
      this.completedRows += p.unitTotal ?? this.currentRows;
      this.currentRows = 0;
    }
    this.maybeEmit();
  }

  private maybeEmit(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return;
    this.lastEmit = now;
    this.ctx.progress?.({
      phase: this.phase || undefined,
      tablesDone: this.tablesDone,
      rowsDone: this.completedRows + this.currentRows,
      bytesOut: this.bytes,
    } as Partial<JobProgress>);
  }

  flush(): void {
    this.maybeEmit(true);
  }
}

/** `pg_dump -v` / `pg_restore -v` narrate every object they touch. */
export const pgParser: StderrParser = (line) => {
  let m = /dumping contents of table "?([^"]+)"?/.exec(line);
  // The tool announces a table as it starts it; that is the only signal it
  // gives, so tablesDone counts tables entered.
  if (m) return { phase: `dumping ${m[1]}`, unitDone: true };
  m = /processing data for table "?([^"]+)"?/.exec(line);
  if (m) return { phase: `restoring ${m[1]}`, unitDone: true };
  m = /creating (\w+) "?([^"]+)"?/.exec(line);
  if (m) return { phase: `creating ${m[1].toLowerCase()} ${m[2]}` };
  m = /^pg_dump: (reading|saving|finding) (.+?)\.*$/.exec(line);
  if (m) return { phase: `${m[1]} ${m[2]}` };
  return null;
};

/** `mysqldump --verbose` writes `-- Retrieving table structure for table x…`. */
export const mysqlDumpParser: StderrParser = (line) => {
  let m = /Retrieving table structure for table (\S+?)\.{0,3}$/.exec(line);
  if (m) return { phase: `dumping ${m[1]}`, unitDone: true };
  m = /Dumping data for table (\S+)/.exec(line);
  if (m) return { phase: `dumping ${m[1]}` };
  if (/Retrieving rows/.test(line)) return { phase: 'retrieving rows' };
  return null;
};

/** mongodump/mongorestore log `[####….] db.coll 100/500 (20.0%)` and `done …`. */
export const mongoParser: StderrParser = (line) => {
  let m = /\]\s+([\w.$-]+)\s+(\d+)\/(\d+)/.exec(line);
  if (m) return { phase: `${m[1]} ${m[2]}/${m[3]}`, unitRows: Number.parseInt(m[2], 10) };
  m = /done dumping ([\w.$-]+) \((\d+) document/.exec(line);
  if (m) return { phase: `dumped ${m[1]}`, unitDone: true, unitTotal: Number.parseInt(m[2], 10) };
  m = /finished restoring ([\w.$-]+) \((\d+) document/.exec(line);
  if (m) return { phase: `restored ${m[1]}`, unitDone: true, unitTotal: Number.parseInt(m[2], 10) };
  m = /writing ([\w.$-]+) to/.exec(line);
  if (m) return { phase: `dumping ${m[1]}` };
  return null;
};

/** `redis-cli --rdb` reports transfer size while the SYNC runs. */
export const redisParser: StderrParser = (line) => {
  const m = /Transfer(?:red)?\s+(\d+)\s+bytes/i.exec(line);
  if (m) return { phase: `transferred ${m[1]} bytes` };
  if (/SYNC sent/i.test(line)) return { phase: 'waiting for the RDB snapshot' };
  return null;
};

// ---------------------------------------------------------------------------
// The spawn core
// ---------------------------------------------------------------------------

export type StdoutSink =
  | { kind: 'file'; path: string; stages?: () => Transform[] }
  | { kind: 'stream'; stream: Writable; stages?: () => Transform[] }
  | { kind: 'capture' }
  | { kind: 'ignore' };

export type StdinSource =
  | { kind: 'none' }
  | { kind: 'stream'; stream: Readable };

export interface RunSpec {
  tool: NativeToolName | string;
  bin: string;
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: StdinSource;
  stdout: StdoutSink;
  parser?: StderrParser;
  ctx: ToolContext;
  /** Temp files (0600 credentials) unlinked in the finally block (§7.2). */
  cleanup?: string[];
  /** Delete a half-written output on failure — a truncated dump looks valid. */
  removeOutputOnFailure?: boolean;
}

function isBrokenPipe(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

/**
 * Spawn one tool and wire it into the job: argv array only, minimal env,
 * stderr → log + progress, stdout → file/stream/capture, SIGTERM→SIGKILL on
 * cancel, and guaranteed cleanup of any credentials file.
 */
export async function runTool(spec: RunSpec): Promise<ToolRunResult> {
  const started = Date.now();
  const cleanup = spec.cleanup ?? [];
  const tracker = new ProgressTracker(spec.ctx);

  try {
    if (spec.ctx.signal?.aborted) {
      throw new NativeToolError(`${spec.tool} was cancelled before it started.`, spec.tool);
    }

    const child: ChildProcess = spawn(spec.bin, spec.argv, {
      // §7.2: an argv array, never a shell. Nothing here is ever interpreted.
      env: spec.env ?? minimalEnv(),
      stdio: [
        spec.stdin && spec.stdin.kind !== 'none' ? 'pipe' : 'ignore',
        spec.stdout.kind === 'ignore' ? 'ignore' : 'pipe',
        'pipe',
      ],
      windowsHide: true,
    });

    // --- cancellation (§7.3) ------------------------------------------------
    let killTimer: TimerHandle | null = null;
    const kill = (): boolean => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      const sent = child.kill('SIGTERM');
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, KILL_GRACE_MS);
        unrefTimer(killTimer);
      }
      return sent;
    };
    // A ChildProcess satisfies JobChild structurally (§7.3).
    spec.ctx.registerChild?.(child);
    spec.ctx.onCancel?.(() => {
      kill();
    });
    const onAbort = (): void => {
      kill();
    };
    spec.ctx.signal?.addEventListener('abort', onAbort, { once: true });

    // --- stderr → job log + progress ---------------------------------------
    let stderrTail = '';
    const handleLine = (line: string): void => {
      stderrTail = `${stderrTail}${line}\n`.slice(-STDERR_TAIL_BYTES);
      spec.ctx.log(`[${spec.tool}] ${line}`);
      const p = spec.parser?.(line);
      if (p) tracker.apply(p);
    };
    child.stderr?.on('data', splitLines(handleLine));

    // --- stdout ------------------------------------------------------------
    let captured = '';
    let bytesOut = 0;
    const tasks: Promise<void>[] = [];

    if (spec.stdout.kind === 'capture' && child.stdout) {
      child.stdout.on('data', (c: Buffer) => {
        if (captured.length < CAPTURE_CAP_BYTES) captured += c.toString('utf8');
      });
    } else if ((spec.stdout.kind === 'file' || spec.stdout.kind === 'stream') && child.stdout) {
      const counter = new ByteCounter((total) => {
        bytesOut = total;
        tracker.setBytes(total);
      });
      const sink: Writable =
        spec.stdout.kind === 'file'
          ? // Dumps carry production data; keep them private to the app's user.
            createWriteStream(spec.stdout.path, { mode: 0o600 })
          : spec.stdout.stream;
      const stages = spec.stdout.stages?.() ?? [];
      tasks.push(pipeline([child.stdout, ...stages, counter, sink]));
    }

    // --- stdin -------------------------------------------------------------
    if (spec.stdin && spec.stdin.kind === 'stream' && child.stdin) {
      const stdin = child.stdin;
      stdin.on('error', () => {
        /* the child exiting first is normal; the exit code is the truth */
      });
      tasks.push(
        pipeline([spec.stdin.stream, stdin]).catch((err: unknown) => {
          if (!isBrokenPipe(err)) throw err;
        }),
      );
    }

    // --- wait --------------------------------------------------------------
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on('error', (err: Error) =>
        reject(
          new NativeToolError(
            `Could not run ${spec.bin}: ${err.message}. ${missingToolMessage(spec.tool as NativeToolName)}`,
            spec.tool,
          ),
        ),
      );
      child.on('close', (code, signal) => resolve({ code, signal }));
    });

    let result: { code: number | null; signal: NodeJS.Signals | null };
    try {
      // Tuple form so the exit status keeps its type alongside the void pipes.
      const settled = await Promise.all([exit, Promise.all(tasks)] as const);
      result = settled[0];
    } catch (err) {
      // A pipeline failure leaves the child running; do not orphan it.
      kill();
      await exit.catch(() => undefined);
      throw err instanceof NativeToolError
        ? err
        : new NativeToolError(`${spec.tool} failed: ${(err as Error).message}`, spec.tool, null, stderrTail);
    } finally {
      spec.ctx.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
    }

    tracker.flush();

    if (result.code !== 0) {
      if (spec.removeOutputOnFailure && spec.stdout.kind === 'file') await removeQuietly([spec.stdout.path]);
      const how = result.signal ? `was killed by ${result.signal}` : `exited with status ${result.code}`;
      throw new NativeToolError(
        `${spec.tool} ${how}.${stderrTail ? ` Last output:\n${stderrTail.trim()}` : ''}`,
        spec.tool,
        result.code,
        stderrTail,
      );
    }

    return {
      tool: spec.tool,
      binPath: spec.bin,
      argv: spec.argv,
      exitCode: result.code,
      signal: result.signal,
      stderrTail,
      stdout: spec.stdout.kind === 'capture' ? captured : undefined,
      bytesOut,
      durationMs: Date.now() - started,
      outputPath: spec.stdout.kind === 'file' ? spec.stdout.path : undefined,
    };
  } finally {
    await removeQuietly(cleanup);
  }
}

// ---------------------------------------------------------------------------
// Shared connection plumbing
// ---------------------------------------------------------------------------

export interface ToolConnection {
  /** Already resolved by the AccessResolver (§8.1) — a dialable address. */
  address: Address;
  username?: string;
  password?: string;
  tls?: TlsConfig;
}

function requireHostPort(address: Address, tool: string): { host: string; port: number } {
  if (address.kind === 'tcp') return { host: address.host, port: address.port };
  throw new NativeToolError(`${tool} needs a TCP address; got ${address.kind}.`, tool);
}

function gzipStage(level: number): () => Transform[] {
  return () => [createGzip({ level })];
}

/** Read a dump file, transparently gunzipping a `.gz`. */
function readDumpStream(absPath: string, gzip: boolean): Readable {
  const file = createReadStream(absPath);
  if (!gzip) return file;
  const gunzip = createGunzip();
  file.on('error', (err) => gunzip.destroy(err));
  return file.pipe(gunzip);
}

function looksGzipped(p: string, declared?: 'none' | 'gzip'): boolean {
  if (declared) return declared === 'gzip';
  return p.endsWith('.gz');
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB (§7.5 "MySQL")
// ---------------------------------------------------------------------------

/** Option-file quoting: MySQL processes backslash escapes inside double quotes. */
function myIniQuote(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * The `--defaults-extra-file` that carries the credentials. It must be the
 * FIRST argument on the command line, and it exists so the password never
 * appears in argv (§7.2).
 */
async function mysqlOptionFile(
  conn: ToolConnection,
  cleanup: string[],
  flavor: 'mysql' | 'mariadb',
): Promise<string> {
  const lines = ['[client]'];
  if (conn.username) lines.push(`user=${myIniQuote(conn.username)}`);
  if (conn.password) lines.push(`password=${myIniQuote(conn.password)}`);
  const tls = conn.tls;
  if (tls?.enabled) {
    const ca = await materializePem(tls.caCert, cleanup);
    const cert = await materializePem(tls.clientCert, cleanup);
    const key = await materializePem(tls.clientKey, cleanup);
    if (ca) lines.push(`ssl-ca=${myIniQuote(ca)}`);
    if (cert) lines.push(`ssl-cert=${myIniQuote(cert)}`);
    if (key) lines.push(`ssl-key=${myIniQuote(key)}`);
    if (flavor === 'mariadb') {
      // MariaDB's client has no --ssl-mode; verification is its own flag.
      lines.push('ssl=1');
      if (tls.verify === 'verify-full') lines.push('ssl-verify-server-cert=1');
    } else {
      // "skip" still encrypts, it just does not verify — §8.2 says so plainly.
      lines.push(`ssl-mode=${tls.verify === 'verify-full' ? 'VERIFY_IDENTITY' : 'REQUIRED'}`);
    }
  }
  const file = await writeSecretFile(`${lines.join('\n')}\n`, '.cnf');
  cleanup.push(file);
  return file;
}

function mysqlAddressArgs(address: Address, tool: string): string[] {
  if (address.kind === 'unix') return ['--socket', address.socketPath];
  const { host, port } = requireHostPort(address, tool);
  // The MySQL client turns "localhost" into a socket connection; a tunnel's
  // 127.0.0.1 endpoint must stay TCP (§8.1), so say so explicitly.
  return ['--host', host, '--port', String(port), '--protocol=TCP'];
}

export interface MysqlDumpOptions extends ToolConnection {
  scope: { kind: 'database'; database: string; tables?: string[] } | { kind: 'server' };
  structure: StructureMode;
  /** §7.5 consistency: an InnoDB snapshot instead of locking the server. */
  singleTransaction?: boolean;
  skipLockTables?: boolean;
  /** §7.5: DEFINER=user@host fails when restored on another host. */
  stripDefiner?: boolean;
  /** Routines, triggers and events are off by default in mysqldump. */
  includeRoutines?: boolean;
  compression?: 'none' | 'gzip';
  gzipLevel?: number;
  /** §8.3: protocol compression is a win on remote links only. */
  compressProtocol?: boolean;
  outPath: string;
  extraArgs?: string[];
}

export async function mysqlDump(opts: MysqlDumpOptions, ctx: ToolContext): Promise<ToolRunResult> {
  // Debian's `default-mysql-client` is MariaDB's, whose flags differ — so the
  // flavor must be known before argv is built, not guessed (§7.5).
  await detectNativeTools();
  const bin = resolveToolPath('mysqldump');
  if (!bin) throw new NativeToolError(missingToolMessage('mysqldump'), 'mysqldump');
  const flavor = toolFlavor('mysqldump') ?? 'mysql';
  const cleanup: string[] = [];
  const outAbs = await resolveOutputPath(opts.outPath);

  const optionFile = await mysqlOptionFile(opts, cleanup, flavor);
  const argv = [`--defaults-extra-file=${optionFile}`, ...mysqlAddressArgs(opts.address, 'mysqldump')];

  // §7.5 consistency: a snapshot that does not block writers.
  if (opts.singleTransaction !== false) argv.push('--single-transaction');
  if (opts.skipLockTables !== false) argv.push('--skip-lock-tables');
  // §7.4: binary in a text format is the classic silent corruption; hex is safe.
  argv.push('--hex-blob');
  // §7.5: utf8 vs utf8mb4 mismatches bite on restore.
  argv.push('--default-character-set=utf8mb4');
  // Avoids needing the PROCESS privilege on MySQL 8, which few dump users have.
  argv.push('--no-tablespaces');
  argv.push('--verbose'); // stderr narration -> job log + progress (§7.3)
  if (flavor === 'mysql') {
    // MySQL 8 emits SET @@GLOBAL.GTID_PURGED, which breaks a restore onto a
    // different server. MariaDB's mysqldump does not know the flag.
    argv.push('--set-gtid-purged=OFF');
  }
  if (opts.compressProtocol) argv.push('--compress');

  if (opts.structure === 'structure-only') argv.push('--no-data');
  if (opts.structure === 'data-only') argv.push('--no-create-info', '--skip-triggers');
  if (opts.structure !== 'data-only' && opts.includeRoutines !== false) {
    argv.push('--routines', '--triggers', '--events');
  }

  if (opts.scope.kind === 'server') {
    argv.push('--all-databases');
  } else if (opts.scope.tables && opts.scope.tables.length > 0) {
    // `db t1 t2` form: no CREATE DATABASE, exactly the named tables.
    argv.push(opts.scope.database, ...opts.scope.tables);
  } else {
    argv.push('--databases', opts.scope.database);
  }
  if (opts.extraArgs) argv.push(...opts.extraArgs);

  const gzip = opts.compression === 'gzip';
  const stages = (): Transform[] => {
    const list: Transform[] = [];
    if (opts.stripDefiner) list.push(new DefinerStripper());
    if (gzip) list.push(createGzip({ level: opts.gzipLevel ?? 6 }));
    return list;
  };

  return runTool({
    tool: 'mysqldump',
    bin,
    argv,
    stdout: { kind: 'file', path: outAbs, stages },
    parser: mysqlDumpParser,
    ctx,
    cleanup,
    removeOutputOnFailure: true,
  });
}

export interface MysqlRestoreOptions extends ToolConnection {
  database?: string;
  /** Path to a `.sql` or `.sql.gz` produced by mysqldump. */
  inputPath: string;
  compression?: 'none' | 'gzip';
  stripDefiner?: boolean;
  disableForeignKeys?: boolean;
  continueOnError?: boolean;
  singleTransaction?: boolean;
}

export async function mysqlRestore(opts: MysqlRestoreOptions, ctx: ToolContext): Promise<ToolRunResult> {
  await detectNativeTools(); // flavor drives the TLS options (see mysqlDump)
  const bin = resolveToolPath('mysql');
  if (!bin) throw new NativeToolError(missingToolMessage('mysql'), 'mysql');
  const flavor = toolFlavor('mysql') ?? 'mysql';
  const cleanup: string[] = [];
  const inAbs = resolveInputPath(opts.inputPath);

  const optionFile = await mysqlOptionFile(opts, cleanup, flavor);
  const argv = [`--defaults-extra-file=${optionFile}`, ...mysqlAddressArgs(opts.address, 'mysql')];
  argv.push('--default-character-set=utf8mb4');
  // Dumps can contain raw binary and \r inside strings; without this the client
  // rejects them.
  argv.push('--binary-mode');
  if (opts.continueOnError) argv.push('--force');
  if (opts.database) argv.push('--database', opts.database);

  // §7.5 restore ordering: FK checks off during the load, back on afterwards.
  const prologue: string[] = [];
  const epilogue: string[] = [];
  if (opts.disableForeignKeys) {
    prologue.push('SET @DBADMIN_FK := @@FOREIGN_KEY_CHECKS;', 'SET FOREIGN_KEY_CHECKS = 0;', 'SET UNIQUE_CHECKS = 0;');
    epilogue.push('SET FOREIGN_KEY_CHECKS = @DBADMIN_FK;', 'SET UNIQUE_CHECKS = 1;');
  }
  if (opts.singleTransaction) {
    // Only meaningful for a data-only dump: DDL commits implicitly in MySQL.
    prologue.push('START TRANSACTION;');
    epilogue.push('COMMIT;');
  }

  const bytes = { read: 0 };
  const counter = new ByteCounter((total) => {
    bytes.read = total;
    ctx.progress?.({ bytesOut: total });
  });
  const source = concatStreams([
    () => (prologue.length ? [`${prologue.join('\n')}\n`] : []),
    () => {
      const raw = readDumpStream(inAbs, looksGzipped(inAbs, opts.compression));
      const stripped = opts.stripDefiner ? raw.pipe(new DefinerStripper()) : raw;
      return stripped.pipe(counter);
    },
    () => (epilogue.length ? [`\n${epilogue.join('\n')}\n`] : []),
  ]);

  const result = await runTool({
    tool: 'mysql',
    bin,
    argv,
    stdin: { kind: 'stream', stream: source },
    stdout: { kind: 'ignore' },
    ctx,
    cleanup,
  });
  return { ...result, bytesOut: bytes.read };
}

// ---------------------------------------------------------------------------
// PostgreSQL (§7.5 "Postgres", §7.2 version rule)
// ---------------------------------------------------------------------------

/**
 * §7.2's version rule, enforced by SELECTING a client at least as new as the
 * server (§10.1 ships several majors) and refusing clearly when none qualifies.
 */
export function selectPgBinary(name: PgBinaryName, serverMajor: number | null | undefined): string {
  if (serverMajor !== null && serverMajor !== undefined && serverMajor > 0) {
    const chosen = pgBinaryFor(name, serverMajor);
    if (chosen) return chosen;
    const majors = pgAvailableMajors();
    throw new NativeToolError(
      `${name} must be at least as new as the server (PostgreSQL ${serverMajor}), otherwise the dump is ` +
        `silently broken (§7.2). ${
          majors.length ? `Installed client majors: ${majors.join(', ')}.` : 'No Postgres client is installed.'
        } Add postgresql-client-${serverMajor} to the image (§10.1), or export with the built-in engine.`,
      name,
    );
  }
  const newest = pgNewest(name);
  if (!newest) throw new NativeToolError(missingToolMessage(name as NativeToolName), name);
  return newest;
}

interface PgConn {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cleanup: string[];
  database?: string;
}

/** Connection flags + env. The password goes in `PGPASSWORD`, never argv (§7.2). */
async function pgConnection(conn: ToolConnection, database?: string): Promise<PgConn> {
  const cleanup: string[] = [];
  const argv: string[] = [];
  let db = database;
  let user = conn.username;
  let password = conn.password;

  switch (conn.address.kind) {
    case 'tcp':
      argv.push('-h', conn.address.host, '-p', String(conn.address.port));
      break;
    case 'unix': {
      // libpq wants the DIRECTORY holding .s.PGSQL.<port>, not the socket file.
      const base = path.basename(conn.address.socketPath);
      const m = /^\.s\.PGSQL\.(\d+)$/.exec(base);
      if (m) argv.push('-h', path.dirname(conn.address.socketPath), '-p', m[1]);
      else argv.push('-h', conn.address.socketPath);
      break;
    }
    case 'uri': {
      // A URI may carry the password; strip it out of argv and move it to the
      // environment (§7.2).
      const url = new URL(conn.address.uri);
      if (url.hostname) argv.push('-h', decodeURIComponent(url.hostname));
      if (url.port) argv.push('-p', url.port);
      if (url.username) user = decodeURIComponent(url.username);
      if (url.password) password = decodeURIComponent(url.password);
      const uriDb = url.pathname.replace(/^\//, '');
      if (!db && uriDb) db = decodeURIComponent(uriDb);
      break;
    }
    case 'file':
      throw new NativeToolError('A file address is not a PostgreSQL server.', 'pg_dump');
  }
  if (user) argv.push('-U', user);
  if (db) argv.push('-d', db);

  const env = minimalEnv({
    PGPASSWORD: password,
    PGCLIENTENCODING: 'UTF8',
    PGCONNECT_TIMEOUT: '15',
    PGAPPNAME: 'dbadmin',
  });
  const tls = conn.tls;
  if (tls?.enabled) {
    // "skip" still encrypts; it just does not verify — said honestly in §8.2.
    env.PGSSLMODE = tls.verify === 'verify-full' ? 'verify-full' : 'require';
    const ca = await materializePem(tls.caCert, cleanup);
    const cert = await materializePem(tls.clientCert, cleanup);
    const key = await materializePem(tls.clientKey, cleanup);
    if (ca) env.PGSSLROOTCERT = ca;
    if (cert) env.PGSSLCERT = cert;
    if (key) env.PGSSLKEY = key;
  }
  return { argv, env, cleanup, database: db };
}

export interface PgDumpOptions extends ToolConnection {
  database: string;
  /** §7.5: custom format enables selective and parallel restore. */
  format: 'custom' | 'plain';
  structure: StructureMode;
  noOwner?: boolean;
  noPrivileges?: boolean;
  schemas?: string[];
  tables?: string[];
  /** Drives the §7.2 binary selection. */
  serverMajor?: number | null;
  compression?: 'none' | 'gzip';
  gzipLevel?: number;
  outPath: string;
  extraArgs?: string[];
}

export async function pgDump(opts: PgDumpOptions, ctx: ToolContext): Promise<ToolRunResult> {
  const bin = selectPgBinary('pg_dump', opts.serverMajor);
  const conn = await pgConnection(opts, opts.database);
  const outAbs = await resolveOutputPath(opts.outPath);

  const argv = [...conn.argv, '-v'];
  argv.push(opts.format === 'custom' ? '-Fc' : '-Fp');
  // §7.5: ownership and grants are the usual reason a dump will not restore
  // onto a different cluster.
  if (opts.noOwner !== false) argv.push('--no-owner');
  if (opts.noPrivileges !== false) argv.push('--no-privileges');
  if (opts.structure === 'structure-only') argv.push('--schema-only');
  if (opts.structure === 'data-only') argv.push('--data-only');
  for (const schema of opts.schemas ?? []) argv.push('-n', schema);
  for (const table of opts.tables ?? []) argv.push('-t', table);
  if (opts.extraArgs) argv.push(...opts.extraArgs);

  // The custom format is already zlib-compressed; gzipping it again buys
  // nothing and makes pg_restore need a decompression pass first.
  const gzip = opts.compression === 'gzip' && opts.format === 'plain';
  if (opts.compression === 'gzip' && opts.format === 'custom') {
    ctx.log('[pg_dump] custom format is already compressed; skipping the extra gzip layer.');
  }

  return runTool({
    tool: 'pg_dump',
    bin,
    argv,
    env: conn.env,
    stdout: { kind: 'file', path: outAbs, stages: gzip ? gzipStage(opts.gzipLevel ?? 6) : undefined },
    parser: pgParser,
    ctx,
    cleanup: conn.cleanup,
    removeOutputOnFailure: true,
  });
}

export interface PgDumpAllOptions extends ToolConnection {
  /** Roles/tablespaces only — the companion to per-database dumps. */
  globalsOnly?: boolean;
  structure: StructureMode;
  noOwner?: boolean;
  noPrivileges?: boolean;
  serverMajor?: number | null;
  compression?: 'none' | 'gzip';
  gzipLevel?: number;
  outPath: string;
}

/** §7.1 server level: every database in one archive. Plain SQL only. */
export async function pgDumpAll(opts: PgDumpAllOptions, ctx: ToolContext): Promise<ToolRunResult> {
  const bin = selectPgBinary('pg_dumpall', opts.serverMajor);
  // pg_dumpall connects to a maintenance database; -d is a connection string
  // there, so leave the database out and let it default to `postgres`.
  const conn = await pgConnection(opts);
  const argv = [...conn.argv, '-v'];
  if (opts.globalsOnly) argv.push('--globals-only');
  if (opts.noOwner !== false) argv.push('--no-owner');
  if (opts.noPrivileges !== false) argv.push('--no-privileges');
  if (opts.structure === 'structure-only') argv.push('--schema-only');
  if (opts.structure === 'data-only') argv.push('--data-only');
  const outAbs = await resolveOutputPath(opts.outPath);

  return runTool({
    tool: 'pg_dumpall',
    bin,
    argv,
    env: conn.env,
    stdout: {
      kind: 'file',
      path: outAbs,
      stages: opts.compression === 'gzip' ? gzipStage(opts.gzipLevel ?? 6) : undefined,
    },
    parser: pgParser,
    ctx,
    cleanup: conn.cleanup,
    removeOutputOnFailure: true,
  });
}

export interface PgRestoreOptions extends ToolConnection {
  database: string;
  /** A `-Fc` archive, optionally gzipped by us. */
  inputPath: string;
  compression?: 'none' | 'gzip';
  /** §7.5: pg_restore -j is the reason to prefer the custom format. */
  parallel?: number;
  dropExisting?: boolean;
  noOwner?: boolean;
  noPrivileges?: boolean;
  structure: StructureMode;
  /** Selective restore. */
  schemas?: string[];
  tables?: string[];
  singleTransaction?: boolean;
  continueOnError?: boolean;
  serverMajor?: number | null;
}

export async function pgRestore(opts: PgRestoreOptions, ctx: ToolContext): Promise<ToolRunResult> {
  const bin = selectPgBinary('pg_restore', opts.serverMajor);
  const conn = await pgConnection(opts, opts.database);
  const inAbs = resolveInputPath(opts.inputPath);
  const temps: string[] = [];

  // pg_restore needs a seekable file for parallel restore and cannot read gzip
  // at all, so a compressed archive is expanded to a temp file first — no shell
  // pipe involved (§7.2).
  let archive = inAbs;
  if (looksGzipped(inAbs, opts.compression)) {
    const expanded = path.join(await tmpDir(), `restore-${randomBytes(8).toString('hex')}.dump`);
    ctx.log(`[pg_restore] expanding ${path.basename(inAbs)} before restoring`);
    await pipeline([createReadStream(inAbs), createGunzip(), createWriteStream(expanded, { mode: 0o600 })]);
    temps.push(expanded);
    archive = expanded;
  }

  const argv = [...conn.argv, '-v'];
  const parallel = opts.parallel && opts.parallel > 1 ? Math.floor(opts.parallel) : 0;
  if (parallel) {
    argv.push('-j', String(parallel));
    if (opts.singleTransaction) {
      // --single-transaction and -j are mutually exclusive; parallelism wins
      // because it is why the custom format was chosen (§7.5).
      ctx.log('[pg_restore] ignoring single-transaction: it cannot be combined with parallel restore.');
    }
  } else if (opts.singleTransaction) {
    argv.push('--single-transaction');
  }
  if (opts.dropExisting) argv.push('--clean', '--if-exists');
  if (opts.noOwner !== false) argv.push('--no-owner');
  if (opts.noPrivileges !== false) argv.push('--no-privileges');
  if (opts.structure === 'structure-only') argv.push('--schema-only');
  if (opts.structure === 'data-only') argv.push('--data-only');
  for (const schema of opts.schemas ?? []) argv.push('-n', schema);
  for (const table of opts.tables ?? []) argv.push('-t', table);
  if (!opts.continueOnError && !parallel) argv.push('--exit-on-error');
  argv.push(archive);

  const size = await stat(archive).then(
    (s) => s.size,
    () => 0,
  );
  const result = await runTool({
    tool: 'pg_restore',
    bin,
    argv,
    env: conn.env,
    stdout: { kind: 'ignore' },
    parser: pgParser,
    ctx,
    cleanup: [...conn.cleanup, ...temps],
  });
  return { ...result, bytesOut: size };
}

export interface PsqlScriptOptions extends ToolConnection {
  database?: string;
  inputPath: string;
  compression?: 'none' | 'gzip';
  singleTransaction?: boolean;
  continueOnError?: boolean;
  serverMajor?: number | null;
}

/** Run a plain-SQL dump or script through psql (§7.1 "run a .sql script"). */
export async function psqlScript(opts: PsqlScriptOptions, ctx: ToolContext): Promise<ToolRunResult> {
  const bin = selectPgBinary('psql', opts.serverMajor);
  const conn = await pgConnection(opts, opts.database);
  const inAbs = resolveInputPath(opts.inputPath);

  const argv = [
    ...conn.argv,
    // -X: ignore ~/.psqlrc, whose settings would silently change the restore.
    '-X',
    '--echo-errors',
    '-f',
    '-',
  ];
  if (!opts.continueOnError) argv.push('-v', 'ON_ERROR_STOP=1');
  if (opts.singleTransaction) argv.push('--single-transaction');

  const bytes = { read: 0 };
  const counter = new ByteCounter((total) => {
    bytes.read = total;
    ctx.progress?.({ bytesOut: total });
  });
  const source = readDumpStream(inAbs, looksGzipped(inAbs, opts.compression)).pipe(counter);

  const result = await runTool({
    tool: 'psql',
    bin,
    argv,
    env: conn.env,
    stdin: { kind: 'stream', stream: source },
    stdout: { kind: 'ignore' },
    ctx,
    cleanup: conn.cleanup,
  });
  return { ...result, bytesOut: bytes.read };
}

// ---------------------------------------------------------------------------
// SQLite (§7.5 "SQLite" — the CLI is the portable alternative to db.backup())
// ---------------------------------------------------------------------------

export interface SqliteDumpOptions {
  /** The database file, as the connection stores it. */
  dbPath: string;
  structure: StructureMode;
  tables?: string[];
  compression?: 'none' | 'gzip';
  gzipLevel?: number;
  outPath: string;
}

function sqliteQuoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function sqliteTableNames(bin: string, dbPath: string, ctx: ToolContext): Promise<string[]> {
  const result = await runTool({
    tool: 'sqlite3',
    bin,
    argv: [
      '-readonly',
      '-batch',
      '-noheader',
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    ],
    stdout: { kind: 'capture' },
    ctx,
  });
  return (result.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export async function sqliteDump(opts: SqliteDumpOptions, ctx: ToolContext): Promise<ToolRunResult> {
  const bin = resolveToolPath('sqlite3');
  if (!bin) throw new NativeToolError(missingToolMessage('sqlite3'), 'sqlite3');
  const outAbs = await resolveOutputPath(opts.outPath);

  const commands: string[] = [];
  if (opts.structure === 'structure-only') {
    commands.push(opts.tables?.length ? opts.tables.map((t) => `.schema ${t}`).join('\n') : '.schema');
  } else if (opts.structure === 'data-only') {
    // `.dump` always emits DDL, so data-only is built from INSERT mode, one
    // table at a time. Two spawns total — still far cheaper than a shell.
    const tables = opts.tables?.length ? opts.tables : await sqliteTableNames(bin, opts.dbPath, ctx);
    for (const table of tables) {
      commands.push(`.mode insert ${table}`, `SELECT * FROM ${sqliteQuoteIdent(table)};`);
    }
  } else {
    commands.push(opts.tables?.length ? opts.tables.map((t) => `.dump ${t}`).join('\n') : '.dump');
  }

  const argv = ['-readonly', '-batch', '-bail', opts.dbPath];
  const stages = opts.compression === 'gzip' ? gzipStage(opts.gzipLevel ?? 6) : undefined;

  return runTool({
    tool: 'sqlite3',
    bin,
    argv,
    stdin: { kind: 'stream', stream: Readable.from([`${commands.join('\n')}\n`]) },
    stdout: { kind: 'file', path: outAbs, stages },
    ctx,
    removeOutputOnFailure: true,
  });
}

export interface SqliteRestoreOptions {
  dbPath: string;
  inputPath: string;
  compression?: 'none' | 'gzip';
  continueOnError?: boolean;
  /** Wrap the whole script — SQLite DDL is transactional, unlike MySQL's. */
  singleTransaction?: boolean;
}

export async function sqliteRestore(opts: SqliteRestoreOptions, ctx: ToolContext): Promise<ToolRunResult> {
  const bin = resolveToolPath('sqlite3');
  if (!bin) throw new NativeToolError(missingToolMessage('sqlite3'), 'sqlite3');
  const inAbs = resolveInputPath(opts.inputPath);
  const argv = ['-batch', ...(opts.continueOnError ? [] : ['-bail']), opts.dbPath];

  const bytes = { read: 0 };
  const counter = new ByteCounter((total) => {
    bytes.read = total;
    ctx.progress?.({ bytesOut: total });
  });
  const source = concatStreams([
    () => (opts.singleTransaction ? ['BEGIN;\n'] : []),
    () => readDumpStream(inAbs, looksGzipped(inAbs, opts.compression)).pipe(counter),
    () => (opts.singleTransaction ? ['\nCOMMIT;\n'] : []),
  ]);

  const result = await runTool({
    tool: 'sqlite3',
    bin,
    argv,
    stdin: { kind: 'stream', stream: source },
    stdout: { kind: 'ignore' },
    ctx,
  });
  return { ...result, bytesOut: bytes.read };
}

// ---------------------------------------------------------------------------
// MongoDB (§7.5 "MongoDB" — BSON preserves types exactly)
// ---------------------------------------------------------------------------

/**
 * The Mongo tools accept no password env var, and `--uri` may not be combined
 * with the individual flags — so both the URI and the password go into a 0600
 * `--config` YAML file (§7.2). JSON string syntax is valid YAML double-quoted
 * scalar syntax, so `JSON.stringify` is the correct escaper here.
 */
async function mongoConfigFile(
  fields: Record<string, string | undefined>,
  cleanup: string[],
): Promise<string | null> {
  const lines = Object.entries(fields)
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '')
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  if (lines.length === 0) return null;
  const file = await writeSecretFile(`${lines.join('\n')}\n`, '.yaml');
  cleanup.push(file);
  return file;
}

async function mongoConnectionArgs(
  conn: ToolConnection,
  authSource: string | undefined,
  cleanup: string[],
): Promise<string[]> {
  const argv: string[] = [];
  if (conn.address.kind === 'uri') {
    // Everything travels in the config file, credentials included.
    const config = await mongoConfigFile({ uri: conn.address.uri }, cleanup);
    if (config) argv.push(`--config=${config}`);
    return argv;
  }
  if (conn.address.kind === 'unix') {
    argv.push('--host', conn.address.socketPath);
  } else {
    const { host, port } = requireHostPort(conn.address, 'mongodump');
    argv.push('--host', host, '--port', String(port));
  }
  if (conn.username) argv.push('--username', conn.username);
  if (authSource) argv.push('--authenticationDatabase', authSource);
  if (conn.tls?.enabled) {
    argv.push('--ssl');
    const ca = await materializePem(conn.tls.caCert, cleanup);
    if (ca) argv.push('--sslCAFile', ca);
    const cert = await materializePem(conn.tls.clientCert, cleanup);
    if (cert) argv.push('--sslPEMKeyFile', cert);
    if (conn.tls.verify === 'skip') argv.push('--sslAllowInvalidCertificates');
  }
  const config = await mongoConfigFile({ password: conn.password }, cleanup);
  if (config) argv.push(`--config=${config}`);
  return argv;
}

export interface MongoDumpOptions extends ToolConnection {
  database?: string;
  collection?: string;
  authSource?: string;
  /** mongodump's own gzip; better than piping because it compresses per stream. */
  compression?: 'none' | 'gzip';
  numParallelCollections?: number;
  outPath: string;
}

export async function mongoDump(opts: MongoDumpOptions, ctx: ToolContext): Promise<ToolRunResult> {
  const bin = resolveToolPath('mongodump');
  if (!bin) throw new NativeToolError(missingToolMessage('mongodump'), 'mongodump');
  const cleanup: string[] = [];
  const outAbs = await resolveOutputPath(opts.outPath);

  const argv = await mongoConnectionArgs(opts, opts.authSource, cleanup);
  // `--archive` with no value streams the archive on stdout, so the whole dump
  // stays a single file and never needs a scratch directory.
  argv.push('--archive');
  if (opts.compression === 'gzip') argv.push('--gzip');
  if (opts.database) argv.push('--db', opts.database);
  if (opts.collection) argv.push('--collection', opts.collection);
  if (opts.numParallelCollections && opts.numParallelCollections > 1) {
    argv.push('--numParallelCollections', String(Math.floor(opts.numParallelCollections)));
  }

  return runTool({
    tool: 'mongodump',
    bin,
    argv,
    stdout: { kind: 'file', path: outAbs },
    parser: mongoParser,
    ctx,
    cleanup,
    removeOutputOnFailure: true,
  });
}

export interface MongoRestoreOptions extends ToolConnection {
  inputPath: string;
  compression?: 'none' | 'gzip';
  database?: string;
  authSource?: string;
  dropExisting?: boolean;
  /** §7.5: indexes are rebuilt after the data load — mongorestore's default. */
  noIndexRestore?: boolean;
  numParallelCollections?: number;
  continueOnError?: boolean;
}

export async function mongoRestore(opts: MongoRestoreOptions, ctx: ToolContext): Promise<ToolRunResult> {
  const bin = resolveToolPath('mongorestore');
  if (!bin) throw new NativeToolError(missingToolMessage('mongorestore'), 'mongorestore');
  const cleanup: string[] = [];
  const inAbs = resolveInputPath(opts.inputPath);
  const gzipped = looksGzipped(inAbs, opts.compression);

  const argv = await mongoConnectionArgs(opts, opts.authSource, cleanup);
  argv.push('--archive'); // read the archive from stdin
  if (gzipped) argv.push('--gzip');
  if (opts.database) argv.push('--nsInclude', `${opts.database}.*`);
  if (opts.dropExisting) argv.push('--drop');
  if (opts.noIndexRestore) argv.push('--noIndexRestore');
  if (opts.continueOnError) argv.push('--stopOnError=false');
  if (opts.numParallelCollections && opts.numParallelCollections > 1) {
    argv.push('--numParallelCollections', String(Math.floor(opts.numParallelCollections)));
  }

  const bytes = { read: 0 };
  const counter = new ByteCounter((total) => {
    bytes.read = total;
    ctx.progress?.({ bytesOut: total });
  });
  // mongorestore handles the gunzip itself; hand it the file exactly as stored.
  const source = createReadStream(inAbs).pipe(counter);

  const result = await runTool({
    tool: 'mongorestore',
    bin,
    argv,
    stdin: { kind: 'stream', stream: source },
    stdout: { kind: 'ignore' },
    parser: mongoParser,
    ctx,
    cleanup,
  });
  return { ...result, bytesOut: bytes.read };
}

// ---------------------------------------------------------------------------
// Redis (§7.5 "Redis" — --rdb is a true RDB pulled over replication)
// ---------------------------------------------------------------------------

export interface RedisRdbOptions extends ToolConnection {
  outPath: string;
}

export async function redisRdbDump(opts: RedisRdbOptions, ctx: ToolContext): Promise<ToolRunResult> {
  const bin = resolveToolPath('redis-cli');
  if (!bin) throw new NativeToolError(missingToolMessage('redis-cli'), 'redis-cli');
  const cleanup: string[] = [];
  const outAbs = await resolveOutputPath(opts.outPath);

  const argv: string[] = [];
  if (opts.address.kind === 'unix') argv.push('-s', opts.address.socketPath);
  else {
    const { host, port } = requireHostPort(opts.address, 'redis-cli');
    argv.push('-h', host, '-p', String(port));
  }
  // The password comes from REDISCLI_AUTH; -a would put it in argv (§7.2).
  if (opts.username) argv.push('--user', opts.username);
  if (opts.tls?.enabled) {
    argv.push('--tls');
    const ca = await materializePem(opts.tls.caCert, cleanup);
    if (ca) argv.push('--cacert', ca);
    const cert = await materializePem(opts.tls.clientCert, cleanup);
    const key = await materializePem(opts.tls.clientKey, cleanup);
    if (cert) argv.push('--cert', cert);
    if (key) argv.push('--key', key);
    if (opts.tls.verify === 'skip') argv.push('--insecure');
  }
  argv.push('--no-auth-warning', '--rdb', outAbs);

  const result = await runTool({
    tool: 'redis-cli',
    bin,
    argv,
    env: minimalEnv({ REDISCLI_AUTH: opts.password }),
    stdout: { kind: 'ignore' },
    parser: redisParser,
    ctx,
    cleanup,
  });
  // --rdb writes the file itself, so the byte count comes from the filesystem.
  const size = await stat(outAbs).then(
    (s) => s.size,
    () => 0,
  );
  ctx.progress?.({ bytesOut: size });
  return { ...result, bytesOut: size, outputPath: outAbs };
}
