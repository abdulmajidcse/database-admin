/**
 * Remote-side dumps (PLAN §8.4).
 *
 * Running `mysqldump` locally against a remote server pulls every row across
 * the wire uncompressed. The alternative is to run the dump ON the remote host
 * over SSH and stream compressed bytes back:
 *
 *     ssh host 'mysqldump --single-transaction db | gzip -1' > local/db.sql.gz
 *
 * Often 5–10× faster on a slow link. It requires the tool to exist remotely, so
 * we probe first and fall back to the local path when it does not — that probe
 * is one round trip that also collects tool versions and compressor
 * availability, because §8.3 says round trips are the budget.
 *
 * SECRETS. §7.2's "never a password in argv" applies on the far side too: an
 * `sshd` command runs as `sh -c '<string>'`, so anything embedded in the command
 * is visible in the remote host's `ps`. Instead the password travels as an SSH
 * environment variable named `LC_DBADMIN_PW` — `LC_*` is what the stock
 * `AcceptEnv LANG LC_*` in sshd_config lets through — and the command only ever
 * references it (`PGPASSWORD="$LC_DBADMIN_PW" pg_dump …`). We probe that the
 * variable actually arrives; when it does not, and the dump needs a password,
 * we fall back to the local path rather than leak it.
 *
 * Server-side only. No React, no Next (PLAN §11).
 */

import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { Address, SshHop } from '../../../lib/connection';
import { execRemote, remoteWhich, shellQuote } from '../../net/ssh';
import type { JobChild } from '../../jobs/types';
import type { StderrParser, StructureMode, ToolContext, ToolRunResult } from './tools';
import {
  ByteCounter,
  DefinerStripper,
  mongoParser,
  mysqlDumpParser,
  pgParser,
  resolveOutputPath,
  splitLines,
} from './tools';

// ---------------------------------------------------------------------------
// Probing (§8.4 "probe first and fall back to the local path")
// ---------------------------------------------------------------------------

/** `LC_*` is the prefix stock sshd forwards (`AcceptEnv LANG LC_*`). */
const PW_VAR = 'LC_DBADMIN_PW';
const PROBE_VAR = 'LC_DBADMIN_PROBE';
/** Written to stderr by the remote command so a `| gzip` cannot hide a failure. */
const RC_SENTINEL = '__DBADMIN_RC';
const RC_RE = /__DBADMIN_RC=(-?\d+)/;

export type RemoteCompressor = 'zstd' | 'gzip' | 'none';

export interface RemoteCapabilities {
  /** Tool name → absolute path on the remote host. */
  tools: Record<string, string>;
  /** Tool name → first line of `--version` on the remote host. */
  versions: Record<string, string>;
  /** True when sshd forwarded our `LC_*` variable, i.e. secrets can travel. */
  envPassthrough: boolean;
  /** Best compressor present remotely. */
  compressor: RemoteCompressor;
}

const COMPRESSORS: readonly string[] = ['gzip', 'zstd'];

/**
 * One round trip that answers everything: does the env var arrive, which tools
 * exist, and what version are they. Four separate `ssh` calls would cost four
 * handshakes on exactly the link §8.4 exists to spare.
 */
function probeCommand(tools: readonly string[]): string {
  const list = tools.map(shellQuote).join(' ');
  return (
    `printf 'PROBE %s\\n' "\${${PROBE_VAR}:-}"; ` +
    `for t in ${list}; do ` +
    `p=$(command -v "$t" 2>/dev/null) && { ` +
    `printf 'TOOL %s %s\\n' "$t" "$p"; ` +
    `v=$("$p" --version 2>/dev/null | head -n 1) && printf 'VER %s %s\\n' "$t" "$v"; ` +
    `}; done; exit 0`
  );
}

async function captureRemote(
  hops: SshHop[],
  command: string,
  opts: { secrets?: (string | null)[]; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const exec = await execRemote(hops, command, { secrets: opts.secrets, env: opts.env });
  let stdout = '';
  exec.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8');
  });
  const exit = await exec.exit;
  return { code: exit.code, stdout, stderr: exit.stderr };
}

/** Probe the remote host for the tools a dump would need (§8.4). */
export async function probeRemote(
  hops: SshHop[],
  tools: readonly string[],
  opts: { secrets?: (string | null)[] } = {},
): Promise<RemoteCapabilities> {
  const token = randomBytes(8).toString('hex');
  const wanted = [...new Set([...tools, ...COMPRESSORS])];
  const { stdout } = await captureRemote(hops, probeCommand(wanted), {
    secrets: opts.secrets,
    env: { [PROBE_VAR]: token },
  });

  const caps: RemoteCapabilities = { tools: {}, versions: {}, envPassthrough: false, compressor: 'none' };
  for (const line of stdout.split('\n')) {
    const probe = /^PROBE (\S*)$/.exec(line.trim());
    if (probe) {
      caps.envPassthrough = probe[1] === token;
      continue;
    }
    const tool = /^TOOL (\S+) (.+)$/.exec(line.trim());
    if (tool) {
      caps.tools[tool[1]] = tool[2].trim();
      continue;
    }
    const version = /^VER (\S+) (.+)$/.exec(line.trim());
    if (version) caps.versions[version[1]] = version[2].trim();
  }
  caps.compressor = caps.tools.zstd ? 'zstd' : caps.tools.gzip ? 'gzip' : 'none';
  return caps;
}

/** Slow path used when only one answer is needed (`remoteWhich` from §8.2). */
export async function remoteToolPath(
  hops: SshHop[],
  tool: string,
  opts: { secrets?: (string | null)[] } = {},
): Promise<string | null> {
  return remoteWhich(hops, tool, { secrets: opts.secrets });
}

export type RemotePlan =
  | { ok: true; tool: string; remotePath: string; compressor: RemoteCompressor; capabilities: RemoteCapabilities }
  | { ok: false; reason: string; capabilities?: RemoteCapabilities };

export interface RemotePlanRequest {
  hops: SshHop[];
  secrets?: (string | null)[];
  tool: string;
  /** True when the dump cannot authenticate without a password. */
  needsPassword: boolean;
  /** Forced off for MySQL definer stripping, which has to decompress locally. */
  compressor?: RemoteCompressor;
  capabilities?: RemoteCapabilities;
}

/**
 * Decide whether the dump can run remotely. Every "no" carries a reason the
 * jobs drawer can show, because falling back silently to the slow path is how
 * people conclude the feature does not work.
 */
export async function planRemoteDump(req: RemotePlanRequest): Promise<RemotePlan> {
  if (req.hops.length === 0) {
    return { ok: false, reason: 'the connection does not use SSH, so there is no remote host to dump on' };
  }
  let caps: RemoteCapabilities;
  try {
    caps = req.capabilities ?? (await probeRemote(req.hops, [req.tool], { secrets: req.secrets }));
  } catch (err) {
    return { ok: false, reason: `the remote probe failed: ${(err as Error).message}` };
  }
  const remotePath = caps.tools[req.tool];
  if (!remotePath) {
    return { ok: false, reason: `${req.tool} is not installed on the remote host`, capabilities: caps };
  }
  if (req.needsPassword && !caps.envPassthrough) {
    return {
      ok: false,
      reason:
        `the remote sshd does not forward ${PW_VAR}, and this connection needs a password. ` +
        'Add `AcceptEnv LC_*` to the remote sshd_config, or use a credentials file on that host — ' +
        'embedding the password in the SSH command would expose it in the remote `ps` output',
      capabilities: caps,
    };
  }
  return {
    ok: true,
    tool: req.tool,
    remotePath,
    compressor: pickCompressor(caps, req.compressor),
    capabilities: caps,
  };
}

/** Honour the caller's preference, falling back to whatever the host has. */
function pickCompressor(caps: RemoteCapabilities, wanted: RemoteCompressor | undefined): RemoteCompressor {
  const requested = wanted ?? caps.compressor;
  if (requested === 'none') return 'none';
  return caps.tools[requested] ? requested : caps.compressor;
}

// ---------------------------------------------------------------------------
// Command assembly
// ---------------------------------------------------------------------------

function compressorCommand(compressor: RemoteCompressor, level: number): string | null {
  switch (compressor) {
    // -1 as in §8.4's example: on a slow link the bottleneck is the wire, not
    // the ratio, and level 1 keeps a busy production box out of it.
    case 'gzip':
      return `gzip -${level}`;
    case 'zstd':
      return `zstd -${level} -T0 -c`;
    case 'none':
      return null;
  }
}

/**
 * Wrap the dump so a failure cannot be swallowed by the compressor's exit code.
 * `set -o pipefail` is not POSIX, so the status is echoed to stderr and checked
 * on our side.
 */
function pipeWithStatus(dumpCommand: string, compressor: string | null): string {
  const guarded = `{ ${dumpCommand}; echo "${RC_SENTINEL}=$?" >&2; }`;
  return compressor ? `${guarded} | ${compressor}` : guarded;
}

/** Connection flags for a tool that will run on the remote host. */
function mysqlRemoteAddressArgs(address: Address): string[] {
  if (address.kind === 'unix') return ['--socket', address.socketPath];
  if (address.kind === 'tcp') return ['--host', address.host, '--port', String(address.port), '--protocol=TCP'];
  throw new Error(`A ${address.kind} address cannot be dumped with mysqldump.`);
}

function pgRemoteAddressArgs(address: Address): string[] {
  if (address.kind === 'tcp') return ['-h', address.host, '-p', String(address.port)];
  if (address.kind === 'unix') return ['-h', address.socketPath];
  if (address.kind === 'uri') {
    const url = new URL(address.uri);
    const args: string[] = [];
    if (url.hostname) args.push('-h', decodeURIComponent(url.hostname));
    if (url.port) args.push('-p', url.port);
    return args;
  }
  throw new Error(`A ${address.kind} address cannot be dumped with pg_dump.`);
}

// ---------------------------------------------------------------------------
// Running one remote dump
// ---------------------------------------------------------------------------

export interface RemoteDumpResult extends ToolRunResult {
  /** Always true here; lets the job result say where the work happened. */
  remote: true;
  /** The compressor the remote host applied, for the jobs drawer. */
  compressor: RemoteCompressor;
}

interface RemoteRunRequest {
  hops: SshHop[];
  secrets?: (string | null)[];
  password?: string;
  tool: string;
  command: string;
  compressor: RemoteCompressor;
  outPath: string;
  /** Applied to the incoming bytes before they hit the file. */
  stages?: () => Transform[];
  parser?: StderrParser;
  ctx: ToolContext;
}

async function runRemoteDump(req: RemoteRunRequest): Promise<RemoteDumpResult> {
  const started = Date.now();
  const outAbs = await resolveOutputPath(req.outPath);
  if (req.ctx.signal?.aborted) throw new Error(`${req.tool} was cancelled before it started.`);

  const env: Record<string, string> = {};
  if (req.password) env[PW_VAR] = req.password;

  req.ctx.log(`[${req.tool}] running on the remote host over SSH (§8.4)`);
  const exec = await execRemote(req.hops, req.command, { secrets: req.secrets, env });

  // §7.3: cancel must kill the remote command, not just close our end.
  const child: JobChild = {
    pid: null,
    kill: () => {
      void exec.close();
      return true;
    },
  };
  req.ctx.registerChild?.(child);
  req.ctx.onCancel?.(async () => {
    await exec.close();
  });
  const onAbort = (): void => {
    void exec.close();
  };
  req.ctx.signal?.addEventListener('abort', onAbort, { once: true });

  // Held in an object: it is assigned from a stderr callback, and a plain `let`
  // would be narrowed to `null` by control-flow analysis at the checks below.
  const remote: { status: number | null } = { status: null };
  exec.stderr.on(
    'data',
    splitLines((line) => {
      const m = RC_RE.exec(line);
      if (m) {
        remote.status = Number.parseInt(m[1], 10);
        return;
      }
      req.ctx.log(`[${req.tool}@remote] ${line}`);
      const p = req.parser?.(line);
      if (p?.phase) req.ctx.progress?.({ phase: p.phase });
    }),
  );

  let bytesOut = 0;
  const counter = new ByteCounter((total) => {
    bytesOut = total;
    req.ctx.progress?.({ bytesOut: total });
  });

  try {
    await pipeline([
      exec.stdout,
      ...(req.stages?.() ?? []),
      counter,
      createWriteStream(outAbs, { mode: 0o600 }),
    ]);
    const exit = await exec.exit;
    if (remote.status === null) {
      throw new Error(
        `The remote ${req.tool} did not report an exit status (ssh exit ${exit.code ?? 'unknown'}). ` +
          `Treating the dump as failed rather than keeping a possibly truncated file.${
            exit.stderr ? `\n${exit.stderr.trim()}` : ''
          }`,
      );
    }
    if (remote.status !== 0) {
      throw new Error(
        `Remote ${req.tool} exited with status ${remote.status}.${exit.stderr ? `\n${exit.stderr.trim()}` : ''}`,
      );
    }
    return {
      tool: req.tool,
      binPath: req.tool,
      argv: [],
      exitCode: 0,
      signal: null,
      stderrTail: exit.stderr,
      bytesOut,
      durationMs: Date.now() - started,
      outputPath: outAbs,
      remote: true,
      compressor: req.compressor,
    };
  } finally {
    req.ctx.signal?.removeEventListener('abort', onAbort);
    await exec.close();
  }
}

// ---------------------------------------------------------------------------
// Per-engine remote dumps
// ---------------------------------------------------------------------------

export interface RemoteDumpBase {
  hops: SshHop[];
  sshSecrets?: (string | null)[];
  /**
   * The address as CONFIGURED, not the tunnel entrance: the dump runs on the
   * far side, so it dials the database the way that host sees it (§8.1/§8.4).
   */
  address: Address;
  username?: string;
  password?: string;
  outPath: string;
  compressor?: RemoteCompressor;
  compressionLevel?: number;
  /** Reuse a probe the caller already paid for. */
  plan?: Extract<RemotePlan, { ok: true }>;
}

export interface RemoteMysqlDumpOptions extends RemoteDumpBase {
  scope: { kind: 'database'; database: string; tables?: string[] } | { kind: 'server' };
  structure: StructureMode;
  singleTransaction?: boolean;
  skipLockTables?: boolean;
  includeRoutines?: boolean;
  /** §7.5. Costs a local decompress/recompress — see below. */
  stripDefiner?: boolean;
}

/**
 * A plan the caller already probed is reused, but its compressor is re-derived:
 * the caller probed before knowing (say) that definer stripping needs gzip, and
 * decompressing a zstd stream we cannot read would corrupt the dump.
 */
async function resolvePlan(
  req: RemotePlanRequest,
  provided: Extract<RemotePlan, { ok: true }> | undefined,
): Promise<Extract<RemotePlan, { ok: true }>> {
  if (provided) {
    return { ...provided, compressor: pickCompressor(provided.capabilities, req.compressor) };
  }
  const plan = await planRemoteDump(req);
  if (!plan.ok) throw new Error(`Cannot dump on the remote host: ${plan.reason}.`);
  return plan;
}

export async function remoteMysqlDump(
  opts: RemoteMysqlDumpOptions,
  ctx: ToolContext,
): Promise<RemoteDumpResult> {
  // Definer stripping rewrites the SQL text, which we can only do on bytes we
  // can read — so the remote side must use gzip (which we can undo in-process)
  // rather than zstd, and we recompress after stripping to keep the file small.
  const wanted: RemoteCompressor | undefined = opts.stripDefiner
    ? opts.compressor === 'none'
      ? 'none'
      : 'gzip'
    : opts.compressor;
  const plan = await resolvePlan(
    {
      hops: opts.hops,
      secrets: opts.sshSecrets,
      tool: 'mysqldump',
      needsPassword: Boolean(opts.password),
      compressor: wanted,
    },
    opts.plan,
  );

  const args: string[] = [...mysqlRemoteAddressArgs(opts.address)];
  if (opts.username) args.push('--user', opts.username);
  if (opts.singleTransaction !== false) args.push('--single-transaction');
  if (opts.skipLockTables !== false) args.push('--skip-lock-tables');
  args.push('--hex-blob', '--default-character-set=utf8mb4', '--no-tablespaces', '--verbose');
  if (opts.structure === 'structure-only') args.push('--no-data');
  if (opts.structure === 'data-only') args.push('--no-create-info', '--skip-triggers');
  if (opts.structure !== 'data-only' && opts.includeRoutines !== false) {
    args.push('--routines', '--triggers', '--events');
  }
  if (opts.scope.kind === 'server') args.push('--all-databases');
  else if (opts.scope.tables?.length) args.push(opts.scope.database, ...opts.scope.tables);
  else args.push('--databases', opts.scope.database);

  // MYSQL_PWD is read from the environment we forwarded; the command string
  // itself only names the variable (§7.2 applied to the remote host).
  const prefix = opts.password ? `MYSQL_PWD="$${PW_VAR}" ` : '';
  const dump = `${prefix}${shellQuote(plan.remotePath)} ${args.map(shellQuote).join(' ')}`;
  const command = pipeWithStatus(dump, compressorCommand(plan.compressor, opts.compressionLevel ?? 1));

  const stages = opts.stripDefiner
    ? (): Transform[] =>
        plan.compressor === 'gzip'
          ? [createGunzip(), new DefinerStripper(), createGzip({ level: opts.compressionLevel ?? 6 })]
          : [new DefinerStripper()]
    : undefined;

  return runRemoteDump({
    hops: opts.hops,
    secrets: opts.sshSecrets,
    password: opts.password,
    tool: 'mysqldump',
    command,
    compressor: plan.compressor,
    outPath: opts.outPath,
    stages,
    parser: mysqlDumpParser,
    ctx,
  });
}

export interface RemotePgDumpOptions extends RemoteDumpBase {
  database: string;
  format: 'custom' | 'plain';
  structure: StructureMode;
  noOwner?: boolean;
  noPrivileges?: boolean;
  schemas?: string[];
  tables?: string[];
  /** §7.2's rule, checked against the REMOTE pg_dump's version. */
  serverMajor?: number | null;
}

export async function remotePgDump(opts: RemotePgDumpOptions, ctx: ToolContext): Promise<RemoteDumpResult> {
  const plan = await resolvePlan(
    {
      hops: opts.hops,
      secrets: opts.sshSecrets,
      tool: 'pg_dump',
      needsPassword: Boolean(opts.password),
      // A custom-format dump is already compressed; a second pass would only
      // burn CPU on the production host.
      compressor: opts.format === 'custom' ? 'none' : opts.compressor,
    },
    opts.plan,
  );

  // §7.2: pg_dump must be at least as new as the server. Remotely we cannot
  // choose a different binary, so this one is a refusal — the caller falls back
  // to the local path, where §10.1's extra client majors can satisfy the rule.
  const remoteVersion = plan.capabilities.versions.pg_dump;
  const remoteMajor = remoteVersion ? Number.parseInt(/(\d+)/.exec(remoteVersion)?.[1] ?? '', 10) : NaN;
  if (opts.serverMajor && Number.isFinite(remoteMajor) && remoteMajor < opts.serverMajor) {
    throw new Error(
      `The remote pg_dump is ${remoteMajor} but the server is ${opts.serverMajor}; a dump taken with an older ` +
        'pg_dump is silently broken (§7.2). Falling back to the local pg_dump.',
    );
  }

  const args: string[] = [...pgRemoteAddressArgs(opts.address)];
  if (opts.username) args.push('-U', opts.username);
  args.push('-d', opts.database, '-v');
  args.push(opts.format === 'custom' ? '-Fc' : '-Fp');
  if (opts.noOwner !== false) args.push('--no-owner');
  if (opts.noPrivileges !== false) args.push('--no-privileges');
  if (opts.structure === 'structure-only') args.push('--schema-only');
  if (opts.structure === 'data-only') args.push('--data-only');
  for (const schema of opts.schemas ?? []) args.push('-n', schema);
  for (const table of opts.tables ?? []) args.push('-t', table);

  const prefix = opts.password ? `PGPASSWORD="$${PW_VAR}" ` : '';
  const dump = `${prefix}${shellQuote(plan.remotePath)} ${args.map(shellQuote).join(' ')}`;
  const command = pipeWithStatus(dump, compressorCommand(plan.compressor, opts.compressionLevel ?? 1));

  return runRemoteDump({
    hops: opts.hops,
    secrets: opts.sshSecrets,
    password: opts.password,
    tool: 'pg_dump',
    command,
    compressor: plan.compressor,
    outPath: opts.outPath,
    parser: pgParser,
    ctx,
  });
}

export interface RemoteMongoDumpOptions extends RemoteDumpBase {
  database?: string;
  collection?: string;
  authSource?: string;
  /** mongodump compresses its own archive; the pipe stays uncompressed. */
  gzip?: boolean;
}

/**
 * The Mongo tools have no password environment variable, so the remote shell
 * writes the forwarded secret into a 0600 file with `printf` (a shell builtin —
 * the value never becomes a process argument) and removes it on any exit.
 */
function mongoConfigPrologue(): { pre: string; post: string; file: string } {
  const file = '"$DBADMIN_CFG"';
  const pre =
    'umask 077; DBADMIN_CFG=$(mktemp) || exit 90; ' +
    `trap 'rm -f "$DBADMIN_CFG"' EXIT HUP INT TERM; ` +
    `{ printf 'password: "'; printf '%s' "$${PW_VAR}" | sed 's/[\\\\"]/\\\\&/g'; printf '"\\n'; } > "$DBADMIN_CFG"; `;
  return { pre, post: '; rm -f "$DBADMIN_CFG"', file };
}

export async function remoteMongoDump(
  opts: RemoteMongoDumpOptions,
  ctx: ToolContext,
): Promise<RemoteDumpResult> {
  if (opts.password && /[\r\n]/.test(opts.password)) {
    // The YAML scalar the remote shell writes cannot hold a raw newline.
    throw new Error('This password contains a newline, which the remote mongodump config cannot carry.');
  }
  if (opts.address.kind === 'uri' && (/\/\/[^@/]+@/.test(opts.address.uri) || opts.password)) {
    // mongodump rejects --uri alongside credential flags, and re-assembling a
    // percent-encoded URI inside a remote shell is not worth the risk. The
    // local path (which puts the whole URI in a 0600 config) handles this.
    throw new Error(
      'A credentialed mongodb:// URI cannot be dumped remotely; the local mongodump handles it safely (§8.4).',
    );
  }
  const plan = await resolvePlan(
    {
      hops: opts.hops,
      secrets: opts.sshSecrets,
      tool: 'mongodump',
      needsPassword: Boolean(opts.password),
      compressor: 'none', // --gzip does it better, per collection stream
    },
    opts.plan,
  );

  const args: string[] = [];
  if (opts.address.kind === 'tcp') {
    args.push('--host', opts.address.host, '--port', String(opts.address.port));
  } else if (opts.address.kind === 'unix') {
    args.push('--host', opts.address.socketPath);
  } else if (opts.address.kind === 'uri') {
    // A URI may carry credentials; the remote command must not show them.
    args.push('--uri', opts.address.uri.replace(/^([a-zA-Z0-9+.-]+:\/\/)[^@/]*@/, '$1'));
  }
  if (opts.username && opts.address.kind !== 'uri') args.push('--username', opts.username);
  if (opts.authSource && opts.address.kind !== 'uri') args.push('--authenticationDatabase', opts.authSource);
  if (opts.database) args.push('--db', opts.database);
  if (opts.collection) args.push('--collection', opts.collection);
  args.push('--archive');
  if (opts.gzip !== false) args.push('--gzip');

  const wrapper = opts.password ? mongoConfigPrologue() : null;
  const dumpArgs = [...args.map(shellQuote)];
  if (wrapper) dumpArgs.push(`--config=${wrapper.file}`);
  const dump = `${shellQuote(plan.remotePath)} ${dumpArgs.join(' ')}`;
  const guarded = pipeWithStatus(dump, null);
  const command = wrapper ? `${wrapper.pre}${guarded}${wrapper.post}` : guarded;

  return runRemoteDump({
    hops: opts.hops,
    secrets: opts.sshSecrets,
    password: opts.password,
    tool: 'mongodump',
    command,
    compressor: 'none',
    outPath: opts.outPath,
    parser: mongoParser,
    ctx,
  });
}
