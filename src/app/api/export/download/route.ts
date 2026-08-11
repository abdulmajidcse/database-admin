/**
 * /api/export/download — the browser-owned streaming download (PLAN §7.4, §9.2).
 *
 * `downloadExport()` in lib/api-client submits a hidden form here rather than
 * calling fetch(), because only a real navigation gets the browser's own
 * save-to-disk machinery: a fetch() response would have to be buffered in memory
 * first, which is exactly what §7.4 forbids for a multi-gigabyte export.
 *
 * A form POST cannot set headers, but it does carry cookies — and the session
 * cookie is `SameSite=Strict`, so a form submitted by any other site arrives
 * without one. That is checked here as well as at the server edge, because this
 * route streams a whole database out and is worth failing closed twice (§9.2).
 *
 * Thin route (§11): validate → call the server layer → stream.
 */

import { CONFIG } from '@/server/config';
import { sessionFromCookie } from '@/server/account';
import { asRecord, badRequest, fail, handle } from '../../lib/respond';
import { parseExportRequest, streamExportResponse } from '../build';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isSignedIn(req: Request): boolean {
  if (CONFIG.disableAuth) return true;
  return sessionFromCookie(req.headers.get('cookie') ?? undefined) !== null;
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw badRequest('This endpoint expects the form POST that downloadExport() submits.');
    }

    if (!isSignedIn(req)) {
      // Deliberately the same wording the server-level check uses (§9.2).
      return fail('Not signed in', 401, { code: 'NO_SESSION' });
    }

    const payload = form.get('payload');
    if (typeof payload !== 'string' || payload === '') {
      throw badRequest('The "payload" field must carry the export request as JSON.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      throw badRequest('The "payload" field is not valid JSON.');
    }

    const raw = asRecord(parsed, 'The export payload');
    // The form only ever means "send it to me"; a destination is optional here.
    if (raw.destination === undefined || raw.destination === null) {
      raw.destination = { kind: 'download' };
    }
    const request = parseExportRequest(raw);
    if (request.destination.kind !== 'download') {
      throw badRequest('This endpoint always streams to the browser. POST a file destination to /api/export.');
    }

    // Aborts when the user cancels the download, which cancels the query too.
    return streamExportResponse(request, req.signal);
  });
}
