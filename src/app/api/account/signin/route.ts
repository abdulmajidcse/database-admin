/**
 * POST /api/account/signin — verify the password, unlock the vault, set the
 * session cookie (PLAN §9.2). All three succeed together or none does.
 */

import { asRecord, handle, readJson } from '../../lib/respond';
import { runAccountAction } from '../../lib/account-actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => runAccountAction('signin', asRecord(await readJson<unknown>(req)), req));
}
