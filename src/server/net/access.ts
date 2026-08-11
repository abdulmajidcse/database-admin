/**
 * The AccessResolver (PLAN §8.1 / §8.2).
 *
 * THE CORE RULE: connectors never know how they were reached. `resolve()`
 * returns a `ResolvedAddress` whose `.address` is already dialable — an SSH
 * tunnel has rewritten `db.internal:5432` into `127.0.0.1:<ephemeral>` before
 * the connector is ever constructed.
 *
 * This module owns tunnel lifecycle and refcounting (N connections share one
 * tunnel), health checks and teardown; port allocation lives in ./ports, the
 * transports in ./ssh and ./proxy.
 *
 * Server-side only. No React, no Next (PLAN §11).
 */

import type { Access, Address, ConnectionConfig, SshHop } from '../../lib/connection';
import { describeAddress } from '../../lib/connection';
import type { ConnectorEvent, ResolvedAddress } from '../db/types';
import { loopbackAdvice } from '../config';
import { probeTcp } from './ports';
import { ProxyProcess } from './proxy';
import type { ProxyEvent } from './proxy';
import { SshTunnel, hopChainKey, resolveHops } from './ssh';
import type { TunnelEvent } from './ssh';

/**
 * How long a tunnel with no users stays warm. Re-opening an SSH chain costs a
 * full handshake, and a reconnect storm (§8.3) would otherwise pay it per
 * connection.
 */
const IDLE_LINGER_MS = 30_000;

/** `lib.dom` is in the tsconfig, so setTimeout's return type is not portable. */
type TimerHandle = ReturnType<typeof setTimeout>;

function unrefTimer(timer: TimerHandle): void {
  (timer as { unref?: () => void }).unref?.();
}

export interface ResolveOptions {
  /** Tunnel/proxy state and notices, forwarded to the connection indicator. */
  onEvent?: (e: ConnectorEvent) => void;
}

interface Endpoint {
  host: string;
  port: number;
}

type Resource = { kind: 'ssh'; tunnel: SshTunnel } | { kind: 'process'; proxy: ProxyProcess };

interface Entry {
  key: string;
  resource: Resource;
  /** The dialable address this resource produces. */
  address: Address;
  description: string;
  refs: number;
  disposeTimer: TimerHandle | null;
  disposed: boolean;
  createdAt: number;
}

export interface AccessStat {
  key: string;
  kind: 'ssh' | 'process';
  refs: number;
  description: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

const URI_RE = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/(?:([^@/]*)@)?([^/?#]*)([\s\S]*)$/;

/** Ports the schemes we support default to when the URI omits one. */
const SCHEME_PORTS: Record<string, number> = {
  mongodb: 27017,
  postgres: 5432,
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  redis: 6379,
  rediss: 6379,
};

function splitHostPort(hostPart: string, defaultPort: number | undefined, uri: string): Endpoint {
  // IPv6 literals are bracketed: [::1]:5432
  if (hostPart.startsWith('[')) {
    const close = hostPart.indexOf(']');
    const host = hostPart.slice(1, close);
    const tail = hostPart.slice(close + 1);
    const port = tail.startsWith(':') ? Number.parseInt(tail.slice(1), 10) : defaultPort;
    if (!port) throw new Error(`Cannot tunnel ${describeUri(uri)}: no port in the URI and none implied by its scheme.`);
    return { host, port };
  }
  const colon = hostPart.lastIndexOf(':');
  if (colon > 0) {
    const port = Number.parseInt(hostPart.slice(colon + 1), 10);
    if (Number.isFinite(port)) return { host: hostPart.slice(0, colon), port };
  }
  if (!defaultPort) {
    throw new Error(`Cannot tunnel ${describeUri(uri)}: no port in the URI and none implied by its scheme.`);
  }
  return { host: hostPart, port: defaultPort };
}

function describeUri(uri: string): string {
  return uri.replace(/\/\/([^@/]+)@/, '//***@');
}

/**
 * What the last hop must connect to, and how to write the local entrance back
 * into the address. Only TCP-shaped addresses reach this.
 */
function tunnelTarget(address: Address): { endpoint: Endpoint; rewrite: (local: Endpoint) => Address } {
  if (address.kind === 'tcp') {
    return {
      endpoint: { host: address.host, port: address.port },
      rewrite: (local) => ({ kind: 'tcp', host: local.host, port: local.port }),
    };
  }
  if (address.kind !== 'uri') {
    throw new Error(`Address kind "${address.kind}" cannot be tunnelled.`);
  }
  const m = URI_RE.exec(address.uri);
  if (!m) throw new Error(`Cannot parse the URI ${describeUri(address.uri)}.`);
  const scheme = m[1];
  const credentials: string | undefined = m[2];
  const hostPart = m[3];
  const rest: string = m[4] ?? '';
  if (scheme.toLowerCase().endsWith('+srv')) {
    // A +srv URI expands via DNS SRV into several hosts and hands the driver a
    // replica set; one local port cannot stand in for that (§8.2 Atlas note).
    throw new Error(
      'mongodb+srv:// cannot be tunnelled: SRV expands to several hosts. Use a direct connection ' +
        '(with the Atlas IP allowlist) or a plain mongodb:// URI naming one host.',
    );
  }
  const hosts = hostPart.split(',').filter((h) => h.length > 0);
  if (hosts.length === 0) throw new Error(`The URI ${describeUri(address.uri)} names no host.`);
  if (hosts.length > 1) {
    throw new Error(
      `The URI ${describeUri(address.uri)} names ${hosts.length} hosts; a tunnel forwards exactly one. ` +
        'Point the connection at a single host, or connect directly.',
    );
  }
  const endpoint = splitHostPort(hosts[0], SCHEME_PORTS[scheme.toLowerCase()], address.uri);
  const credentialPrefix = credentials === undefined ? '' : `${credentials}@`;
  return {
    endpoint,
    rewrite: (local) => ({
      kind: 'uri',
      uri: `${scheme}://${credentialPrefix}${local.host}:${local.port}${rest}`,
    }),
  };
}

function passthrough(address: Address): ResolvedAddress {
  return {
    address,
    original: address,
    tunneled: false,
    release: async () => {
      /* nothing was allocated */
    },
  };
}

/** Advice the connection form shows when a container targets its own loopback (§10.3). */
export function accessAdvice(config: ConnectionConfig): string | null {
  if (config.access.via !== 'direct') return null;
  if (config.address.kind !== 'tcp') return null;
  return loopbackAdvice(config.address.host);
}

function proxyEventToConnectorEvent(e: ProxyEvent): ConnectorEvent | null {
  switch (e.type) {
    case 'state':
      switch (e.state) {
        case 'starting':
          return { type: 'state', state: 'connecting' };
        case 'ready':
          return { type: 'state', state: 'connected' };
        case 'restarting':
          return { type: 'state', state: 'reconnecting' };
        case 'stopped':
          return { type: 'state', state: 'closed' };
      }
      return null;
    case 'output':
      return { type: 'notice', message: e.line };
    case 'error':
      return { type: 'error', message: e.message };
  }
}

/** TunnelEvent is already ConnectorEvent-shaped; proxies need a small mapping. */
function subscribeResource(resource: Resource, sink: (e: ConnectorEvent) => void): () => void {
  if (resource.kind === 'ssh') {
    return resource.tunnel.subscribe((e: TunnelEvent) => sink(e));
  }
  return resource.proxy.subscribe((e: ProxyEvent) => {
    const mapped = proxyEventToConnectorEvent(e);
    if (mapped) sink(mapped);
  });
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export class AccessResolver {
  /** Keyed by transport identity, so N connections share one tunnel (§8.1). */
  private readonly entries = new Map<string, Promise<Entry>>();

  /**
   * Resolve `config.address` into something a driver can dial right now.
   * `secrets[i]` is the vault secret for SSH hop `i` (password, or the key's
   * passphrase) — see `connectionsRepo.sshSecrets()`.
   */
  async resolve(
    config: ConnectionConfig,
    secrets: Array<string | null>,
    opts: ResolveOptions = {},
  ): Promise<ResolvedAddress> {
    const original = config.address;
    const emit = opts.onEvent;

    // A SQLite file and a unix socket are not network endpoints: there is
    // nothing to forward (§8.2). Remote SQLite is an SFTP fetch in the transfer
    // layer, not a tunnel.
    if (original.kind === 'file' || original.kind === 'unix') {
      if (config.access.via !== 'direct') {
        emit?.({
          type: 'notice',
          message:
            original.kind === 'file'
              ? 'SQLite files are opened locally; the configured tunnel is not used. Copy the file over SFTP first for a remote database.'
              : 'Unix sockets are local by definition; the configured tunnel is not used.',
        });
      }
      return passthrough(original);
    }

    switch (config.access.via) {
      case 'direct': {
        const advice = loopbackAdvice(original.kind === 'tcp' ? original.host : '');
        if (advice) emit?.({ type: 'notice', message: advice });
        return passthrough(original);
      }
      case 'ssh':
        return this.resolveSsh(config, config.access.hops, secrets, emit);
      case 'process':
        return this.resolveProcess(config, config.access, emit);
      default: {
        const exhaustive: never = config.access;
        throw new Error(`Unsupported access mode: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private async resolveSsh(
    config: ConnectionConfig,
    hops: SshHop[],
    secrets: Array<string | null>,
    emit?: (e: ConnectorEvent) => void,
  ): Promise<ResolvedAddress> {
    const original = config.address;
    const { endpoint, rewrite } = tunnelTarget(original);
    // Resolving hops applies ~/.ssh/config and ProxyJump, so two connections
    // written differently but landing on the same chain still share a tunnel.
    const resolvedHops = resolveHops(hops, secrets);
    const key = `ssh|${hopChainKey(resolvedHops)}|${endpoint.host}:${endpoint.port}`;

    const entry = await this.acquire(key, async () => {
      emit?.({ type: 'state', state: 'connecting', message: `Opening SSH tunnel to ${endpoint.host}:${endpoint.port}` });
      const tunnel = await SshTunnel.open({ hops: resolvedHops, target: endpoint });
      return {
        key,
        resource: { kind: 'ssh' as const, tunnel },
        address: rewrite({ host: tunnel.localHost, port: tunnel.localPort }),
        description: tunnel.description,
        refs: 0,
        disposeTimer: null,
        disposed: false,
        createdAt: Date.now(),
      };
    });

    this.warnAboutTlsHostname(config, emit);
    return this.handleFor(entry, original, emit);
  }

  private async resolveProcess(
    config: ConnectionConfig,
    access: Extract<Access, { via: 'process' }>,
    emit?: (e: ConnectorEvent) => void,
  ): Promise<ResolvedAddress> {
    const original = config.address;
    // The proxy publishes the port the saved address already points at
    // (`kubectl port-forward 15432:5432` + address 127.0.0.1:15432), so the
    // address passes through unchanged — only its reachability is ours.
    const key = `process|${access.argv.join('\u0000')}|${access.readyPattern ?? ''}`;
    const probe = original.kind === 'tcp' ? { host: original.host, port: original.port } : undefined;

    const entry = await this.acquire(key, async () => {
      emit?.({ type: 'state', state: 'connecting', message: `Starting ${access.argv[0]}` });
      const proxy = await ProxyProcess.start({
        argv: access.argv,
        readyPattern: access.readyPattern,
        readyTimeoutMs: access.readyTimeoutMs,
        probe,
      });
      return {
        key,
        resource: { kind: 'process' as const, proxy },
        address: original,
        description: `${proxy.command} -> ${describeAddress(original)}`,
        refs: 0,
        disposeTimer: null,
        disposed: false,
        createdAt: Date.now(),
      };
    });

    return this.handleFor(entry, original, emit);
  }

  /**
   * Rewriting the host breaks certificate hostname checks unless the TLS config
   * pins the real name (§8.2 TLS paragraph).
   */
  private warnAboutTlsHostname(config: ConnectionConfig, emit?: (e: ConnectorEvent) => void): void {
    const tls = config.tls;
    if (!tls?.enabled || tls.verify !== 'verify-full' || tls.serverName) return;
    emit?.({
      type: 'notice',
      message:
        'This connection is tunnelled and verifies the certificate hostname. Set the TLS "server name" ' +
        'to the real database hostname, or the certificate check will fail against 127.0.0.1.',
    });
  }

  /** One handle per caller: `release()` is idempotent and decrements once. */
  private handleFor(entry: Entry, original: Address, emit?: (e: ConnectorEvent) => void): ResolvedAddress {
    const unsubscribe = emit ? subscribeResource(entry.resource, emit) : null;
    let released = false;
    return {
      address: entry.address,
      original,
      tunneled: true,
      release: async () => {
        if (released) return;
        released = true;
        unsubscribe?.();
        this.releaseEntry(entry);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Refcounting, health checks, teardown
  // -------------------------------------------------------------------------

  private async acquire(key: string, create: () => Promise<Entry>): Promise<Entry> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = this.entries.get(key);
      if (!pending) {
        const created = create();
        this.entries.set(key, created);
        try {
          const entry = await created;
          entry.refs++;
          return entry;
        } catch (err) {
          if (this.entries.get(key) === created) this.entries.delete(key);
          throw err;
        }
      }

      let entry: Entry;
      try {
        entry = await pending;
      } catch {
        // The creation we were waiting on failed; drop it and build our own.
        if (this.entries.get(key) === pending) this.entries.delete(key);
        continue;
      }

      // Cancel the idle teardown BEFORE the health check, so the timer cannot
      // fire while we are awaiting it.
      if (entry.disposeTimer) {
        clearTimeout(entry.disposeTimer);
        entry.disposeTimer = null;
      }
      if (!entry.disposed && (await this.isHealthy(entry)) && !entry.disposed) {
        entry.refs++;
        return entry;
      }

      // Dead: stop handing it out. Only tear it down if nobody still holds it —
      // its holders will release it themselves and reconnect through the new one.
      if (this.entries.get(key) === pending) this.entries.delete(key);
      if (entry.refs <= 0) await this.dispose(entry);
    }
    throw new Error(`Could not establish access via ${key.split('|')[0]} after 3 attempts.`);
  }

  private async isHealthy(entry: Entry): Promise<boolean> {
    if (entry.disposed) return false;
    if (entry.resource.kind === 'ssh') return entry.resource.tunnel.healthy();
    if (!entry.resource.proxy.healthy()) return false;
    // A live process is not proof the port survived; confirm cheaply.
    if (entry.address.kind === 'tcp') return probeTcp(entry.address.host, entry.address.port, 1_000);
    return true;
  }

  private releaseEntry(entry: Entry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.disposed) return;
    if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
    entry.disposeTimer = setTimeout(() => {
      entry.disposeTimer = null;
      void this.disposeIfIdle(entry);
    }, IDLE_LINGER_MS);
    unrefTimer(entry.disposeTimer);
  }

  private async disposeIfIdle(entry: Entry): Promise<void> {
    if (entry.refs > 0 || entry.disposed) return;
    const pending = this.entries.get(entry.key);
    if (pending) {
      try {
        if ((await pending) === entry) this.entries.delete(entry.key);
      } catch {
        this.entries.delete(entry.key);
      }
    }
    if (entry.refs > 0) return; // acquired while we were awaiting
    await this.dispose(entry);
  }

  private async dispose(entry: Entry): Promise<void> {
    if (entry.disposed) return;
    entry.disposed = true;
    if (entry.disposeTimer) {
      clearTimeout(entry.disposeTimer);
      entry.disposeTimer = null;
    }
    try {
      if (entry.resource.kind === 'ssh') await entry.resource.tunnel.close();
      else await entry.resource.proxy.close();
    } catch {
      /* teardown is best-effort */
    }
  }

  /** For a diagnostics view: what is currently held open and by how many users. */
  async stats(): Promise<AccessStat[]> {
    const out: AccessStat[] = [];
    for (const pending of this.entries.values()) {
      try {
        const entry = await pending;
        out.push({
          key: entry.key,
          kind: entry.resource.kind,
          refs: entry.refs,
          description: entry.description,
          createdAt: entry.createdAt,
        });
      } catch {
        /* a failed entry is not held open */
      }
    }
    return out;
  }

  /** Shutdown hook: drop every tunnel and proxy regardless of refcount. */
  async closeAll(): Promise<void> {
    const pendings = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      pendings.map(async (pending) => {
        try {
          await this.dispose(await pending);
        } catch {
          /* never opened */
        }
      }),
    );
  }
}

/** One resolver per process: refcounting only works if everyone shares it. */
export const accessResolver = new AccessResolver();
