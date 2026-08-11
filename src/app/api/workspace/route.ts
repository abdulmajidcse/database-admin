/**
 * Workspace persistence (PLAN §5 — `workspace(id, json)`): open tabs, panel
 * layout, the active connection, editor text.
 *
 * Stored as one opaque JSON blob the client owns end to end. The server must
 * not grow opinions about the shape, because every UI change would otherwise
 * need a migration here — but it does cap the size, since a runaway autosave
 * loop writing megabytes on every keystroke is a real failure mode.
 *
 * Shape:
 *   GET  /api/workspace?id=default  → { id, workspace: unknown | null }
 *   PUT  { workspace: unknown, id?: string } → { id, ok: true }
 */

import { workspaceRepo } from '@/server/store/db';
import { asRecord, badRequest, handle, HttpError, readJson } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 4 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function workspaceId(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return 'default';
  if (!ID_PATTERN.test(raw)) throw badRequest('"id" must be a short identifier.');
  return raw;
}

export async function GET(req: Request): Promise<Response> {
  return handle(() => {
    const id = workspaceId(new URL(req.url).searchParams.get('id'));
    return { id, workspace: workspaceRepo.get(id) ?? null };
  });
}

export async function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson<unknown>(req));
    const id = workspaceId(typeof body.id === 'string' ? body.id : undefined);
    // `{ workspace: … }` is the contract; a bare object is accepted so a client
    // that PUTs its state directly still round-trips through GET.
    const value = 'workspace' in body ? body.workspace : body;
    if (value === undefined) throw badRequest('"workspace" is required.');

    const size = JSON.stringify(value ?? null).length;
    if (size > MAX_BYTES) {
      throw new HttpError(
        `The workspace is ${Math.round(size / 1024)} KB, over the ${MAX_BYTES / 1024 / 1024} MB limit. Close some tabs or trim their saved text.`,
        413,
        { code: 'WORKSPACE_TOO_LARGE' },
      );
    }

    workspaceRepo.put(value ?? null, id);
    return { id, ok: true };
  });
}
