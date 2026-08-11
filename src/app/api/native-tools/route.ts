/**
 * /api/native-tools — what the Settings panel shows for §7.2's "still probe PATH
 * at startup and record versions".
 *
 * Shipping in Docker means every dump tool is baked into the image (§10.1), so
 * the normal answer here is "everything present, with versions" — a missing tool
 * means the app is running outside the container, and the built-in streaming
 * engine covers that case. Versioned Postgres clients are listed separately
 * because §7.2 refuses to dump when pg_dump is older than the server, and having
 * several installed is what makes that rule satisfiable.
 *
 * Thin route (§11): validate → call the server layer → serialize.
 */

import type { NativeToolsResponse } from '@/lib/api-types';
import { detectNativeTools, refreshNativeTools, toolsResponse } from '@/server/transfer/native/detect';
import { handle } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const refresh = new URL(req.url).searchParams.get('refresh');
    // Detection is cached and probes each binary once; `?refresh=1` is the
    // rescan button, for when a tool was installed after startup.
    if (refresh === '1' || refresh === 'true') await refreshNativeTools();
    else await detectNativeTools();

    const response: NativeToolsResponse = toolsResponse();
    return response;
  });
}
