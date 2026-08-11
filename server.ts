/**
 * Custom HTTP server (PLAN §2).
 *
 * Why not plain `next start`: we need WebSockets (Redis MONITOR, live process
 * list, job progress) and long-lived connection pools. A Node HTTP server that
 * delegates to Next's request handler and owns the `upgrade` event gives us
 * both in one process.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parse } from 'node:url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { CONFIG, IS_CONTAINER } from './src/server/config';
import { checkRequest, launchUrl } from './src/server/security';
import { autoProvisionForTests, sessionFromCookie, testSession } from './src/server/account';
import { runAsUser } from './src/server/context';
import { attachWebSocketHub, WS_USER, type UpgradeRequest } from './src/server/ws/hub';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, hostname: CONFIG.host, port: CONFIG.port });
const handle = app.getRequestHandler();

async function main(): Promise<void> {
  await app.prepare();
  await autoProvisionForTests();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    // §9: every /api request is Host/Origin/session checked. /api/health is the
    // container HEALTHCHECK and must stay reachable unconditionally; the
    // sign-in routes are exempted inside checkRequest, not here.
    if (url.startsWith('/api/') && !url.startsWith('/api/health')) {
      const check = checkRequest({ method: req.method ?? 'GET', headers: req.headers, url });
      if (!check.ok) {
        res.statusCode = check.status ?? 403;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: check.message ?? 'Forbidden', code: check.code }));
        return;
      }
    }

    // The identity is established once, here, and carried down the whole async
    // chain so owner-scoped queries deep in the store do not need it passed to
    // them (src/server/context.ts explains why that matters).
    // With auth disabled (tests only) there is no cookie, so the fixed test
    // account stands in — owner-scoped queries still need somebody to be.
    const session =
      sessionFromCookie(req.headers.cookie) ?? (CONFIG.disableAuth ? (testSession() ?? null) : null);
    const dispatch = () =>
      handle(req, res, parse(url, true)).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[server] request failed', err);
        res.statusCode = 500;
        res.end('Internal error');
      });

    if (session) {
      runAsUser({ userId: session.userId, username: session.username }, dispatch);
    } else {
      dispatch();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  attachWebSocketHub(wss);

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url ?? '/');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // Browsers cannot set headers on a WebSocket handshake — but they DO send
    // cookies, so the session is verified here at the upgrade rather than in a
    // first message the client has to be trusted to send (§9.2).
    const check = checkRequest({ method: 'GET', headers: req.headers, url: req.url });
    if (!check.ok) {
      socket.destroy();
      return;
    }
    // Hand the resolved identity to the hub so broadcasts can be filtered to
    // the user they concern, rather than every open socket (§9.2).
    const wsSession = sessionFromCookie(req.headers.cookie) ?? (CONFIG.disableAuth ? testSession() : undefined);
    (req as UpgradeRequest)[WS_USER] = wsSession?.userId;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    const where = IS_CONTAINER ? 'container' : 'host';
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        `  Database Admin ready (${where}, ${dev ? 'development' : 'production'})`,
        `  ${launchUrl()}`,
        '',
        IS_CONTAINER
          ? '  Reaching databases: host.docker.internal for this machine, service name for another container. (PLAN §10.3)'
          : '',
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n[server] ${signal} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[server] failed to start', err);
  process.exit(1);
});
