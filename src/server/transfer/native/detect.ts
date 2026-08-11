/**
 * Native tool detection (PLAN §7.2 "Two engines, deliberately" + §10.1 "Image").
 *
 * §7.2 says to probe `PATH` at startup and record each binary's version, shown
 * in a Settings panel. Because the Docker image bakes every tool in (§10.1),
 * detection normally succeeds and the "tool not installed" branch only fires
 * when the app runs outside the container.
 *
 * The one rule with teeth: `pg_dump` must be **>=** the server's major version,
 * or the dump is silently broken. §10.1 ships several Postgres client majors
 * precisely so we can *satisfy* that rule by selecting the right binary rather
 * than refusing — that is what `pgDumpFor()` does.
 *
 * Server-side only. No React, no Next (PLAN §11).
 */

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { NativeToolsResponse } from '../../../lib/api-types';
import type { EngineKind } from '../../../lib/schema-model';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * The binaries §7.2 delegates to. `pg_dumpall` covers the §7.1 "Server: all
 * databases in one archive" level, and gzip/zstd are the compressors the
 * remote-side path pipes through (§8.4).
 */
export type NativeToolName =
  | 'mysqldump'
  | 'mysql'
  | 'pg_dump'
  | 'pg_dumpall'
  | 'pg_restore'
  | 'psql'
  | 'sqlite3'
  | 'mongodump'
  | 'mongorestore'
  | 'redis-cli'
  | 'gzip'
  | 'zstd';

export const NATIVE_TOOL_NAMES: readonly NativeToolName[] = [
  'mysqldump',
  'mysql',
  'pg_dump',
  'pg_dumpall',
  'pg_restore',
  'psql',
  'sqlite3',
  'mongodump',
  'mongorestore',
  'redis-cli',
  'gzip',
  'zstd',
];

/** Which binaries each engine's native dump/restore path needs (§7.2). */
export const ENGINE_TOOLS: Record<EngineKind, { dump: NativeToolName[]; restore: NativeToolName[] }> = {
  mysql: { dump: ['mysqldump'], restore: ['mysql'] },
  mariadb: { dump: ['mysqldump'], restore: ['mysql'] },
  postgres: { dump: ['pg_dump', 'pg_dumpall'], restore: ['pg_restore', 'psql'] },
  // §7.5: SQLite's best export is the online backup API, not the CLI — so the
  // `sqlite3` binary is genuinely optional here.
  sqlite: { dump: ['sqlite3'], restore: ['sqlite3'] },
  redis: { dump: ['redis-cli'], restore: [] },
  mongodb: { dump: ['mongodump'], restore: ['mongorestore'] },
};

export interface DetectedTool {
  name: NativeToolName;
  path: string | null;
  /** First line of `--version`, verbatim, for the Settings panel. */
  version: string | null;
  major: number | null;
  minor: number | null;
  patch: number | null;
  /** MariaDB ships its own `mysqldump` whose flags differ slightly (§7.5). */
  flavor?: 'mysql' | 'mariadb';
}

export interface PgInstall {
  major: number;
  binDir: string;
  /** Where we found it: a versioned directory, or plain `PATH`. */
  source: 'versioned' | 'path';
}

export interface NativeTools {
  detectedAt: number;
  tools: Record<NativeToolName, DetectedTool>;
  /** Every Postgres client install we can select from, ascending by major. */
  postgres: PgInstall[];
}

// ---------------------------------------------------------------------------
// PATH lookup
// ---------------------------------------------------------------------------

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `which`, without spawning one. POSIX only by design: the app runs on Linux in
 * the container and macOS in dev (§10.1), and PATHEXT semantics would just add a
 * branch nothing exercises.
 */
export function whichSync(name: string, extraDirs: readonly string[] = []): string | null {
  if (name.includes(path.sep)) return isExecutableFile(name) ? name : null;
  const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Version probing
// ---------------------------------------------------------------------------

const VERSION_TIMEOUT_MS = 5_000;
/** Matches `8.0.36`, `16.2`, `100.9.4`, `3.40.1` — the first one wins. */
const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/;

type TimerHandle = ReturnType<typeof setTimeout>;

function unrefTimer(timer: TimerHandle): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * A deliberately small environment for probes and, later, for the tools
 * themselves: nothing else the app holds (vault paths, tokens) has any business
 * inside a child that may log its own environment.
 */
export function minimalEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    // NODE_ENV is required by Next's ProcessEnv augmentation.
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    TMPDIR: process.env.TMPDIR,
    // Stable, parseable tool output regardless of the host locale.
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) base[k] = v;
  }
  return base;
}

function probeVersionLine(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      // argv array, never a shell string (§7.2).
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: minimalEnv() });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null);
    }, VERSION_TIMEOUT_MS);
    unrefTimer(timer);
    // Some tools print the version to stderr; take whichever we get.
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const first = out.split('\n').find((l) => l.trim().length > 0);
      finish(first ? first.trim() : null);
    });
  });
}

function parseVersion(line: string | null): Pick<DetectedTool, 'major' | 'minor' | 'patch'> {
  if (!line) return { major: null, minor: null, patch: null };
  const m = VERSION_RE.exec(line);
  if (!m) return { major: null, minor: null, patch: null };
  return {
    major: Number.parseInt(m[1], 10),
    minor: Number.parseInt(m[2], 10),
    patch: m[3] === undefined ? null : Number.parseInt(m[3], 10),
  };
}

// ---------------------------------------------------------------------------
// Postgres client installs (§10.1 ships more than one major)
// ---------------------------------------------------------------------------

/**
 * Where distributions park versioned Postgres client binaries. The Debian
 * layout is the one that matters — it is what §10.1's image produces — but
 * matching the RHEL and Homebrew layouts costs two lines and makes the same
 * selection logic work in dev.
 */
const PG_INSTALL_ROOTS: readonly { root: string; entry: RegExp }[] = [
  { root: '/usr/lib/postgresql', entry: /^(\d+)(?:\.\d+)?$/ }, // Debian/Ubuntu (§10.1)
  { root: '/usr', entry: /^pgsql-(\d+)$/ }, // RHEL/Rocky
  { root: '/opt/homebrew/opt', entry: /^postgresql@(\d+)$/ }, // macOS, Apple Silicon
  { root: '/usr/local/opt', entry: /^postgresql@(\d+)$/ }, // macOS, Intel
];

let pgInstallCache: PgInstall[] | null = null;

function scanVersionedPgInstalls(): PgInstall[] {
  const found: PgInstall[] = [];
  for (const { root, entry } of PG_INSTALL_ROOTS) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = entry.exec(name);
      if (!m) continue;
      const binDir = path.join(root, name, 'bin');
      if (!isExecutableFile(path.join(binDir, 'pg_dump'))) continue;
      found.push({ major: Number.parseInt(m[1], 10), binDir, source: 'versioned' });
    }
  }
  return found;
}

/**
 * The `PATH` pg_dump, whose major we can only learn by asking it. `spawnSync`
 * blocks the event loop, which is acceptable exactly once at startup: the
 * result is cached and `pgDumpFor()` has to be synchronous for callers that are
 * already mid-argv-construction.
 */
function scanPathPgInstall(): PgInstall | null {
  const bin = whichSync('pg_dump');
  if (!bin) return null;
  const out = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: VERSION_TIMEOUT_MS,
    env: minimalEnv(),
  });
  const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
  const parsed = parseVersion(text.split('\n').find((l) => l.trim().length > 0) ?? null);
  if (parsed.major === null) return null;
  return { major: parsed.major, binDir: path.dirname(bin), source: 'path' };
}

/** Every usable Postgres client install, ascending by major. Cached. */
export function pgInstalls(): PgInstall[] {
  if (pgInstallCache) return pgInstallCache;
  const byDir = new Map<string, PgInstall>();
  for (const install of scanVersionedPgInstalls()) byDir.set(install.binDir, install);
  const onPath = scanPathPgInstall();
  if (onPath && !byDir.has(onPath.binDir)) byDir.set(onPath.binDir, onPath);
  pgInstallCache = [...byDir.values()].sort((a, b) => a.major - b.major);
  return pgInstallCache;
}

export type PgBinaryName = 'pg_dump' | 'pg_dumpall' | 'pg_restore' | 'psql';

/**
 * Select a Postgres client binary that is at least as new as the server.
 *
 * Picks the SMALLEST sufficient major: an exact match when we ship one, which
 * keeps the dump's feature set aligned with the server instead of emitting
 * newer syntax the source database never uses.
 */
export function pgBinaryFor(name: PgBinaryName, serverMajor: number): string | null {
  for (const install of pgInstalls()) {
    if (install.major < serverMajor) continue;
    const bin = path.join(install.binDir, name);
    if (isExecutableFile(bin)) return bin;
  }
  return null;
}

/**
 * §7.2's version rule, satisfied by selection rather than refusal (§10.1).
 * Returns null when every installed `pg_dump` is older than the server — the
 * caller must then refuse with a clear message instead of writing a broken dump.
 */
export function pgDumpFor(serverMajor: number): string | null {
  return pgBinaryFor('pg_dump', serverMajor);
}

/** Newest install of a Postgres binary; used when the server major is unknown. */
export function pgNewest(name: PgBinaryName): string | null {
  const installs = pgInstalls();
  for (let i = installs.length - 1; i >= 0; i--) {
    const bin = path.join(installs[i].binDir, name);
    if (isExecutableFile(bin)) return bin;
  }
  return whichSync(name);
}

/** The majors we can dump with, for the "no new enough pg_dump" error message. */
export function pgAvailableMajors(): number[] {
  return pgInstalls().map((i) => i.major);
}

/** `16.4`, `17.2 (Debian…)`, `160004` — anything a server reports. */
export function parseServerMajor(version: string | null | undefined): number | null {
  if (!version) return null;
  const trimmed = version.trim();
  // Postgres `server_version_num` is 160004 → major 16 (100000+ since PG 10).
  if (/^\d{6}$/.test(trimmed)) return Math.floor(Number.parseInt(trimmed, 10) / 10000);
  const m = /(\d+)/.exec(trimmed);
  return m ? Number.parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// The detection cache
// ---------------------------------------------------------------------------

let cache: NativeTools | null = null;
let inFlight: Promise<NativeTools> | null = null;

function emptyTool(name: NativeToolName): DetectedTool {
  return { name, path: null, version: null, major: null, minor: null, patch: null };
}

async function detectOne(name: NativeToolName): Promise<DetectedTool> {
  const bin = whichSync(name);
  if (!bin) return emptyTool(name);
  const version = await probeVersionLine(bin);
  const tool: DetectedTool = { name, path: bin, version, ...parseVersion(version) };
  if ((name === 'mysqldump' || name === 'mysql') && version) {
    tool.flavor = /mariadb/i.test(version) ? 'mariadb' : 'mysql';
  }
  return tool;
}

/**
 * Probe every tool once and cache the result (§7.2 "Still probe PATH at startup
 * and record versions"). Concurrent callers share one probe.
 */
export async function detectNativeTools(force = false): Promise<NativeTools> {
  if (!force && cache) return cache;
  if (!force && inFlight) return inFlight;
  const run = (async (): Promise<NativeTools> => {
    const detected = await Promise.all(NATIVE_TOOL_NAMES.map((n) => detectOne(n)));
    const tools = Object.fromEntries(detected.map((t) => [t.name, t])) as Record<NativeToolName, DetectedTool>;
    const result: NativeTools = { detectedAt: Date.now(), tools, postgres: pgInstalls() };
    cache = result;
    return result;
  })();
  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

/** Drop every cache; the Settings panel's "rescan" button. */
export async function refreshNativeTools(): Promise<NativeTools> {
  pgInstallCache = null;
  return detectNativeTools(true);
}

/** What detection found, or null when it has not run yet. */
export function nativeToolsSnapshot(): NativeTools | null {
  return cache;
}

/**
 * Path to a tool, from the cache when detection has run and straight from PATH
 * otherwise — spawn sites must not have to await startup.
 */
export function resolveToolPath(name: NativeToolName): string | null {
  const cached = cache?.tools[name];
  if (cached) return cached.path;
  return whichSync(name);
}

export function toolFlavor(name: NativeToolName): 'mysql' | 'mariadb' | undefined {
  return cache?.tools[name]?.flavor;
}

export function hasTool(name: NativeToolName): boolean {
  return resolveToolPath(name) !== null;
}

/** Message that tells the truth about §10.1 rather than just "not found". */
export function missingToolMessage(name: NativeToolName): string {
  return (
    `${name} was not found on PATH. The Docker image bakes every native dump tool in (§10.1), ` +
    'so this usually means the app is running outside the container — the built-in streaming ' +
    'engine will be used instead.'
  );
}

export function requireTool(name: NativeToolName): string {
  const bin = resolveToolPath(name);
  if (!bin) throw new Error(missingToolMessage(name));
  return bin;
}

/** Exactly the §7.2 Settings-panel payload. */
export function toolsResponse(): NativeToolsResponse {
  const snapshot = cache;
  const tools: NativeToolsResponse['tools'] = NATIVE_TOOL_NAMES.map((name) => ({
    name: name as string,
    path: snapshot ? snapshot.tools[name].path : whichSync(name),
    version: snapshot?.tools[name].version ?? null,
  }));
  // Versioned Postgres installs are the reason §7.2's version rule is
  // satisfiable at all, so surface them alongside the PATH binaries.
  for (const install of pgInstalls()) {
    if (install.source !== 'versioned') continue;
    tools.push({
      name: `pg_dump (${install.major})`,
      path: path.join(install.binDir, 'pg_dump'),
      version: `PostgreSQL ${install.major}`,
    });
  }
  return { tools };
}

/** One-line summary for the startup log. */
export function toolSummaryLine(t: NativeTools): string {
  const present = NATIVE_TOOL_NAMES.filter((n) => t.tools[n].path !== null);
  const missing = NATIVE_TOOL_NAMES.filter((n) => t.tools[n].path === null);
  const pg = pgAvailableMajors();
  return (
    `native tools: ${present.length}/${NATIVE_TOOL_NAMES.length} present` +
    (pg.length ? `; postgres clients ${pg.join(', ')}` : '') +
    (missing.length ? `; missing ${missing.join(', ')}` : '')
  );
}
