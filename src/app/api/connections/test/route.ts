/**
 * Test a connection without saving or disturbing a live one (PLAN §10.3).
 *
 * Always answers 200 with a `TestConnectionResponse`: a refused database is a
 * result the form renders inline, not an HTTP failure. Only a malformed request
 * or a locked vault is an error status.
 *
 * The §10.3 hint is the reason this endpoint earns its keep. Inside a container
 * `localhost` is the container, and someone typing `localhost:3306` to reach
 * MySQL on their Mac gets a bare ECONNREFUSED — the single most confusing
 * failure this app can produce. When the attempt fails against a loopback
 * address we attach the fix.
 */

import type { TestConnectionResponse } from '@/lib/api-types';
import { connectionManager } from '@/server/db/manager';
import { containerAddressHint, parseTestConnectionInput } from '../../lib/connection-input';
import { handle, readJson } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<TestConnectionResponse> => {
    const input = parseTestConnectionInput(await readJson<unknown>(req));
    const result = await connectionManager.testConnection(input);
    if (result.ok) return result;

    // The manager already names the container-loopback fix for a refused direct
    // connection; broaden it here to every failure mode against a loopback
    // address (timeouts and TLS errors land in the same trap) without
    // overwriting a more specific hint it produced.
    const hint = result.hint ?? containerAddressHint(input.address);
    return hint ? { ...result, hint } : result;
  });
}
