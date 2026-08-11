/**
 * Browser WebSocket client: job progress, connection state, Redis MONITOR and
 * pub/sub, live process lists (PLAN §2).
 *
 * A single shared socket multiplexes every channel. It auto-reconnects and
 * re-subscribes, because a dropped socket must never silently stop the jobs
 * drawer from updating.
 */

'use client';

import type { ClientMessage, ServerMessage, WsChannel } from './api-types';

type Listener = (msg: ServerMessage) => void;

interface Subscription {
  channel: WsChannel;
  connectionId?: string;
  arg?: string;
}

function subKey(s: Subscription): string {
  return [s.channel, s.connectionId ?? '', s.arg ?? ''].join('|');
}

class WsClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subs = new Map<string, Subscription>();
  private refCounts = new Map<string, number>();
  private backoffMs = 500;
  private connecting = false;
  private queue: ClientMessage[] = [];

  private ensure(): void {
    if (typeof window === 'undefined') return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.connecting) return;
    this.connecting = true;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.connecting = false;
      this.backoffMs = 500;
      // No auth message: the session cookie travelled with the handshake and
      // the server verified it there, so the socket is ready on open (§9.2).
    };

    socket.onmessage = (ev: MessageEvent<string>) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        // Re-subscribe everything after a reconnect, then flush anything queued.
        for (const s of this.subs.values()) {
          socket.send(JSON.stringify({ type: 'subscribe', ...s } satisfies ClientMessage));
        }
        for (const m of this.queue.splice(0)) socket.send(JSON.stringify(m));
      }
      for (const l of this.listeners) l(msg);
    };

    const retry = () => {
      this.connecting = false;
      this.socket = null;
      const delay = Math.min(this.backoffMs, 15_000);
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
      setTimeout(() => this.ensure(), delay);
    };
    socket.onclose = retry;
    socket.onerror = () => socket.close();
  }

  private send(msg: ClientMessage): void {
    this.ensure();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    this.ensure();
    return () => this.listeners.delete(listener);
  }

  /** Refcounted so two panels watching the same channel share one subscription. */
  subscribe(sub: Subscription): () => void {
    const k = subKey(sub);
    const count = (this.refCounts.get(k) ?? 0) + 1;
    this.refCounts.set(k, count);
    if (count === 1) {
      this.subs.set(k, sub);
      this.send({ type: 'subscribe', ...sub });
    }
    return () => {
      const next = (this.refCounts.get(k) ?? 1) - 1;
      if (next <= 0) {
        this.refCounts.delete(k);
        this.subs.delete(k);
        this.send({ type: 'unsubscribe', ...sub });
      } else {
        this.refCounts.set(k, next);
      }
    };
  }

  redisCommand(connectionId: string, argv: string[], id: string): void {
    this.send({ type: 'redis-command', connectionId, argv, id });
  }
}

export const wsClient = new WsClient();
