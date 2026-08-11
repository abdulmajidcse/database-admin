/**
 * Validation for the `ConnectionInput` contract (PLAN §4 + §5).
 *
 * Hand-written rather than schema-generated because the shape is two tagged
 * unions — WHERE the database is (`Address`) and HOW you reach it (`Access`) —
 * and the error messages are the whole point: "port must be 1-65535" beats a
 * generic 500 out of a driver ten seconds later.
 *
 * Two semantics are load-bearing and preserved exactly:
 *   - `password: undefined` (key absent) means "leave the stored secret alone";
 *     `password: null` means "clear it" (§5 update semantics, store/db.ts).
 *   - Nothing here ever echoes a secret back; these functions only parse.
 */

import type {
  Access,
  Address,
  ConnectionInput,
  ConnectionOptions,
  EnvTag,
  SshHop,
  TlsConfig,
  TlsVerifyMode,
} from '@/lib/connection';
import { addressIsLoopback, LOOPBACK_HOSTS } from '@/lib/connection';
import type { EngineKind } from '@/lib/schema-model';
import { IS_CONTAINER, loopbackAdvice } from '@/server/config';
import { asRecord, badRequest } from './respond';

type FileAddress = Extract<Address, { kind: 'file' }>;
type ProcessAccess = Extract<Access, { via: 'process' }>;

const ENGINES: readonly EngineKind[] = ['mysql', 'mariadb', 'postgres', 'sqlite', 'redis', 'mongodb'];
const ENV_TAGS: readonly EnvTag[] = ['dev', 'staging', 'prod'];
const TLS_VERIFY: readonly TlsVerifyMode[] = ['verify-full', 'require', 'skip'];
const SSH_AUTH: readonly SshHop['auth'][] = ['agent', 'password', 'key'];

/** `testConnection` accepts an id so it can fall back on the stored secrets. */
export interface TestConnectionInputBody extends ConnectionInput {
  id?: string;
}

export function parseConnectionInput(value: unknown): ConnectionInput {
  const b = asRecord(value);

  const input: ConnectionInput = {
    name: str(b, 'name'),
    engine: enumOf(b.engine, ENGINES, 'engine'),
    address: parseAddress(b.address),
    access: parseAccess(b.access),
    username: optStr(b, 'username'),
    tls: parseTls(b.tls),
    options: parseOptions(b.options),
    readOnly: optBool(b, 'readOnly') ?? false,
    envTag: b.envTag === undefined ? 'dev' : enumOf(b.envTag, ENV_TAGS, 'envTag'),
    color: optStr(b, 'color'),
    sortOrder: optNum(b, 'sortOrder') ?? 0,
  };

  // Only attach `password` when the client actually sent the key: its absence
  // is meaningful on update.
  if ('password' in b) {
    const p = b.password;
    if (p !== null && typeof p !== 'string') throw badRequest('"password" must be a string or null.');
    input.password = p;
  }
  if ('sshSecrets' in b && b.sshSecrets !== undefined && b.sshSecrets !== null) {
    if (!Array.isArray(b.sshSecrets)) throw badRequest('"sshSecrets" must be an array.');
    input.sshSecrets = b.sshSecrets.map((s: unknown, i: number) => {
      if (s === null || s === undefined) return null;
      if (typeof s !== 'string') throw badRequest(`"sshSecrets[${i}]" must be a string or null.`);
      return s;
    });
  }

  if (input.access.via === 'ssh' && input.address.kind === 'file') {
    throw badRequest('A SQLite file is opened locally; an SSH tunnel cannot carry it (PLAN §8.2).');
  }
  return input;
}

export function parseTestConnectionInput(value: unknown): TestConnectionInputBody {
  const b = asRecord(value);
  const input = parseConnectionInput(value) as TestConnectionInputBody;
  const id = optStr(b, 'id');
  if (id) input.id = id;
  return input;
}

// ---------------------------------------------------------------------------
// Address × Access
// ---------------------------------------------------------------------------

function parseAddress(value: unknown): Address {
  const a = asRecord(value, '"address"');
  const kind = enumOf(a.kind, ['tcp', 'unix', 'file', 'uri'] as const, 'address.kind');
  switch (kind) {
    case 'tcp':
      return { kind, host: str(a, 'host', 'address.host'), port: parsePort(a.port, 'address.port') };

    case 'unix':
      return { kind, socketPath: str(a, 'socketPath', 'address.socketPath') };

    case 'file': {
      const address: FileAddress = {
        kind,
        path: str(a, 'path', 'address.path'),
        mode: a.mode === undefined ? 'rw' : enumOf(a.mode, ['rw', 'ro'] as const, 'address.mode'),
      };
      if (a.attach !== undefined && a.attach !== null) {
        if (!Array.isArray(a.attach)) throw badRequest('"address.attach" must be an array.');
        address.attach = a.attach.map((entry: unknown, i: number) => {
          const e = asRecord(entry, `"address.attach[${i}]"`);
          return {
            alias: str(e, 'alias', `address.attach[${i}].alias`),
            path: str(e, 'path', `address.attach[${i}].path`),
          };
        });
      }
      return address;
    }

    case 'uri':
      return { kind, uri: str(a, 'uri', 'address.uri') };
  }
}

function parseAccess(value: unknown): Access {
  // Omitting `access` entirely is the overwhelmingly common case.
  if (value === undefined || value === null) return { via: 'direct' };
  const a = asRecord(value, '"access"');
  const via = enumOf(a.via, ['direct', 'ssh', 'process'] as const, 'access.via');

  if (via === 'direct') return { via };

  if (via === 'ssh') {
    if (!Array.isArray(a.hops) || a.hops.length === 0) {
      throw badRequest('"access.hops" must list at least one SSH hop (the bastion chain, PLAN §8.1).');
    }
    return { via, hops: a.hops.map((h: unknown, i: number) => parseHop(h, i)) };
  }

  if (!Array.isArray(a.argv) || a.argv.length === 0) {
    throw badRequest('"access.argv" must be a non-empty command line for the proxy process.');
  }
  const access: ProcessAccess = {
    via,
    argv: a.argv.map((part: unknown, i: number) => {
      if (typeof part !== 'string') throw badRequest(`"access.argv[${i}]" must be a string.`);
      return part;
    }),
  };
  const readyPattern = optStr(a, 'readyPattern');
  if (readyPattern !== undefined) access.readyPattern = readyPattern;
  const readyTimeoutMs = optNum(a, 'readyTimeoutMs');
  if (readyTimeoutMs !== undefined) access.readyTimeoutMs = readyTimeoutMs;
  return access;
}

function parseHop(value: unknown, index: number): SshHop {
  const h = asRecord(value, `"access.hops[${index}]"`);
  const hop: SshHop = {
    host: str(h, 'host', `access.hops[${index}].host`),
    port: h.port === undefined ? 22 : parsePort(h.port, `access.hops[${index}].port`),
    username: str(h, 'username', `access.hops[${index}].username`),
    auth: enumOf(h.auth, SSH_AUTH, `access.hops[${index}].auth`),
  };
  const keyPath = optStr(h, 'privateKeyPath');
  if (keyPath !== undefined) hop.privateKeyPath = keyPath;
  const hasPassphrase = optBool(h, 'keyHasPassphrase');
  if (hasPassphrase !== undefined) hop.keyHasPassphrase = hasPassphrase;
  const configHost = optStr(h, 'sshConfigHost');
  if (configHost !== undefined) hop.sshConfigHost = configHost;
  if (hop.auth === 'key' && !hop.privateKeyPath && !hop.sshConfigHost) {
    throw badRequest(
      `"access.hops[${index}]" uses key auth, so it needs a privateKeyPath (a path inside the container, §10.4) or an ~/.ssh/config host.`,
    );
  }
  return hop;
}

function parseTls(value: unknown): TlsConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const t = asRecord(value, '"tls"');
  const tls: TlsConfig = {
    enabled: optBool(t, 'enabled') ?? true,
    verify: t.verify === undefined ? 'verify-full' : enumOf(t.verify, TLS_VERIFY, 'tls.verify'),
  };
  for (const field of ['caCert', 'clientCert', 'clientKey', 'serverName'] as const) {
    const v = optStr(t, field);
    if (v !== undefined) tls[field] = v;
  }
  return tls;
}

function parseOptions(value: unknown): ConnectionOptions {
  if (value === undefined || value === null) return {};
  const o = asRecord(value, '"options"');
  const options: ConnectionOptions = {};
  for (const field of ['database', 'defaultSchema', 'authSource', 'replicaSet'] as const) {
    const v = optStr(o, field);
    if (v !== undefined) options[field] = v;
  }
  for (const field of ['connectTimeoutMs', 'statementTimeoutMs', 'poolSize', 'redisDb'] as const) {
    const v = optNum(o, field);
    if (v !== undefined) options[field] = v;
  }
  const compress = optBool(o, 'compress');
  if (compress !== undefined) options.compress = compress;

  if (o.driverOptions !== undefined && o.driverOptions !== null) {
    const d = asRecord(o.driverOptions, '"options.driverOptions"');
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw badRequest(`"options.driverOptions.${k}" must be a string, number or boolean.`);
      }
      out[k] = v;
    }
    options.driverOptions = out;
  }
  return options;
}

// ---------------------------------------------------------------------------
// §10.3 — the container networking hint
// ---------------------------------------------------------------------------

/**
 * The actionable advice for an address that cannot work from inside a
 * container. §10.3 calls the `localhost` case "the single most confusing
 * failure the app produces", so a failed test or connect names the fix instead
 * of handing back a bare ECONNREFUSED.
 *
 * Returns undefined outside a container, where both cases are perfectly fine.
 */
export function containerAddressHint(address: Address): string | undefined {
  if (!IS_CONTAINER) return undefined;
  if (address.kind === 'unix') {
    return (
      'This app runs in a container, and Docker Desktop does not proxy a macOS host\'s unix socket. ' +
      'Unix sockets work only when the app and the database are both on Linux or both in containers ' +
      'sharing a volume — otherwise connect over TCP to host.docker.internal.'
    );
  }
  const host = loopbackHostOf(address);
  return host ? (loopbackAdvice(host) ?? undefined) : undefined;
}

function loopbackHostOf(address: Address): string | null {
  if (address.kind === 'tcp') return addressIsLoopback(address) ? address.host : null;
  if (address.kind !== 'uri') return null;
  try {
    // mongodb:// and redis:// parse fine; brackets come off IPv6 literals.
    const host = new URL(address.uri).hostname.replace(/^\[|\]$/g, '');
    return host && LOOPBACK_HOSTS.has(host.toLowerCase()) ? host : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function str(obj: Record<string, unknown>, field: string, label = field): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw badRequest(`"${label}" is required and must be a non-empty string.`);
  }
  return v;
}

function optStr(obj: Record<string, unknown>, field: string): string | undefined {
  const v = obj[field];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw badRequest(`"${field}" must be a string.`);
  return v;
}

function optBool(obj: Record<string, unknown>, field: string): boolean | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw badRequest(`"${field}" must be true or false.`);
  return v;
}

function optNum(obj: Record<string, unknown>, field: string): number | undefined {
  const v = obj[field];
  if (v === undefined || v === null || v === '') return undefined;
  // Number-shaped strings are accepted: a form field is a string until it isn't.
  if (typeof v !== 'number' && typeof v !== 'string') throw badRequest(`"${field}" must be a number.`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`"${field}" must be a number.`);
  return n;
}

function parsePort(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw badRequest(`"${label}" must be a whole number between 1 and 65535.`);
  }
  return n;
}

function enumOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`"${label}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}
