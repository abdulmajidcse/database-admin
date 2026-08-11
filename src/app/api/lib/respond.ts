/**
 * Shared route-handler plumbing (PLAN §11: route handlers stay thin — validate,
 * call the server layer, serialize).
 *
 * Everything funnels through `handle()` so that:
 *   - a thrown error becomes the single `ApiError` shape the client renders,
 *   - a locked vault is a 423 the UI can turn into the unlock prompt (§9.3),
 *   - a driver error keeps its code/detail/position for the editor gutter (§6),
 *   - and a stack trace or a credential never reaches the browser (§9).
 */

import type { ApiError } from '@/lib/api-types';
import { redactUri } from '@/lib/connection';
import { DbError } from '@/server/db/types';
import { VaultLockedError } from '@/server/vault';

type ApiErrorExtra = Omit<ApiError, 'error'>;

/** Thrown by validators; `handle()` turns it into exactly this status. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: ApiErrorExtra = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, extra?: ApiErrorExtra): HttpError =>
  new HttpError(message, 400, extra);

export const notFound = (message: string, extra?: ApiErrorExtra): HttpError =>
  new HttpError(message, 404, extra);

export const conflict = (message: string, extra?: ApiErrorExtra): HttpError =>
  new HttpError(message, 409, extra);

/** JSON success. `no-store` because every one of these routes is live state. */
export function ok<T>(data: T, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('cache-control', 'no-store');
  return Response.json(data, { ...init, headers });
}

export function fail(message: string, status: number, extra?: ApiErrorExtra): Response {
  const body: ApiError = { error: message, ...stripUndefined(extra ?? {}) };
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Wrap a handler body. Returning a `Response` passes it through untouched (for
 * 201s and streams); anything else is serialized as JSON with a 200.
 */
export async function handle(fn: () => Promise<unknown> | unknown): Promise<Response> {
  try {
    const result = await fn();
    if (result instanceof Response) return result;
    return ok(result ?? null);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return fail(scrub(err.message), err.status, err.extra);
  }
  // §9.3: the UI reacts to 423 by showing the unlock dialog and retrying.
  if (err instanceof VaultLockedError) {
    return fail(err.message, 423, {
      code: 'VAULT_LOCKED',
      hint: 'Unlock the vault with your master passphrase, then try again.',
    });
  }
  if (err instanceof DbError) {
    return fail(scrub(err.message), 400, {
      code: err.code,
      detail: err.detail,
      position: err.position,
    });
  }

  const code = errnoOf(err);
  // Filesystem errors from the file picker and the SQLite/export roots (§7.2).
  if (code === 'ENOENT') return fail(scrub(messageOf(err)), 404, { code });
  if (code === 'ENOTDIR') return fail(scrub(messageOf(err)), 400, { code });
  if (code === 'EACCES' || code === 'EPERM') return fail(scrub(messageOf(err)), 403, { code });

  // Unexpected: log the real thing server-side, hand the browser the message
  // only — never the stack (§9).
  // eslint-disable-next-line no-console
  console.error('[api] unhandled error', err);
  return fail(scrub(messageOf(err)) || 'Internal error', 500, code ? { code } : undefined);
}

/** Parse a JSON body, with a 400 instead of a 500 when it is not JSON. */
export async function readJson<T>(req: Request): Promise<T> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw badRequest('Could not read the request body.');
  }
  if (!text.trim()) throw badRequest('A JSON request body is required.');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest('The request body is not valid JSON.');
  }
}

/** Narrow an unknown body to an object before field-by-field validation. */
export function asRecord(value: unknown, what = 'The request body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, field: string, what = 'field'): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw badRequest(`"${field}" is a required ${what} (a non-empty string).`);
  }
  return v;
}

export function optionalString(obj: Record<string, unknown>, field: string): string | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw badRequest(`"${field}" must be a string.`);
  return v;
}

export function optionalBoolean(obj: Record<string, unknown>, field: string): boolean | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw badRequest(`"${field}" must be true or false.`);
  return v;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`"${field}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Internal error';
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Driver messages happily quote the connection string that failed. Strip
 * anything password-shaped before the text leaves the process (§9.3).
 */
function scrub(message: string): string {
  return redactUri(message)
    .replace(/((?:password|passphrase|pwd|secret|token)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\n\s*at\s+.*$/s, '');
}

function stripUndefined(extra: ApiErrorExtra): ApiErrorExtra {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  return out as ApiErrorExtra;
}
