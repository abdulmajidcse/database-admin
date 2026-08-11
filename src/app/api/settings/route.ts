/**
 * App settings (PLAN §5 — the `settings(key, value)` table).
 *
 * A flat string map on purpose: preferences are read at startup by code that
 * must never fail on an unknown key, so the store stays schemaless and each
 * feature owns the meaning of its own keys. PUT is a MERGE, not a replace —
 * two panels saving different preferences must not clobber each other.
 *
 * Shape:
 *   GET  → { settings: Record<string, string> }
 *   PUT  { settings: Record<string, string | number | boolean> }
 *        → { settings: Record<string, string> }   (the merged result)
 */

import { settingsRepo } from '@/server/store/db';
import { asRecord, badRequest, handle, readJson } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Keys are identifiers, not free text: they end up in a primary key column. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function GET(): Promise<Response> {
  return handle(() => ({ settings: settingsRepo.all() }));
}

export async function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson<unknown>(req));
    const incoming = asRecord(body.settings ?? body, '"settings"');

    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!KEY_PATTERN.test(key)) {
        throw badRequest(`"${key}" is not a valid setting key (letters, digits, dot, dash, underscore).`);
      }
      if (typeof value === 'string') flat[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) flat[key] = String(value);
      else if (typeof value === 'boolean') flat[key] = String(value);
      else {
        // Structured preferences are welcome — as JSON the caller stringified,
        // so the round trip is lossless and this route stays dumb.
        throw badRequest(`"settings.${key}" must be a string, number or boolean.`);
      }
    }

    for (const [key, value] of Object.entries(flat)) settingsRepo.put(key, value);
    return { settings: settingsRepo.all() };
  });
}
