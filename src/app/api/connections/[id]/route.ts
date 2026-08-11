/**
 * Connection CRUD — update and delete (PLAN §5).
 *
 * Both verbs have a side effect beyond the row: a saved connection whose link
 * definition changed must not keep serving the OLD socket. Editing the host and
 * then querying the previous server is a silent, dangerous surprise — so the
 * live link is dropped and the cached schema (§6) with it. Cosmetic edits
 * (name, colour, env tag) leave a working session alone.
 */

import type { ConnectionConfig, ConnectionInput } from '@/lib/connection';
import { connectionManager } from '@/server/db/manager';
import { invalidate as invalidateSchema } from '@/server/db/schema-cache';
import { connectionsRepo } from '@/server/store/db';
import { parseConnectionInput } from '../../lib/connection-input';
import { handle, notFound, readJson } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(async () => {
    const existing = connectionsRepo.get(id);
    if (!existing) throw notFound(`No such connection: ${id}`);

    const input = parseConnectionInput(await readJson<unknown>(req));
    const relink = linkChanged(existing, input);

    const updated = connectionsRepo.update(id, input);

    if (relink) {
      await connectionManager.close(id, 'The connection settings changed; reconnect to apply them.');
      invalidateSchema(id);
    }
    return updated;
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(async () => {
    const existing = connectionsRepo.get(id);
    if (!existing) throw notFound(`No such connection: ${id}`);

    // Close first: closing cancels in-flight runs and releases the tunnel the
    // AccessResolver refcounts (§8.1). Deleting the row first would leave the
    // manager trying to reconnect to a connection that no longer exists.
    await connectionManager.close(id, 'The connection was deleted.');
    invalidateSchema(id);
    connectionsRepo.remove(id);
    return { ok: true, id };
  });
}

/**
 * True when the edit changes WHERE the database is or HOW we reach it — the
 * only cases that invalidate an open socket. Comparing serialized unions is
 * blunt but conservative: a false positive costs one reconnect, a false
 * negative would leave the user querying the wrong server.
 */
function linkChanged(prev: ConnectionConfig, next: ConnectionInput): boolean {
  if (prev.engine !== next.engine) return true;
  if ((prev.username ?? '') !== (next.username ?? '')) return true;
  // A supplied password/passphrase is a credential change by definition.
  if (next.password !== undefined || next.sshSecrets !== undefined) return true;
  if (prev.readOnly !== next.readOnly) return true;
  return (
    JSON.stringify(prev.address) !== JSON.stringify(next.address) ||
    JSON.stringify(prev.access) !== JSON.stringify(next.access) ||
    JSON.stringify(prev.tls ?? null) !== JSON.stringify(next.tls ?? null) ||
    JSON.stringify(prev.options) !== JSON.stringify(next.options)
  );
}
