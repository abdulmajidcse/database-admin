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

/**
 * Streaming download: exports must never be buffered in the browser either
 * (§7.4). Uses a hidden form-less navigation so the browser owns the transfer.
 */
export function downloadExport(path: string, body: unknown): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = path;
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
