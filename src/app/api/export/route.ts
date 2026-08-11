/**
 * /api/export — the §7.1 export scopes, both destinations (PLAN §7.3, §7.4).
 *
 *   destination.kind === 'file'     → a JobManager job, `{ jobId }` returned at
 *                                     once. A 50 GB dump cannot live inside an
 *                                     HTTP request (§7.3).
 *   destination.kind === 'download' → the export is streamed into the response
 *                                     body; nothing is ever buffered (§7.4).
 *
 * The browser's *file save* dialog needs the transfer to belong to the browser,
 * not to fetch(), so the UI posts a hidden form to /api/export/download instead
 * of calling this route with `download`. Both paths share ./build.
 *
 * Thin route (§11): validate → call the server layer → serialize.
 */

import { handle, ok, readJson } from '../lib/respond';
import { parseExportRequest, startExportJob, streamExportResponse } from './build';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const request = parseExportRequest(await readJson<unknown>(req));

    if (request.destination.kind === 'download') {
      // `req.signal` aborts when the client goes away, which cancels the
      // DB-side query too rather than leaving it running (§7.3).
      return streamExportResponse(request, req.signal);
    }

    const jobId = startExportJob(request, request.destination.path);
    // 202: the work has been accepted, not finished. Progress arrives on the
    // WebSocket `jobs` channel and the row survives a page reload.
    return ok({ jobId }, { status: 202 });
  });
}
