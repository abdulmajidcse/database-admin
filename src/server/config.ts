/**
 * Runtime configuration and container awareness (PLAN §10).
 *
 * Every path here is a CONTAINER path. The UI must show which host directory a
 * mount maps to, because "/data/sqlite" means nothing to someone looking at
 * their Mac (§10.4).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** True when we are running inside a container — changes networking advice. */
export const IS_CONTAINER: boolean =
  existsSync('/.dockerenv') || process.env.DBADMIN_FORCE_CONTAINER === '1';

export const CONFIG = {
  /** Everything the app owns lives in one directory you can back up or delete. */
  home: env('DBADMIN_HOME', path.join(homedir(), '.dbadmin')),
  /** Root the SQLite file browser is confined to. */
  sqliteRoot: env('DBADMIN_SQLITE_ROOT', IS_CONTAINER ? '/data/sqlite' : path.join(homedir(), 'sqlite')),
  /** Root exports may be written to — enforced server-side (§7.2). */
  exportRoot: env('DBADMIN_EXPORT_ROOT', IS_CONTAINER ? '/data/exports' : path.join(homedir(), 'dbadmin-exports')),
  port: Number(env('PORT', '3456')),
  host: env('HOST', IS_CONTAINER ? '0.0.0.0' : '127.0.0.1'),
  /** Rows returned before we hand back a cursor instead. */
  defaultPageSize: Number(env('DBADMIN_PAGE_SIZE', '500')),
  /** Schema cache TTL; longer on slow links (§8.3). */
  schemaCacheTtlMs: Number(env('DBADMIN_SCHEMA_TTL_MS', String(10 * 60 * 1000))),
  /** Idle pool timeout, below the usual 5-minute NAT window (§8.3). */
  poolIdleMs: Number(env('DBADMIN_POOL_IDLE_MS', String(4 * 60 * 1000))),
  sshDir: env('DBADMIN_SSH_DIR', path.join(homedir(), '.ssh')),
  /**
   * Extra hostnames the Host/Origin gate accepts, comma-separated (§9). This is
   * how you put the app behind a reverse proxy: name the hostname the proxy
   * serves. A leading `*.` matches labels beneath a suffix.
   */
  allowedHosts: env('DBADMIN_ALLOWED_HOSTS', '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== ''),
  /** Disable the auth/CSRF token — only for tests. */
  disableAuth: process.env.DBADMIN_DISABLE_AUTH === '1',
  isDev: process.env.NODE_ENV !== 'production',
} as const;

export const paths = {
  appDb: () => path.join(CONFIG.home, 'app.db'),
  /** Usernames + login verifiers (§9.2). No vault key is stored here. */
  accountsFile: () => path.join(CONFIG.home, 'accounts.json'),
  /** Pre-multi-user single account, read once at migration time. */
  legacyAccountFile: () => path.join(CONFIG.home, 'account.json'),
  /**
   * One vault per user: connections are private, so each user's secrets are
   * encrypted under a key only their own password derives (§9.3).
   */
  vaultMeta: (userId: string) => path.join(CONFIG.home, `vault-${userId}.json`),
  /** The single-user vault, renamed onto the first user during migration. */
  legacyVaultMeta: () => path.join(CONFIG.home, 'vault.json'),
  tmp: () => path.join(CONFIG.home, 'tmp'),
};

/**
 * A container's `localhost` is the container, not the user's machine (§10.3).
 * This is the single most confusing failure the app can produce, so we detect
 * it and offer the fix rather than letting the connection just refuse.
 */
export function loopbackAdvice(host: string): string | null {
  if (!IS_CONTAINER) return null;
  const h = host.toLowerCase();
  if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return null;
  return (
    'This app runs in a container, so "' +
    host +
    '" points at the container itself — not at your machine. ' +
    'Use host.docker.internal for a database on the host, or the service name for another container.'
  );
}

/** Confine a user-supplied path to an allowed root (§7.2). */
export function resolveWithin(root: string, candidate: string): string {
  const abs = path.resolve(root, candidate);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the allowed directory (${root}): ${candidate}`);
  }
  return abs;
}
