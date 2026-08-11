/**
 * Client-side id generation.
 *
 * `crypto.randomUUID()` exists only in a SECURE CONTEXT — HTTPS, or an origin
 * the browser treats as potentially trustworthy such as `localhost`. Reaching
 * this app over plain HTTP by any other hostname (a home server, a Tailscale
 * name, a container name) leaves it undefined, and an unguarded call throws
 * "crypto.randomUUID is not a function", taking the whole run path down.
 *
 * `crypto.getRandomValues` has no such restriction, so it is the fallback; a
 * non-crypto path exists only so this never throws.
 */

export function randomId(): string {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;

  if (c && typeof c.randomUUID === 'function') return c.randomUUID();

  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    // RFC 4122 version 4 / variant 10xx.
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
