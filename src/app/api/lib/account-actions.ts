/**
 * The account operations (PLAN §9.2), in one place because they are reachable
 * two ways: as `POST /api/account { action }` and as `POST /api/account/<action>`.
 * The UI tries the action form first and falls back to the sub-route, so both
 * must behave identically.
 *
 * Each answers with the fresh `AccountStatus` and, where relevant, the
 * `Set-Cookie` that establishes or clears the session.
 */

import type { AccountStatus } from '@/lib/api-types';
import {
  AccountError,
  clearedSessionCookie,
  currentSessionId,
  readAccountsCount,
  register,
  sessionCookie,
  signIn,
  signOut,
} from '@/server/account';
import { runAsUser } from '@/server/context';
import { connectionManager } from '@/server/db/manager';
import { claimOrphanConnections } from '@/server/store/db';
import { badRequest, HttpError, ok } from './respond';
import { accountStatus } from './account-status';

export type AccountAction = 'register' | 'signin' | 'signout';

export function normalizeAccountAction(raw: unknown): AccountAction {
  const value = typeof raw === 'string' ? raw.toLowerCase().replace(/[\s_-]/gu, '') : '';
  switch (value) {
    case 'register':
    case 'signup':
    case 'create':
      return 'register';
    case 'signin':
    case 'login':
      return 'signin';
    case 'signout':
    case 'logout':
      return 'signout';
    default:
      throw badRequest('"action" must be one of: register, signin, signout.');
  }
}

export async function runAccountAction(
  action: AccountAction,
  body: Record<string, unknown>,
  req: Request,
): Promise<Response> {
  switch (action) {
    case 'register':
      return doRegister(body, req);
    case 'signin':
      return doSignIn(body, req);
    case 'signout':
      return doSignOut(req);
  }
}

/**
 * A cookie marked `Secure` is silently dropped over plain HTTP, which would
 * leave the user signing in successfully and landing back on the sign-in
 * screen. So it is set only when the request actually arrived over TLS.
 */
function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0].trim() === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The status is built inside the new user's context rather than from the
 * request's cookie header: the browser has not seen the `Set-Cookie` yet, so
 * reading the request would report `signedIn: false` and bounce the user
 * straight back to the gate.
 */
function signedInResponse(userId: string, username: string, secure: boolean, sessionId: string): Response {
  const status = runAsUser({ userId, username }, () => ({
    ...accountStatus(undefined),
    exists: true,
    signedIn: true,
    username,
  }));
  const res = ok(status);
  res.headers.append('set-cookie', sessionCookie(sessionId, secure));
  return res;
}

async function doRegister(body: Record<string, unknown>, req: Request): Promise<Response> {
  const session = await asHttpError(() => register(body.username, body.password));
  return signedInResponse(session.userId, session.username, isSecureRequest(req), session.id);
}

async function doSignIn(body: Record<string, unknown>, req: Request): Promise<Response> {
  const session = await asHttpError(() => signIn(body.username, body.password));

  // Rows written before multi-user support have no owner. Hand them to this
  // account only when it is the only one on the install — otherwise a second
  // person signing up could inherit the first person's connections.
  if (readAccountsCount() === 1) {
    runAsUser({ userId: session.userId, username: session.username }, () => {
      claimOrphanConnections(session.userId);
    });
  }

  return signedInResponse(session.userId, session.username, isSecureRequest(req), session.id);
}

async function doSignOut(req: Request): Promise<Response> {
  const userId = signOut(currentSessionId(req.headers.get('cookie') ?? undefined));
  // Locking the vault is not enough: live connections were opened with already
  // decrypted credentials, so this user's are closed too (mirrors §9.3's lock).
  if (userId) await connectionManager.closeAllFor(userId, 'Signed out.');
  const res = ok(accountStatus(undefined));
  res.headers.append('set-cookie', clearedSessionCookie());
  return res;
}

/** Account errors carry their own status and code; keep both. */
async function asHttpError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AccountError) {
      throw new HttpError(err.message, err.status, { code: err.code });
    }
    throw err;
  }
}
