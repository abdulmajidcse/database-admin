/**
 * Connection configuration (PLAN §4 + §8).
 *
 * Two orthogonal unions: WHERE the database is (`Address`) and HOW you reach it
 * (`Access`). A flat {host, port, user, password} shape breaks on SQLite files,
 * unix sockets and mongodb+srv:// URIs — so it is modelled properly from day one.
 *
 * Shared client/server. No secrets ever live in these objects: passwords are
 * held encrypted in the vault and referenced by connection id.
 */

import type { EngineKind } from './schema-model';

export type Address =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'unix'; socketPath: string }
  | { kind: 'file'; path: string; mode: 'rw' | 'ro'; attach?: { alias: string; path: string }[] }
  | { kind: 'uri'; uri: string };

export interface SshHop {
  host: string;
  port: number;
  username: string;
  /** How to authenticate to THIS hop. */
  auth: 'agent' | 'password' | 'key';
  /** Path to a private key inside the container, e.g. /home/node/.ssh/id_ed25519. */
  privateKeyPath?: string;
  /** True when the key needs a passphrase; the passphrase lives in the vault. */
  keyHasPassphrase?: boolean;
  /** Resolve the rest of the settings from ~/.ssh/config under this alias. */
  sshConfigHost?: string;
}

export type Access =
  | { via: 'direct' }
  | { via: 'ssh'; hops: SshHop[] }
  | { via: 'process'; argv: string[]; readyPattern?: string; readyTimeoutMs?: number };

export type TlsVerifyMode = 'verify-full' | 'require' | 'skip';

export interface TlsConfig {
  enabled: boolean;
  verify: TlsVerifyMode;
  /** PEM contents or a path inside the container. */
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  /** Override the hostname checked against the certificate. */
  serverName?: string;
}

export type EnvTag = 'dev' | 'staging' | 'prod';

export interface ConnectionOptions {
  /** Default database/schema to open on connect. */
  database?: string;
  /** Postgres search_path / MySQL default schema. */
  defaultSchema?: string;
  /** Connect timeout in ms. */
  connectTimeoutMs?: number;
  /** Statement timeout in ms; 0 disables. */
  statementTimeoutMs?: number;
  /** Pool ceiling. SQLite ignores this (one worker per connection). */
  poolSize?: number;
  /** Enable protocol compression — worth it on remote links only (§8.3). */
  compress?: boolean;
  /** Extra driver-specific key/values, passed through untouched. */
  driverOptions?: Record<string, string | number | boolean>;
  /** Redis database index / Mongo auth source. */
  redisDb?: number;
  authSource?: string;
  replicaSet?: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  engine: EngineKind;
  address: Address;
  access: Access;
  username?: string;
  /** True when a secret is stored in the vault. The secret itself never leaves the server. */
  hasPassword: boolean;
  tls?: TlsConfig;
  options: ConnectionOptions;
  readOnly: boolean;
  envTag: EnvTag;
  color?: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** What the client sends when creating/updating; secrets are write-only. */
export interface ConnectionInput extends Omit<ConnectionConfig, 'id' | 'hasPassword' | 'createdAt' | 'updatedAt'> {
  password?: string | null;
  /** Passphrases for SSH keys, indexed by hop. */
  sshSecrets?: (string | null)[];
}

export const DEFAULT_PORTS: Record<EngineKind, number> = {
  mysql: 3306,
  mariadb: 3306,
  postgres: 5432,
  sqlite: 0,
  redis: 6379,
  mongodb: 27017,
};

export const ENGINE_LABELS: Record<EngineKind, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  redis: 'Redis',
  mongodb: 'MongoDB',
};

/** Workspace UI mode, chosen from the connector's capabilities. */
export type WorkspaceMode = 'sql' | 'keyvalue' | 'document';

export function workspaceModeFor(engine: EngineKind): WorkspaceMode {
  if (engine === 'redis') return 'keyvalue';
  if (engine === 'mongodb') return 'document';
  return 'sql';
}

/** Hosts that mean "this container", which is never what the user wants (§10.3). */
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export function addressIsLoopback(address: Address): boolean {
  return address.kind === 'tcp' && LOOPBACK_HOSTS.has(address.host.toLowerCase());
}

export function describeAddress(address: Address): string {
  switch (address.kind) {
    case 'tcp':
      return `${address.host}:${address.port}`;
    case 'unix':
      return address.socketPath;
    case 'file':
      return address.path;
    case 'uri':
      return redactUri(address.uri);
  }
}

/** Strip credentials before an address is shown or logged. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/([^@/]+)@/, (_m, creds: string) => {
    const user = creds.split(':')[0];
    return `//${user}:***@`;
  });
}
