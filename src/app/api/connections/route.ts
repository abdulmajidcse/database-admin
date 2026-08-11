/**
 * Connection CRUD — list and create (PLAN §5, §9.3).
 *
 * GET answers `ConnectionListResponse`: the saved configs plus the live state
 * of each one, because the sidebar needs both in a single round trip and a
 * state map keyed by id is what the §8.3 indicator renders from.
 *
 * A password NEVER travels back: `connectionsRepo` maps the encrypted blob to
 * a boolean `hasPassword`, and nothing here reaches for the plaintext.
 */

import type { ConnectionListResponse, ConnectionState } from '@/lib/api-types';
import { connectionManager } from '@/server/db/manager';
import { connectionsRepo } from '@/server/store/db';
import { parseConnectionInput } from '../lib/connection-input';
import { handle, ok, readJson } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle((): ConnectionListResponse => {
    // Listing works with the vault locked: no secret is decrypted here.
    const connections = connectionsRepo.list();
    const states: Record<string, ConnectionState> = {};
    for (const c of connections) states[c.id] = connectionManager.getState(c.id);
    return { connections, states };
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const input = parseConnectionInput(await readJson<unknown>(req));
    // A supplied password is encrypted inside create(); a locked vault throws
    // VaultLockedError, which `handle` turns into the 423 the UI unlocks on.
    const created = connectionsRepo.create(input);
    return ok(created, { status: 201 });
  });
}
