/**
 * Per-request user context (PLAN §9.2).
 *
 * Connections are private to the user who created them, which means almost
 * every query in store/db.ts needs to know who is asking. Threading a userId
 * through seventeen call sites — routes, the connection manager, the access
 * resolver, the transfer engines — would work, and would also mean that the one
 * place someone forgets is a silent cross-user data leak.
 *
 * So the identity is carried out-of-band in an AsyncLocalStorage entered once,
 * at the edge in server.ts, around the call into Next's request handler. The
 * async context propagates down the whole chain, so `requireUserId()` works in
 * synchronous repo code without any signature changes — and code that forgets
 * to scope a query throws instead of quietly returning everyone's rows.
 *
 * The store is pinned to `globalThis` for the same reason the session store is:
 * this module is loaded twice in one process — once by tsx for server.ts, once
 * inside Next's bundle — and two AsyncLocalStorage instances would never see
 * each other's context. See account.ts for the full explanation.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface UserContext {
  userId: string;
  username: string;
}

const CONTEXT_STORE: unique symbol = Symbol.for('dbadmin.userContext');

type GlobalWithContext = typeof globalThis & {
  [CONTEXT_STORE]?: AsyncLocalStorage<UserContext>;
};

const storage: AsyncLocalStorage<UserContext> = ((): AsyncLocalStorage<UserContext> => {
  const g = globalThis as GlobalWithContext;
  g[CONTEXT_STORE] ??= new AsyncLocalStorage<UserContext>();
  return g[CONTEXT_STORE];
})();

/** Runs `fn` with `ctx` visible to everything it calls, however deep. */
export function runAsUser<T>(ctx: UserContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentUser(): UserContext | undefined {
  return storage.getStore();
}

export function currentUserId(): string | undefined {
  return storage.getStore()?.userId;
}

export class NoUserContextError extends Error {
  constructor() {
    super('No signed-in user for this request.');
    this.name = 'NoUserContextError';
  }
}

/**
 * Throws rather than returning a sentinel. A missing context means an
 * unauthenticated path reached owner-scoped data, and the safe response to that
 * is a 500 in the logs, never a query that quietly matches every row.
 */
export function requireUserId(): string {
  const id = currentUserId();
  if (!id) throw new NoUserContextError();
  return id;
}
