/**
 * POST /api/account/register — first run (PLAN §9.2).
 *
 * Creates the account and initializes the credential vault under the same
 * password in one step, then signs the browser in. See server/account.ts for
 * why one password can safely do both jobs.
 */

import { asRecord, handle, readJson } from '../../lib/respond';
import { runAccountAction } from '../../lib/account-actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => runAccountAction('register', asRecord(await readJson<unknown>(req)), req));
}
