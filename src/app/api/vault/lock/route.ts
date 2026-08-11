/**
 * Lock the vault (PLAN §9.3).
 *
 * Closes every live connection as well as zeroing the key — see
 * `lockVault()` for why. Takes no body.
 *
 * Same operation as `POST /api/vault { action: 'lock' }`.
 */

import { handle } from '../../lib/respond';
import { lockVault } from '../../lib/vault-actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return handle(() => lockVault());
}
