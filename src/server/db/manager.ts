/**
 * The ConnectionManager (PLAN §6 + §8.3).
 *
 * One process-wide owner for every live database link. It is deliberately the
 * only thing in the app that knows how to turn a saved `ConnectionConfig` into
 * an open `Connector`:
 *
 *   connectionsRepo ──▶ vault (decrypt) ──▶ AccessResolver ──▶ registry ──▶ Connector
 *
 * On top of that it owns the four things PLAN §6/§8.3 say a real client needs
 * and a demo skips:
 *
 *   1. Keep-alive + idle eviction, sized below the ~5-minute NAT window (§8.3).
 *   2. Auto-reconnect with exponential backoff and a visible per-connection
 *      state indicator (§8.3) — subscribers get every transition.
 *   3. A cancel registry (`runId → connector` + a per-run AbortController), so a
 *      cancel request finds the right link; closing a socket does not stop a
 *      server-side query (§6 "Query cancellation").
 *   4. A session registry for pinned transaction sessions, with an idle timeout
 *      so a forgotten tab cannot hold locks forever (§6 "Sessions vs pools").
 *
 * Server-side only: no React, no Next (PLAN §11).
 */

import { randomUUID } from 'node:crypto';

import type { ConnectionConfig, ConnectionInput } from '../../lib/connection';
import { describeAddress } from '../../lib/connection';
import type { ConnectionState, TestConnectionResponse } from '../../lib/api-types';
import type { ServerInfo, SessionInfo } from '../../lib/results';
import { CONFIG, IS_CONTAINER, loopbackAdvice } from '../config';
import { connectionsRepo } from '../store/db';
import { currentUserId, requireUserId, runAsUser } from '../context';
import { accessResolver } from '../net/access';
import { createConnector } from './registry';
import {
  DbError,
  isSqlConnector,
  type Connector,
  type ConnectorContext,
  type ConnectorEvent,
  type ResolvedAddress,
  type SqlConnector,
} from './types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** One timer drives keep-alive, idle eviction and session expiry. */
const SWEEP_MS = 15_000;

/**
 * §8.3: NAT boxes and firewalls silently drop idle flows, and some are far more
 * aggressive than the folklore 5 minutes. Ping a live-but-idle link well inside
 * `poolIdleMs` so the socket is proven (and refreshed) before the user needs it.
 */
const KEEPALIVE_MS = Math.max(15_000, Math.min(60_000, Math.floor(CONFIG.poolIdleMs / 4)));

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 8;

/**
 * §6: a pinned session may be sitting inside an open transaction holding locks.
 * It outlives the pool idle timeout (so an idle *session* keeps its connection
 * alive) but not by much.
 */
const SESSION_IDLE_MS = Math.max(CONFIG.poolIdleMs + 60_000, 5 * 60_000);

/** RTT above this counts as "remote" for adaptive defaults (§8.3). */
const REMOTE_RTT_MS = 40;

/** `lib.dom` is in the tsconfig, so setTimeout's return type is not portable. */
type TimerHandle = ReturnType<typeof setTimeout>;

function unrefTimer(timer: TimerHandle): void {
  (timer as { unref?: () => void }).unref?.();
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** What subscribers receive; matches the `connection-state` WebSocket message. */
export interface ConnectionStateEvent {
  connectionId: string;
  state: ConnectionState;
  message?: string;
  at: number;
}

export interface ConnectionStatus {
  connectionId: string;
  name: string;
  engine: ConnectionConfig['engine'];
  state: ConnectionState;
  /** When the current state began — drives "connected for 3m". */
  since: number;
  message?: string;
  /** Measured at connect time and refreshed by keep-alive pings (§8.3). */
  rttMs?: number;
  tunneled: boolean;
  serverVersion?: string;
  openSessions: number;
  activeRuns: number;
  lastUsedAt?: number;
}

/** Handle returned by `registerRun`; `done()` belongs in a `finally`. */
export interface RunHandle {
  runId: string;
  connectionId: string;
  signal: AbortSignal;
  done(): void;
}

/**
 * `testConnection` input. `id` is optional and only used to fall back on the
 * stored secrets when the form did not re-send them (the API never sends a
 * password back to the browser, §9.3).
 */
export interface TestConnectionInput extends ConnectionInput {
  id?: string;
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface Entry {
  id: string;
  config: ConnectionConfig;
  connector: Connector;
  resolved: ResolvedAddress;
  /** 'opening' entries are visible to the event handler but not to callers. */
  phase: 'opening' | 'live' | 'closing';
  openedAt: number;
  lastUsedAt: number;
  lastPingAt: number;
  pinging: boolean;
  serverInfo: ServerInfo | null;
  released: boolean;
}

interface StateRecord {
  state: ConnectionState;
  since: number;
  message?: string;
}

interface RunRecord {
  runId: string;
  connectionId: string;
  controller: AbortController;
  startedAt: number;
  detach?: () => void;
}

interface SessionRecord {
  info: SessionInfo;
  connectionId: string;
  lastUsedAt: number;
}

interface ReconnectRecord {
  attempt: number;
  timer: TimerHandle | null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function errorCode(err: unknown): string | undefined {
  if (err instanceof DbError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** ECONNREFUSED is the signature of §10.3's container-localhost mistake. */
function isConnectionRefused(err: unknown): boolean {
  const code = errorCode(err) ?? '';
  if (code === 'ECONNREFUSED') return true;
  return /ECONNREFUSED|connection refused/i.test(errorMessage(err));
}

// ---------------------------------------------------------------------------

export class ConnectionManager {
  /** Live and opening entries, one per connection id. */
  private readonly entries = new Map<string, Entry>();
  /** In-flight opens, so concurrent callers share one handshake. */
  private readonly opening = new Map<string, Promise<Entry>>();
  private readonly states = new Map<string, StateRecord>();
  private readonly listeners = new Set<(e: ConnectionStateEvent) => void>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly reconnects = new Map<string, ReconnectRecord>();
  /**
   * Who opened each pooled connection (§9.2). Pools outlive a single request,
   * so ownership cannot be checked only on the cold-open path — see entryFor().
   */
  private readonly owners = new Map<string, string>();
  /**
   * Last measured RTT per connection id. Kept across closes so the *next* open
   * already gets the right page size and compression (§8.3).
   */
  private readonly lastRtt = new Map<string, number>();
  private sweepTimer: TimerHandle | null = null;
  private shuttingDown = false;

  // -------------------------------------------------------------------------
  // State broadcasting (§8.3 "a visible connection-state indicator")
  // -------------------------------------------------------------------------

  subscribe(listener: (e: ConnectionStateEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(connectionId: string): ConnectionState {
    return this.states.get(connectionId)?.state ?? 'idle';
  }

  /** Everything the connection list needs in one call. */
  allStates(): Record<string, ConnectionState> {
    const out: Record<string, ConnectionState> = {};
    for (const [id, rec] of this.states) out[id] = rec.state;
    return out;
  }

  status(connectionId: string): ConnectionStatus | null {
    const config = connectionsRepo.get(connectionId);
    if (!config) return null;
    const rec = this.states.get(connectionId);
    const entry = this.entries.get(connectionId);
    return {
      connectionId,
      name: config.name,
      engine: config.engine,
      state: rec?.state ?? 'idle',
      since: rec?.since ?? 0,
      message: rec?.message,
      rttMs: this.lastRtt.get(connectionId),
      tunneled: entry?.resolved.tunneled ?? false,
      serverVersion: entry?.serverInfo?.version,
      openSessions: this.countSessions(connectionId),
      activeRuns: this.countRuns(connectionId),
      lastUsedAt: entry?.lastUsedAt,
    };
  }

  private setState(connectionId: string, state: ConnectionState, message?: string): void {
    const prev = this.states.get(connectionId);
    const sameState = prev?.state === state;
    // A repeated state with no new message is noise the UI would re-render for.
    if (sameState && (message === undefined || prev?.message === message)) return;
    const rec: StateRecord = {
      state,
      since: sameState && prev ? prev.since : Date.now(),
      message: message ?? (sameState ? prev?.message : undefined),
    };
    this.states.set(connectionId, rec);
    this.publish({ connectionId, state, message: rec.message, at: Date.now() });
  }

  /** A notice or driver error that does not change the state, but is worth showing. */
  private note(connectionId: string, message: string): void {
    this.setState(connectionId, this.getState(connectionId), message);
  }

  private publish(event: ConnectionStateEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never take the manager down.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Acquire / open
  // -------------------------------------------------------------------------

  /** The connector for a connection, opening it if necessary. */
  async acquire(connectionId: string): Promise<Connector> {
    const entry = await this.entryFor(connectionId);
    entry.lastUsedAt = Date.now();
    return entry.connector;
  }

  /** Same, but refuses engines without SQL so routes need no cast. */
  async acquireSql(connectionId: string): Promise<SqlConnector> {
    const connector = await this.acquire(connectionId);
    if (!isSqlConnector(connector)) {
      throw new DbError(`${connector.kind} is not a SQL engine.`, 'UNSUPPORTED_CAPABILITY');
    }
    return connector;
  }

  isOpen(connectionId: string): boolean {
    return this.entries.get(connectionId)?.phase === 'live';
  }

  /** Mark a connection as in use so idle eviction skips it (long exports). */
  touch(connectionId: string): void {
    const entry = this.entries.get(connectionId);
    if (entry) entry.lastUsedAt = Date.now();
  }

  /**
   * A pooled connection is a live handle to somebody's database, and the pool
   * is keyed by connection id alone. Without this check, any signed-in user who
   * knows an id gets whatever the owner left warm — the ownership check in
   * openEntry() only runs when there is nothing to reuse, so the leak appears
   * only after the owner has used the connection, which is exactly when it
   * matters. Compared in memory: no query, no cost on the hot path.
   */
  private assertOwned(connectionId: string): void {
    const owner = this.owners.get(connectionId);
    if (owner === undefined) return; // Not open yet; openEntry() does the check.
    if (owner !== currentUserId()) {
      throw new DbError(`No such connection: ${connectionId}`, 'NO_CONNECTION');
    }
  }

  private async entryFor(connectionId: string): Promise<Entry> {
    this.assertOwned(connectionId);
    const live = this.entries.get(connectionId);
    if (live && live.phase === 'live') {
      live.lastUsedAt = Date.now();
      return live;
    }
    const inflight = this.opening.get(connectionId);
    if (inflight) return inflight;

    const promise = this.openEntry(connectionId);
    this.opening.set(connectionId, promise);
    try {
      return await promise;
    } finally {
      if (this.opening.get(connectionId) === promise) this.opening.delete(connectionId);
    }
  }

  private async openEntry(connectionId: string): Promise<Entry> {
    const stored = connectionsRepo.get(connectionId);
    if (!stored) throw new DbError(`No such connection: ${connectionId}`, 'NO_CONNECTION');
    // Recorded before the handshake so every later acquire can be checked
    // against it without another read.
    this.owners.set(connectionId, requireUserId());
    const config = this.adaptForLatency(stored);

    this.setState(connectionId, 'connecting', describeAddress(config.address));

    // Secrets are decrypted here and nowhere else above the connector boundary;
    // a locked vault surfaces as a plain error the UI can act on (§9.3).
    let password: string | undefined;
    let secrets: (string | null)[] = [];
    try {
      password = config.hasPassword ? connectionsRepo.password(connectionId) : undefined;
      secrets = config.access.via === 'ssh' ? connectionsRepo.sshSecrets(connectionId) : [];
    } catch (err) {
      this.setState(connectionId, 'error', errorMessage(err));
      throw err;
    }

    let resolved: ResolvedAddress;
    try {
      // §8.1: the resolver hands back an address the driver can dial right now.
      resolved = await accessResolver.resolve(config, secrets, {
        onEvent: (e) => this.onAccessEvent(connectionId, e),
      });
    } catch (err) {
      this.setState(connectionId, 'error', errorMessage(err));
      throw err;
    }

    const ctx: ConnectorContext = {
      config,
      resolved,
      password,
      onEvent: (e) => this.onConnectorEvent(connectionId, e),
    };

    let connector: Connector;
    try {
      connector = createConnector(ctx);
    } catch (err) {
      await resolved.release().catch(() => undefined);
      this.setState(connectionId, 'error', errorMessage(err));
      throw err;
    }

    const entry: Entry = {
      id: connectionId,
      config,
      connector,
      resolved,
      phase: 'opening',
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
      lastPingAt: 0,
      pinging: false,
      serverInfo: null,
      released: false,
    };
    // Registered before open() so the connector's own state events are routed.
    this.entries.set(connectionId, entry);

    try {
      await connector.open();
    } catch (err) {
      entry.phase = 'closing';
      await this.disposeEntry(entry);
      const described = this.describeConnectError(err, config);
      this.setState(connectionId, 'error', described.hint ? `${described.message}\n\n${described.hint}` : described.message);
      throw err;
    }

    entry.phase = 'live';
    this.setState(connectionId, 'connected');
    this.clearReconnect(connectionId);

    // §8.3: measure RTT at connect time — it decides page size, schema TTL and
    // protocol compression. A ping that fails on privileges is not fatal.
    try {
      const info = await connector.ping();
      entry.serverInfo = info;
      entry.lastPingAt = Date.now();
      this.lastRtt.set(connectionId, info.rttMs);
      this.setState(connectionId, 'connected', info.version);
    } catch (err) {
      this.note(connectionId, `Connected, but the server probe failed: ${errorMessage(err)}`);
    }

    this.ensureSweep();
    return entry;
  }

  /**
   * §8.3: mysql2 protocol compression is a win on a slow link and a loss on a
   * local one, so it is decided from the previous measurement rather than left
   * to the user. An explicit setting always wins.
   */
  private adaptForLatency(config: ConnectionConfig): ConnectionConfig {
    if (config.engine !== 'mysql' && config.engine !== 'mariadb') return config;
    if (config.options.compress !== undefined) return config;
    const rtt = this.lastRtt.get(config.id);
    if (rtt === undefined || rtt < REMOTE_RTT_MS) return config;
    return { ...config, options: { ...config.options, compress: true } };
  }

  // -------------------------------------------------------------------------
  // Events from the connector and from the access layer
  // -------------------------------------------------------------------------

  private onConnectorEvent(connectionId: string, e: ConnectorEvent): void {
    if (e.type === 'notice') {
      this.note(connectionId, e.message);
      return;
    }
    if (e.type === 'error') {
      this.note(connectionId, e.message);
      return;
    }
    if (e.state !== 'closed') {
      // 'connecting' / 'connected' / 'reconnecting' are the connector's own
      // lifecycle (ioredis reconnects itself, the SQLite worker restarts) —
      // reflect them, do not act on them.
      this.setState(connectionId, e.state, e.message);
      return;
    }
    const entry = this.entries.get(connectionId);
    // A 'closed' during open() or during our own close() is expected; only a
    // live link going quiet is a dropped connection (§8.3).
    if (!entry || entry.phase !== 'live') return;
    this.onLinkLost(entry, e.message ?? 'The database closed the connection.');
  }

  /**
   * Tunnel/proxy events. A tunnel being up is NOT the database being up, so a
   * resolver 'connected' must not promote the indicator to connected.
   */
  private onAccessEvent(connectionId: string, e: ConnectorEvent): void {
    if (e.type !== 'state') {
      this.note(connectionId, e.message);
      return;
    }
    switch (e.state) {
      case 'connecting':
        this.setState(connectionId, 'connecting', e.message);
        return;
      case 'connected':
        if (e.message) this.note(connectionId, e.message);
        return;
      case 'reconnecting': {
        this.setState(connectionId, 'reconnecting', e.message ?? 'The tunnel is restarting.');
        return;
      }
      case 'closed': {
        const entry = this.entries.get(connectionId);
        if (entry && entry.phase === 'live') {
          this.onLinkLost(entry, e.message ?? 'The tunnel closed.');
        }
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Link loss and reconnect (§8.3 "Reconnect properly")
  // -------------------------------------------------------------------------

  private onLinkLost(entry: Entry, reason: string): void {
    if (entry.phase !== 'live') return;
    entry.phase = 'closing';
    this.setState(entry.id, 'reconnecting', reason);
    void this.recover(entry, reason);
  }

  private async recover(entry: Entry, reason: string): Promise<void> {
    const connectionId = entry.id;
    // Everything pinned to the dead link dies with it: in-flight runs get an
    // abort (their editor tab keeps its text and results — §8.3), and pinned
    // transactions cannot survive a new TCP connection.
    this.abortRuns(connectionId, new DbError(`The connection dropped: ${reason}`, 'CONNECTION_LOST'));
    this.forgetSessions(connectionId);
    await this.disposeEntry(entry);

    if (this.shuttingDown) {
      this.setState(connectionId, 'closed', reason);
      return;
    }
    // Reconnecting a link nobody has touched in a whole idle window would hold
    // a tunnel open for no one; the next acquire() reopens it instantly anyway.
    const recentlyUsed = Date.now() - entry.lastUsedAt < CONFIG.poolIdleMs;
    if (!recentlyUsed && this.countSessions(connectionId) === 0) {
      this.setState(connectionId, 'closed', reason);
      return;
    }
    this.scheduleReconnect(connectionId, reason);
  }

  private scheduleReconnect(connectionId: string, reason: string): void {
    if (this.shuttingDown) return;
    const rec = this.reconnects.get(connectionId) ?? { attempt: 0, timer: null };
    this.reconnects.set(connectionId, rec);
    if (rec.timer) return;
    if (rec.attempt >= RECONNECT_MAX_ATTEMPTS) {
      this.reconnects.delete(connectionId);
      this.setState(
        connectionId,
        'error',
        `${reason} Gave up after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts — reconnect manually when the server is back.`,
      );
      return;
    }
    // Exponential backoff with jitter, so a laptop waking up does not produce a
    // synchronized reconnect storm across every saved connection (§8.3).
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** rec.attempt);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    rec.attempt += 1;
    this.setState(
      connectionId,
      'reconnecting',
      `${reason} Retrying in ${Math.max(1, Math.round(delay / 1000))}s (attempt ${rec.attempt}).`,
    );
    rec.timer = setTimeout(() => {
      rec.timer = null;
      void this.attemptReconnect(connectionId, reason);
    }, delay);
    unrefTimer(rec.timer);
  }

  private async attemptReconnect(connectionId: string, reason: string): Promise<void> {
    if (this.shuttingDown) return;

    // A timer has no request context, so owner-scoped reads would throw. The
    // reconnect runs as whoever opened the connection — it is resuming their
    // work, not starting anyone else's.
    const owner = this.owners.get(connectionId);
    if (!owner) {
      this.reconnects.delete(connectionId);
      return;
    }

    await runAsUser({ userId: owner, username: '' }, async () => {
      if (!connectionsRepo.get(connectionId)) {
        this.reconnects.delete(connectionId);
        this.setState(connectionId, 'closed', 'The connection was deleted.');
        return;
      }
      try {
        await this.entryFor(connectionId);
        // openEntry() clears the record on success.
      } catch (err) {
        this.scheduleReconnect(connectionId, errorMessage(err) || reason);
      }
    });
  }

  private clearReconnect(connectionId: string): void {
    const rec = this.reconnects.get(connectionId);
    if (!rec) return;
    if (rec.timer) clearTimeout(rec.timer);
    this.reconnects.delete(connectionId);
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  /**
   * Close a connection and release its tunnel reference. Releasing here (and not
   * only inside the connectors) is what makes the resolver's refcount drop —
   * `release()` is idempotent, so a connector that already released is fine.
   */
  async close(connectionId: string, reason?: string): Promise<void> {
    this.clearReconnect(connectionId);
    // Let an in-flight open finish rather than leaking its socket and tunnel.
    const inflight = this.opening.get(connectionId);
    if (inflight) await inflight.catch(() => undefined);

    this.abortRuns(connectionId, new DbError('The connection was closed.', 'CONNECTION_CLOSED'));
    await this.closeSessionsFor(connectionId);

    const entry = this.entries.get(connectionId);
    if (entry) {
      entry.phase = 'closing';
      await this.disposeEntry(entry);
    }
    // Forget the recorded owner too: nothing is pooled any more, so the next
    // acquire must go through openEntry() and be checked against the store.
    this.owners.delete(connectionId);
    this.setState(connectionId, 'closed', reason);
    this.stopSweepIfIdle();
  }

  private async disposeEntry(entry: Entry): Promise<void> {
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    try {
      await entry.connector.close();
    } catch {
      // Teardown is best effort — the link may already be gone.
    }
    if (!entry.released) {
      entry.released = true;
      // §8.1: the resolver refcounts tunnels; every acquire must be matched.
      await entry.resolved.release().catch(() => undefined);
    }
  }

  /** Drop everything: used by the shutdown hook and by tests. */
  async closeAll(reason = 'Shutting down.'): Promise<void> {
    const ids = new Set([...this.entries.keys(), ...this.opening.keys()]);
    await Promise.all([...ids].map((id) => this.close(id, reason).catch(() => undefined)));
    this.stopSweep();
  }

  /**
   * Sign-out (§9.2): closes only the connections belonging to that user, so one
   * person signing out does not tear down another's open sessions. Their vault
   * key is gone by now, so anything left open would be unable to reconnect.
   */
  async closeAllFor(userId: string, reason = 'Signed out.'): Promise<void> {
    const ids = runAsUser({ userId, username: '' }, () => connectionsRepo.list().map((c) => c.id));
    await Promise.all(ids.map((id) => this.close(id, reason).catch(() => undefined)));
  }

  /** Process shutdown: connections first, then the tunnels behind them. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.closeAll();
    await accessResolver.closeAll().catch(() => undefined);
    this.shuttingDown = false;
  }

  // -------------------------------------------------------------------------
  // Sweep: keep-alive, idle eviction, session expiry (§8.3, §6)
  // -------------------------------------------------------------------------

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    unrefTimer(this.sweepTimer);
  }

  private stopSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private stopSweepIfIdle(): void {
    if (this.entries.size === 0 && this.sessions.size === 0) this.stopSweep();
  }

  private sweep(): void {
    const now = Date.now();

    // Expired pinned sessions first: closing one may free its connection for
    // eviction in this same pass.
    for (const [sessionId, rec] of [...this.sessions]) {
      if (now - rec.lastUsedAt <= SESSION_IDLE_MS) continue;
      this.note(
        rec.connectionId,
        `A pinned session was idle for ${Math.round(SESSION_IDLE_MS / 60_000)} minutes and was rolled back and closed.`,
      );
      void this.closeSession(sessionId).catch(() => undefined);
    }

    for (const entry of [...this.entries.values()]) {
      if (entry.phase !== 'live') continue;
      const busy = this.countRuns(entry.id) > 0 || this.countSessions(entry.id) > 0;
      const idleFor = now - entry.lastUsedAt;

      if (!busy && idleFor > CONFIG.poolIdleMs) {
        // §8.3: evict below the NAT window rather than handing the user a
        // half-dead socket the next time they click something.
        void this.close(
          entry.id,
          `Closed after ${Math.round(CONFIG.poolIdleMs / 60_000)} minutes idle. It reopens on the next query.`,
        ).catch(() => undefined);
        continue;
      }

      const quietFor = now - Math.max(entry.lastUsedAt, entry.lastPingAt);
      if (!entry.pinging && quietFor > KEEPALIVE_MS) void this.keepAlive(entry);
    }

    this.stopSweepIfIdle();
  }

  private async keepAlive(entry: Entry): Promise<void> {
    entry.pinging = true;
    try {
      const info = await entry.connector.ping();
      entry.serverInfo = info;
      entry.lastPingAt = Date.now();
      this.lastRtt.set(entry.id, info.rttMs);
    } catch (err) {
      // A failed keep-alive is exactly the dropped-idle-link case (§8.3).
      this.onLinkLost(entry, `Keep-alive failed: ${errorMessage(err)}`);
    } finally {
      entry.pinging = false;
    }
  }

  // -------------------------------------------------------------------------
  // Cancel registry (§6 "Query cancellation")
  // -------------------------------------------------------------------------

  /**
   * Register a run before executing it. The returned signal aborts on cancel,
   * on link loss and on close, so every layer below can bail out.
   */
  registerRun(connectionId: string, runId: string = randomUUID(), external?: AbortSignal): RunHandle {
    const controller = new AbortController();
    let detach: (() => void) | undefined;
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else {
        const onAbort = () => controller.abort(external.reason);
        external.addEventListener('abort', onAbort, { once: true });
        detach = () => external.removeEventListener('abort', onAbort);
      }
    }
    this.runs.set(runId, { runId, connectionId, controller, startedAt: Date.now(), detach });
    this.touch(connectionId);
    return {
      runId,
      connectionId,
      signal: controller.signal,
      done: () => this.finishRun(runId),
    };
  }

  finishRun(runId: string): void {
    const rec = this.runs.get(runId);
    if (!rec) return;
    rec.detach?.();
    this.runs.delete(runId);
    this.touch(rec.connectionId);
  }

  /** The literal `runId → connector` lookup a cancel request needs. */
  connectorForRun(runId: string): Connector | undefined {
    const rec = this.runs.get(runId);
    if (!rec) return undefined;
    const entry = this.entries.get(rec.connectionId);
    return entry?.phase === 'live' ? entry.connector : undefined;
  }

  /**
   * Cancel a run. Aborting the signal unwinds our own pipeline; the connector
   * additionally kills the statement server-side on a second connection —
   * closing a socket does not stop a running query (§6).
   */
  async cancel(runId: string): Promise<boolean> {
    const rec = this.runs.get(runId);
    if (!rec) return false;
    rec.controller.abort(new DbError('Cancelled.', 'CANCELLED'));
    const connector = this.connectorForRun(runId);
    if (connector && isSqlConnector(connector)) await connector.cancel(runId);
    return true;
  }

  /** Cancel every run on a connection, e.g. before closing it. */
  async cancelAll(connectionId: string): Promise<number> {
    const ids = [...this.runs.values()].filter((r) => r.connectionId === connectionId).map((r) => r.runId);
    for (const id of ids) await this.cancel(id).catch(() => undefined);
    return ids.length;
  }

  activeRuns(connectionId?: string): { runId: string; connectionId: string; startedAt: number }[] {
    return [...this.runs.values()]
      .filter((r) => connectionId === undefined || r.connectionId === connectionId)
      .map((r) => ({ runId: r.runId, connectionId: r.connectionId, startedAt: r.startedAt }));
  }

  private countRuns(connectionId: string): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.connectionId === connectionId) n++;
    return n;
  }

  private abortRuns(connectionId: string, reason: DbError): void {
    for (const rec of [...this.runs.values()]) {
      if (rec.connectionId !== connectionId) continue;
      rec.controller.abort(reason);
      rec.detach?.();
      this.runs.delete(rec.runId);
    }
  }

  // -------------------------------------------------------------------------
  // Session registry (§6 "Sessions vs pools")
  // -------------------------------------------------------------------------

  /** Pin a connection for transaction mode. */
  async openSession(connectionId: string): Promise<SessionInfo> {
    const connector = await this.acquireSql(connectionId);
    if (!connector.capabilities.has('transactions')) {
      throw new DbError(`${connector.kind} does not support transactions.`, 'UNSUPPORTED_CAPABILITY');
    }
    const info = await connector.openSession();
    this.sessions.set(info.id, { info, connectionId, lastUsedAt: Date.now() });
    this.ensureSweep();
    return info;
  }

  async closeSession(sessionId: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    this.sessions.delete(sessionId);
    const entry = this.entries.get(rec.connectionId);
    const connector = entry?.connector;
    // A dead link already took the session with it; nothing to close.
    if (!connector || !isSqlConnector(connector)) return;
    await connector.closeSession(sessionId).catch(() => undefined);
  }

  async sessionCommand(sessionId: string, cmd: 'begin' | 'commit' | 'rollback'): Promise<SessionInfo> {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new DbError(`No such session: ${sessionId}`, 'NO_SESSION');
    const connector = await this.acquireSql(rec.connectionId);
    await connector.sessionCommand(sessionId, cmd);
    rec.info = { ...rec.info, inTransaction: cmd === 'begin', autoCommit: cmd !== 'begin' };
    rec.lastUsedAt = Date.now();
    this.touch(rec.connectionId);
    return rec.info;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    const rec = this.sessions.get(sessionId);
    if (!rec) return undefined;
    // Any use of a session is a use of its connection: keep both alive.
    rec.lastUsedAt = Date.now();
    this.touch(rec.connectionId);
    return rec.info;
  }

  listSessions(connectionId?: string): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((r) => connectionId === undefined || r.connectionId === connectionId)
      .map((r) => r.info);
  }

  private countSessions(connectionId: string): number {
    let n = 0;
    for (const r of this.sessions.values()) if (r.connectionId === connectionId) n++;
    return n;
  }

  /** Ask the connector to roll back and release each session, then forget them. */
  private async closeSessionsFor(connectionId: string): Promise<void> {
    const ids = [...this.sessions.values()].filter((r) => r.connectionId === connectionId).map((r) => r.info.id);
    for (const id of ids) await this.closeSession(id).catch(() => undefined);
  }

  /** The link is already gone: drop the bookkeeping without touching the driver. */
  private forgetSessions(connectionId: string): void {
    for (const [id, rec] of [...this.sessions]) {
      if (rec.connectionId === connectionId) this.sessions.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Test connection (§10.3)
  // -------------------------------------------------------------------------

  /**
   * Open a throwaway connector, ping it, and close it. Never touches the cache,
   * so testing a connection cannot disturb a working one.
   */
  async testConnection(input: TestConnectionInput): Promise<TestConnectionResponse> {
    const config: ConnectionConfig = {
      id: input.id ?? `test-${randomUUID()}`,
      name: input.name,
      engine: input.engine,
      address: input.address,
      access: input.access,
      username: input.username,
      hasPassword: false,
      tls: input.tls,
      options: input.options,
      readOnly: input.readOnly,
      envTag: input.envTag,
      color: input.color,
      sortOrder: input.sortOrder,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // `password: undefined` on an existing connection means "unchanged", so fall
    // back to the vault; `null` means the user cleared it (§5 update semantics).
    let password: string | undefined;
    if (input.password === undefined && input.id) {
      try {
        password = connectionsRepo.password(input.id);
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    } else if (typeof input.password === 'string') {
      password = input.password;
    }
    config.hasPassword = password !== undefined;

    let secrets: (string | null)[] = input.sshSecrets ?? [];
    if (!input.sshSecrets && input.id && config.access.via === 'ssh') {
      try {
        secrets = connectionsRepo.sshSecrets(input.id);
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    }

    const notices: string[] = [];
    const collect = (e: ConnectorEvent) => {
      if (e.type !== 'state' && e.message) notices.push(e.message);
    };

    let resolved: ResolvedAddress | null = null;
    let connector: Connector | null = null;
    try {
      resolved = await accessResolver.resolve(config, secrets, { onEvent: collect });
      connector = createConnector({ config, resolved, password, onEvent: collect });
      await connector.open();
      const info = await connector.ping();
      // Remember the measurement: the first real connect then already gets the
      // right page size and compression (§8.3).
      if (input.id) this.lastRtt.set(input.id, info.rttMs);
      const hint = notices.length > 0 ? [...new Set(notices)].join('\n') : undefined;
      return { ok: true, info, hint };
    } catch (err) {
      const described = this.describeConnectError(err, config);
      const extra = notices.filter((n) => n !== described.hint);
      const hint = described.hint ?? (extra.length > 0 ? [...new Set(extra)].join('\n') : undefined);
      return { ok: false, error: described.message, hint };
    } finally {
      if (connector) await connector.close().catch(() => undefined);
      if (resolved) await resolved.release().catch(() => undefined);
    }
  }

  /**
   * §10.3: a container's `localhost` is the container. A refused loopback
   * connection from inside one is *almost always* that mistake, and it is the
   * single most confusing failure this app can produce — so we name the fix
   * instead of returning a bare ECONNREFUSED.
   */
  private describeConnectError(err: unknown, config: ConnectionConfig): { message: string; hint?: string } {
    const message = errorMessage(err);
    if (!IS_CONTAINER || !isConnectionRefused(err)) return { message };
    // A tunnel or proxy rewrites the address to 127.0.0.1 by design, so a
    // refusal there is a tunnel problem, not the container-loopback problem.
    if (config.access.via !== 'direct') return { message };
    const host = directHost(config);
    if (!host) return { message };
    const advice = loopbackAdvice(host);
    if (!advice) return { message };
    // Some connectors already append the advice themselves; do not say it twice.
    if (message.includes('host.docker.internal')) return { message };
    return { message, hint: advice };
  }

  // -------------------------------------------------------------------------
  // Adaptive defaults (§8.3 "Latency changes the design")
  // -------------------------------------------------------------------------

  /** Last measured round-trip latency, if this connection has ever been open. */
  rttFor(connectionId: string): number | undefined {
    return this.lastRtt.get(connectionId);
  }

  /**
   * Rows to materialize before handing back a cursor. Local links can afford a
   * big first page; on a 200 ms link a 500-row page is a visible stall, so the
   * first screen gets smaller and "fetch more" does the rest (§8.3).
   */
  suggestedPageSize(connectionId: string): number {
    const base = CONFIG.defaultPageSize;
    const rtt = this.lastRtt.get(connectionId);
    if (rtt === undefined) return base;
    let size: number;
    if (rtt < 2) size = base * 4; // in-process SQLite worker or a unix socket
    else if (rtt < 15) size = base;
    else if (rtt < 60) size = base / 2;
    else if (rtt < 200) size = base / 4;
    else size = base / 5;
    return Math.max(50, Math.round(size / 50) * 50);
  }

  /**
   * Schema cache TTL. Re-introspecting is a fixed number of queries (§8.3), but
   * on a slow link even a fixed number costs seconds — so remote schemas are
   * trusted for longer.
   */
  schemaTtl(connectionId: string): number {
    const base = CONFIG.schemaCacheTtlMs;
    const rtt = this.lastRtt.get(connectionId);
    if (rtt === undefined) return base;
    let ttl: number;
    if (rtt < 15) ttl = base;
    else if (rtt < 60) ttl = base * 2;
    else if (rtt < 200) ttl = base * 4;
    else ttl = base * 6;
    return Math.min(ttl, 60 * 60_000);
  }

  /** True when this link is remote enough to justify prefetching and compression. */
  isRemote(connectionId: string): boolean {
    const rtt = this.lastRtt.get(connectionId);
    return rtt !== undefined && rtt >= REMOTE_RTT_MS;
  }
}

/** The host a *direct* connection dials, for the §10.3 check. */
function directHost(config: ConnectionConfig): string | null {
  const address = config.address;
  if (address.kind === 'tcp') return address.host;
  if (address.kind !== 'uri') return null;
  try {
    // Node's URL handles mongodb:// and redis:// fine; credentials are ignored.
    return new URL(address.uri).hostname || null;
  } catch {
    return null;
  }
}

/** One manager per process: pools, cancel and session registries only work shared. */
export const connectionManager = new ConnectionManager();
