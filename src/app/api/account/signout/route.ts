/**
 * POST /api/account/signout — drop the session, lock the vault, close every
 * live connection (PLAN §9.2, §9.3). Takes no body.
 */

import { handle } from '../../lib/respond';
import { runAccountAction } from '../../lib/account-actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(() => runAccountAction('signout', {}, req));
}
