/**
 * Account status and actions (PLAN §9.2).
 *
 * GET is the first thing the shell asks for: it decides between "create your
 * account", "sign in", and the app itself. It is one of the two endpoints
 * reachable without a session — requiring one to ask whether you have one is
 * circular — but Host and Origin are still checked, as everywhere.
 *
 * POST takes `{ action: 'register' | 'signin' | 'signout', … }`; the same
 * operations also live at /api/account/<action>.
 *
 * Thin route (§11): validate → call the server layer → serialize.
 */

import { asRecord, handle, readJson } from '../lib/respond';
import { accountStatus, cookieOf } from '../lib/account-status';
import { normalizeAccountAction, runAccountAction } from '../lib/account-actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(() => accountStatus(cookieOf(req)));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson<unknown>(req));
    return runAccountAction(normalizeAccountAction(body.action), body, req);
  });
}
