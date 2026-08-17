/**
 * Browser-side API client.
 *
 * Authentication is a session cookie set at sign-in (PLAN §9.2). Nothing is
 * kept in localStorage and no token rides in a header: the cookie is HttpOnly
 * and `SameSite=Strict`, so this code cannot read it and another site cannot
 * cause it to be sent. `credentials: 'same-origin'` is the fetch default, but
 * it is stated here because the whole scheme depends on it.
 */

import type { ApiError } from './api-types';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly detail?: string,
    readonly hint?: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!res.ok) {
    const err = (payload ?? {}) as ApiError;
    throw new ApiRequestError(
      err.error ?? `Request failed (${res.status})`,
      res.status,
      err.code,
      err.detail,
      err.hint,
      err.position,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', path, body, signal),
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('PUT', path, body, signal),
  del: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('DELETE', path, body, signal),
};

/** Hidden frames from earlier downloads, pruned lazily rather than on a timer. */
const downloadFrames: { frame: HTMLIFrameElement; at: number }[] = [];
const FRAME_TTL_MS = 30 * 60 * 1000;

/**
 * Streaming download: exports must never be buffered in the browser either
 * (§7.4). A form POST rather than fetch() so the browser owns the transfer.
 *
 * The POST **must** target a hidden iframe. A top-level form POST only stays
 * out of the viewport while the response carries `Content-Disposition:
 * attachment`; the moment the server answers with a JSON error instead — an
 * unqualified Mongo collection, a JSON export of a whole database, an expired
 * session — the browser replaces the app with that JSON, taking every open tab
 * and unsaved editor buffer with it. Targeting a frame keeps a rejection inside
 * the frame, where `onError` can read it and turn it back into a toast.
 */
export function downloadExport(
  path: string,
  body: unknown,
  onError?: (message: string, hint?: string) => void,
): void {
  // A successful download never fires `load`, so its frame is retired here on a
  // later call instead — long after the browser has committed to the transfer.
  const now = Date.now();
  for (let i = downloadFrames.length - 1; i >= 0; i--) {
    if (now - downloadFrames[i].at > FRAME_TTL_MS) {
      downloadFrames[i].frame.remove();
      downloadFrames.splice(i, 1);
    }
  }

  const name = `dbadmin-download-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const frame = document.createElement('iframe');
  frame.name = name;
  frame.setAttribute('aria-hidden', 'true');
  frame.style.display = 'none';
  document.body.appendChild(frame);
  downloadFrames.push({ frame, at: now });

  let settled = false;
  frame.addEventListener('load', () => {
    // Reaching here means the server rendered a document rather than streaming
    // an attachment — i.e. it refused. Same-origin, so the body is readable.
    if (settled) return;
    settled = true;
    let text = '';
    try {
      text = frame.contentDocument?.body?.textContent?.trim() ?? '';
    } catch {
      text = '';
    }
    if (text !== '') {
      let message = text.slice(0, 400);
      let hint: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: unknown; hint?: unknown };
        if (typeof parsed.error === 'string') message = parsed.error;
        if (typeof parsed.hint === 'string') hint = parsed.hint;
      } catch {
        // Not JSON — show whatever it said rather than swallowing it.
      }
      onError?.(message, hint);
    }
    const i = downloadFrames.findIndex((f) => f.frame === frame);
    if (i >= 0) downloadFrames.splice(i, 1);
    frame.remove();
  });

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = path;
  form.target = name;
  form.style.display = 'none';
  const payload = document.createElement('input');
  payload.name = 'payload';
  payload.value = JSON.stringify(body);
  form.appendChild(payload);
  // No token field: this POST is same-site, so the session cookie rides along —
  // and a cross-site form POST would not carry it, which is the point (§9.2).
  document.body.appendChild(form);
  form.submit();
  form.remove();
}
