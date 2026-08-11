/**
 * Unlock the vault for this process (PLAN §9.3).
 *
 * A wrong passphrase is a 401 rather than a `{ ok: false }` 200, so the client
 * treats it like any other auth failure and the browser never caches it. There
 * is no lockout counter: this is a single-user tool bound to loopback (§9.2),
 * and the real cost of a brute-force attempt is scrypt.
 *
 * Same operation as `POST /api/vault { action: 'unlock' }`.
 */

import { asRecord, handle, readJson } from '../../lib/respond';
import { unlockVault } from '../../lib/vault-actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => unlockVault(asRecord(await readJson<unknown>(req))));
}
