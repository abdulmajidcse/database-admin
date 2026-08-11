/**
 * WebSocket hub (PLAN §2).
 *
 * Channels: job progress (§7.3), connection state (§8.3), Redis MONITOR and
 * pub/sub (§6 — each needs its own dedicated Redis connection), and the live
 * process list. Everything is fan-out from server-side event sources to
 * subscribed sockets; the client never drives a database directly.
 */

import type { IncomingMessage } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, ServerMessage, WsChannel } from '../../lib/api-types';
import { currentUserId } from '../context';

/**
 * The session is resolved at the upgrade in server.ts and handed over on the
 * request object, because the `connection` event gives handlers the request but
 * not the work already done to authenticate it.
 */
export const WS_USER = Symbol.for('dbadmin.wsUser');

export type UpgradeRequest = IncomingMessage & { [WS_USER]?: string };

interface Client {
  socket: WebSocket;
  authed: boolean;
  /** Who this socket belongs to; broadcasts are filtered by it (§9.2). */
  userId?: string;
  subscriptions: Set<string>;
  /** Teardown for per-subscription resources (Redis MONITOR connections, timers). */
  disposers: Map<string, () => void>;
}

/**
 * Both of this module's registries are pinned to `globalThis`, and that is not
 * defensive style — without it the WebSocket does nothing.
 *
 * hub.ts is loaded TWICE in one process: once by tsx for server.ts, which owns
 * the socket server and therefore fills `clients`, and once inside Next's
 * bundle, where jobs/index.ts calls `registerChannel()` and `broadcast()`. With
 * plain module scope those are two different Sets and Maps: sockets land in the
 * tsx copy, job events are published to the Next copy, and every subscriber
 * receives silence. The socket still connects and still says "ready", which is
 * why this failed quietly rather than visibly.
 *
 * See server/account.ts for the same hazard in the session store.
 */
const CLIENT_STORE: unique symbol = Symbol.for('dbadmin.wsClients');
const HANDLER_STORE: unique symbol = Symbol.for('dbadmin.wsHandlers');

type GlobalWithHub = typeof globalThis & {
  [CLIENT_STORE]?: Set<Client>;
  [HANDLER_STORE]?: Map<WsChannel, SubscribeHandler>;
};

const clients: Set<Client> = ((): Set<Client> => {
  const g = globalThis as GlobalWithHub;
  g[CLIENT_STORE] ??= new Set<Client>();
  return g[CLIENT_STORE];
})();

function key(channel: WsChannel, connectionId?: string, arg?: string): string {
  return [channel, connectionId ?? '', arg ?? ''].join('|');
}

function send(client: Client, msg: ServerMessage): void {
  if (client.socket.readyState === 1) {
    client.socket.send(JSON.stringify(msg));
  }
}

/**
 * Fan a message out to everyone subscribed to a channel key — but only to the
 * user it belongs to. Job progress, connection state and Redis MONITOR output
 * all describe one person's private connection (§9.2), so delivering them to
 * every open socket would undo the isolation the HTTP side enforces.
 *
 * The owner comes from the ambient request context: an event emitted while a
 * job runs is still inside the async chain of the request that started it. With
 * no context — a timer, a shutdown sweep — the message is not user-specific and
 * goes to every subscriber, which is the old behaviour.
 */
export function broadcast(channel: WsChannel, msg: ServerMessage, connectionId?: string, arg?: string): void {
  const k = key(channel, connectionId, arg);
  const owner = currentUserId();
  for (const c of clients) {
    if (!c.authed || !c.subscriptions.has(k)) continue;
    if (owner && c.userId && c.userId !== owner) continue;
    send(c, msg);
  }
}

/** True when at least one socket wants this stream — lets sources stay idle. */
export function hasSubscribers(channel: WsChannel, connectionId?: string, arg?: string): boolean {
  const k = key(channel, connectionId, arg);
  for (const c of clients) if (c.authed && c.subscriptions.has(k)) return true;
  return false;
}

type SubscribeHandler = (client: Client, connectionId: string | undefined, arg: string | undefined) => (() => void) | void;

/**
 * Channels that need a live server-side source are registered here by the
 * modules that own them (jobs, manager, redis routes), keeping this file free
 * of imports that would create cycles.
 */
const handlers: Map<WsChannel, SubscribeHandler> = ((): Map<WsChannel, SubscribeHandler> => {
  const g = globalThis as GlobalWithHub;
  g[HANDLER_STORE] ??= new Map<WsChannel, SubscribeHandler>();
  return g[HANDLER_STORE];
})();

export function registerChannel(channel: WsChannel, handler: SubscribeHandler): void {
  handlers.set(channel, handler);
}

export function attachWebSocketHub(wss: WebSocketServer): void {
  wss.on('connection', (socket: WebSocket, req: UpgradeRequest) => {
    // The upgrade handler in server.ts already validated the session cookie —
    // an unauthenticated handshake never reaches this event, so there is no
    // window in which a socket is connected but not yet authenticated (§9.2).
    const client: Client = {
      socket,
      authed: true,
      userId: req?.[WS_USER],
      subscriptions: new Set(),
      disposers: new Map(),
    };
    clients.add(client);
    send(client, { type: 'ready' });

    socket.on('message', (raw: Buffer | string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }

      // Kept so an older tab left open across a redeploy is answered rather
      // than ignored; authentication itself happened at the upgrade.
      if (msg.type === 'auth') {
        send(client, { type: 'ready' });
        return;
      }

      switch (msg.type) {
        case 'ping':
          send(client, { type: 'pong' });
          break;

        case 'subscribe': {
          const k = key(msg.channel, msg.connectionId, msg.arg);
          if (client.subscriptions.has(k)) break;
          client.subscriptions.add(k);
          const dispose = handlers.get(msg.channel)?.(client, msg.connectionId, msg.arg);
          if (dispose) client.disposers.set(k, dispose);
          break;
        }

        case 'unsubscribe': {
          const k = key(msg.channel, msg.connectionId, msg.arg);
          client.subscriptions.delete(k);
          client.disposers.get(k)?.();
          client.disposers.delete(k);
          break;
        }

        default:
          break;
      }
    });

    const cleanup = () => {
      for (const dispose of client.disposers.values()) {
        try {
          dispose();
        } catch {
          /* teardown must not throw */
        }
      }
      client.disposers.clear();
      clients.delete(client);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

/** Used by channel handlers to push to the one socket that asked. */
export function sendTo(client: Client, msg: ServerMessage): void {
  send(client, msg);
}

export type { Client as WsClient };
