/**
 * /api/csv/preview — the first screen of the CSV import wizard (PLAN §7.4:
 * "sniff delimiter, encoding and BOM; detect header row; preview 50 rows").
 *
 * The path is user-supplied, so it is confined to an allowed root before a byte
 * is read (§7.2). Two roots are legitimate here: the export root, because the
 * obvious import is something this app just exported, and the SQLite root,
 * because that is the directory users actually mount their data into (§10.4).
 * Anything under neither is refused.
 *
 * Thin route (§11): validate → call the server layer → serialize.
 */

import { stat } from 'node:fs/promises';
import type { CsvPreviewResponse } from '@/lib/api-types';
import { CONFIG, resolveWithin } from '@/server/config';
import type { CsvDialect } from '@/server/transfer/import/csv';
import { previewCsvFile } from '@/server/transfer/import';
import { asRecord, badRequest, handle, oneOf, optionalBoolean, optionalString, readJson, requireString } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `resolveWithin` throws on escape, so "under either root" is a try of each.
 * The message names both roots — a path that is under neither is nearly always
 * a host path the user typed, and §10.4 says every path here is a container one.
 */
function resolveUnderRoots(candidate: string): string {
  for (const root of [CONFIG.exportRoot, CONFIG.sqliteRoot]) {
    try {
      return resolveWithin(root, candidate);
    } catch {
      continue;
    }
  }
  throw badRequest(`"${candidate}" is outside the directories this server may read.`, {
    code: 'PATH_OUTSIDE_ROOT',
    hint: `Put the file under ${CONFIG.exportRoot} or ${CONFIG.sqliteRoot}. These are container paths, not host paths.`,
  });
}

/**
 * The sniffer is a guess, and a wrong delimiter is obvious the moment the user
 * sees the preview — so the wizard may re-request it with the fields it shows
 * overridden. Everything here is optional; `{ path }` alone is the first call.
 */
function dialectOverrides(body: Record<string, unknown>): Partial<CsvDialect> {
  const raw = body.dialect;
  if (raw === undefined || raw === null) return {};
  const d = asRecord(raw, '"dialect"');
  const overrides: Partial<CsvDialect> = {};
  const delimiter = optionalString(d, 'delimiter');
  if (delimiter !== undefined) {
    if (delimiter.length !== 1) throw badRequest('"dialect.delimiter" must be exactly one character.');
    overrides.delimiter = delimiter;
  }
  const quote = optionalString(d, 'quote');
  if (quote !== undefined) {
    if (quote.length !== 1) throw badRequest('"dialect.quote" must be exactly one character.');
    overrides.quote = quote;
    // The doubling form ("" inside a quoted field) is what every writer emits.
    overrides.escape = quote;
  }
  if (d.encoding !== undefined && d.encoding !== null) {
    overrides.encoding = oneOf(d.encoding, ['utf8', 'utf16le', 'utf16be', 'latin1'] as const, 'dialect.encoding');
  }
  const hasHeader = optionalBoolean(d, 'hasHeader');
  if (hasHeader !== undefined) overrides.hasHeader = hasHeader;
  // These two ride along on the import itself, and `previewCsvFile` infers each
  // column's type under them — so leaving them out here would type the preview
  // by different rules than the load. A file writing NULLs as `NA` reads as text
  // without the literal and as an integer with it, and the mapping is seeded
  // from whichever answer the preview gave.
  const nullLiteral = optionalString(d, 'nullLiteral');
  if (nullLiteral !== undefined) overrides.nullLiteral = nullLiteral;
  const trim = optionalBoolean(d, 'trim');
  if (trim !== undefined) overrides.trim = trim;
  return overrides;
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson<unknown>(req));
    const path = resolveUnderRoots(requireString(body, 'path', 'file path'));

    const info = await stat(path);
    if (!info.isFile()) throw badRequest(`"${path}" is not a file.`);

    // Sniff → preview → infer, in one call: the dialect decides how the preview
    // is parsed, and reading a UTF-16 file as UTF-8 turns the whole wizard into
    // garbage (§7.4). `mapping` rides along for the wizard's next screen.
    const preview = await previewCsvFile(path, dialectOverrides(body));
    const response: CsvPreviewResponse = preview;
    return response;
  });
}
