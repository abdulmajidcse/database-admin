/**
 * The one place `AccountStatus` is assembled (PLAN §9.2), shared by every
 * /api/account route so register and sign-in answer with the same shape the
 * status poll returns — the client renders the next screen from one round trip.
 */

import type { AccountStatus } from '@/lib/api-types';
import { anyAccountExists, sessionFromCookie } from '@/server/account';
import { CONFIG } from '@/server/config';
import { currentUser } from '@/server/context';
import { vaultStatus } from './vault-status';

export function accountStatus(cookieHeader: string | undefined): AccountStatus {
  // DBADMIN_DISABLE_AUTH=1 is the test harness: report a usable state so the
  // gate never renders and smoke tests can drive the app directly.
  if (CONFIG.disableAuth) {
    const ctx = currentUser();
    return { exists: true, signedIn: true, username: ctx?.username ?? 'test', vault: vaultStatus() };
  }

  // Prefer the ambient context: during register and sign-in the browser has not
  // been handed the cookie yet, so the request header is a turn behind.
  const ctx = currentUser();
  if (ctx) {
    return { exists: true, signedIn: true, username: ctx.username, vault: vaultStatus() };
  }

  const session = sessionFromCookie(cookieHeader);
  return {
    exists: anyAccountExists(),
    signedIn: session !== null,
    username: session?.username ?? null,
    vault: vaultStatus(),
  };
}

export function cookieOf(req: Request): string | undefined {
  return req.headers.get('cookie') ?? undefined;
}
