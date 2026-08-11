/**
 * Open a connection on demand (PLAN §6, §8.3).
 *
 * The manager owns pooling and reconnect, so this is deliberately thin: acquire
 * (which opens, tunnels and pings) and answer with the status the header renders
 * — state, server version, measured RTT and whether the link is tunneled.
 *
 * A failed open is a 502, not a 500: the app is fine, the database is not
 * reachable. §10.3's container-networking advice rides along in `hint`.
 */

import { connectionManager } from '@/server/db/manager';
import { DbError } from '@/server/db/types';
import { connectionsRepo } from '@/server/store/db';
import { VaultLockedError } from '@/server/vault';
import { containerAddressHint } from '../../../lib/connection-input';
import { handle, HttpError, notFound } from '../../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(async () => {
    const config = connectionsRepo.get(id);
    if (!config) throw notFound(`No such connection: ${id}`);

    try {
      await connectionManager.acquire(id);
    } catch (err) {
      // A locked vault still means "unlock and retry", not "the server is down".
      if (err instanceof VaultLockedError || err instanceof HttpError) throw err;
      const hint = containerAddressHint(config.address);
      if (err instanceof DbError) {
        throw new HttpError(err.message, 502, {
          code: err.code ?? 'CONNECT_FAILED',
          detail: err.detail,
          position: err.position,
          hint,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined;
      throw new HttpError(message, 502, { code: code ?? 'CONNECT_FAILED', hint });
    }

    // Non-null: the row exists, so status() cannot return null here.
    return connectionManager.status(id);
  });
}
