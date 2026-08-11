/**
 * Ephemeral local port allocation and TCP liveness probes (PLAN §8.1).
 *
 * "The resolver owns: ephemeral local port allocation, tunnel lifecycle and
 * refcounting, health checks, and teardown." This module is the first of those,
 * plus the probe primitive the health checks are built on.
 *
 * Server-side only. No React, no Next (PLAN §11 directory boundary).
 */

import net from 'node:net';

/**
 * Ports handed out but not yet bound by their real listener. The kernel happily
 * re-uses a just-closed port, so two back-to-back allocations can collide while
 * the caller is still awaiting an SSH handshake. Short-lived in-process
 * reservations close that window.
 */
const reservations = new Map<number, number>();
const RESERVE_MS = 30_000;
const MAX_ATTEMPTS = 32;

function sweepReservations(now: number): void {
  for (const [port, expiry] of reservations) {
    if (expiry <= now) reservations.delete(port);
  }
}

/** Bind port 0 on a throwaway server, read the assigned port, close it again. */
function bindEphemeral(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    // Never hold the process open just to pick a number.
    probe.unref();
    probe.once('error', (err: Error) => {
      probe.close();
      reject(err);
    });
    // `exclusive` keeps the OS from sharing the port with a cluster sibling.
    probe.listen({ host, port: 0, exclusive: true }, () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        probe.close();
        reject(new Error(`Could not determine an ephemeral port on ${host}`));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Allocate a free port on `host` (loopback by default — a tunnel entrance must
 * never be reachable from the LAN, PLAN §9.1).
 */
export async function allocatePort(host = '127.0.0.1'): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let port: number;
    try {
      port = await bindEphemeral(host);
    } catch (err) {
      lastError = err;
      continue;
    }
    const now = Date.now();
    sweepReservations(now);
    if (reservations.has(port)) continue;
    reservations.set(port, now + RESERVE_MS);
    return port;
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Could not allocate a local port on ${host}${detail}`);
}

/** Drop the reservation once the real listener owns the port (or gave up). */
export function releasePort(port: number): void {
  reservations.delete(port);
}

/** True when something is accepting connections at host:port right now. */
export function probeTcp(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect({ host, port });
  });
}

/**
 * Poll until host:port accepts, or the deadline passes. Used after a proxy
 * process reports ready — "ready" on stdout does not always mean "listening"
 * (PLAN §8.2, process proxy row).
 */
export async function waitForPort(
  host: string,
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) return false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (await probeTcp(host, port, Math.min(1_000, Math.max(200, remaining)))) return true;
    if (Date.now() + intervalMs >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
