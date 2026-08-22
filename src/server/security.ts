/**
 * Localhost is not automatically safe (PLAN §9).
 *
 * Any website you visit can issue requests to localhost:3456. Two independent
 * defences apply to every /api request:
 *
 *   - Host and Origin are validated against an allow-list. This is what stops
 *     DNS rebinding, where an attacker's domain resolves to 127.0.0.1.
 *   - A session cookie must be present and live. It is `SameSite=Strict`, so a
 *     request initiated by another site never carries it — which is why the
 *     per-install header token this used to require is gone (see account.ts).
 *
 * Reads are checked as strictly as writes: a cross-site GET that returns your
 * table data is a breach, not a safe method.
 */

import { CONFIG } from './config';
import { sessionFromCookie } from './account';

/**
 * Endpoints reachable without a session, because requiring one would be
 * circular. Everything else is closed.
 *
 *   /api/health   — the container HEALTHCHECK, and it reveals nothing.
 *   /api/account  — status, register, sign-in: the door itself.
 *
 * Still Host/Origin checked; "no session required" is not "no checks".
 */
const PUBLIC_API_PREFIXES = ['/api/health', '/api/account'];

export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Host must be a loopback name we serve on. A rebinding attack arrives with an
 * attacker-controlled Host header, so an allow-list is the defence.
 */
/** Extra names a reverse proxy answers on, from DBADMIN_ALLOWED_HOSTS. */
const EXTRA_HOSTS: readonly string[] = (process.env.DBADMIN_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter((h) => h !== '');

/**
 * Just the host, lowercased, with the port and any IPv6 brackets removed.
 *
 * RFC 7230 requires brackets around an IPv6 literal, but a bare `::1` turns up
 * in practice and splitting it on `:` yields an empty string — which is why
 * `::1` and `[::1]:3456` were both silently refused before this, despite `::1`
 * being in the allow-list.
 */
function hostnameOf(hostHeader: string): string {
  const raw = hostHeader.trim();
  if (raw.startsWith('[')) {
    return (raw.match(/^\[([^\]]*)\]/)?.[1] ?? raw).toLowerCase();
  }
  // More than one colon and no brackets: a bare IPv6 literal, port and all is
  // the address.
  if (raw.indexOf(':') !== raw.lastIndexOf(':')) return raw.toLowerCase();
  return raw.split(':')[0].toLowerCase();
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostnameOf(hostHeader);
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    // A subdomain of .localhost, which is how a reverse proxy is usually
    // addressed (`database-admin.localhost` behind Caddy or Traefik). RFC 6761
    // reserves the TLD and browsers resolve it to loopback without asking DNS,
    // so it is no more reachable from outside than `localhost` itself — the
    // same reasoning behind Next's own `**.localhost` dev allowance. The check
    // is on a label boundary, so `localhost.evil.com` does not match.
    host.endsWith('.localhost') ||
    // Reaching the container by its service name on a compose network is
    // legitimate; `app` is compose.yml's service.
    host === 'app' ||
    host === 'host.docker.internal' ||
    EXTRA_HOSTS.includes(host)
  );
}

export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  // Same-origin fetches from the app itself often omit Origin on GET.
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (!isAllowedHost(u.host)) return false;
    // Same-origin means the Origin IS the authority we were reached on, so the
    // two headers are compared to each other. The previous check compared the
    // Origin's port to the port this process listens on, which is wrong behind
    // any reverse proxy: the browser talks to :80 or :443 while the app serves
    // 3456, and every request was refused.
    if (!hostHeader) return false;
    return u.host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}

export interface AuthCheckResult {
  ok: boolean;
  status?: number;
  message?: string;
  code?: string;
}

/** Applied to every /api request by the HTTP server before Next sees it. */
export function checkRequest(req: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
}): AuthCheckResult {
  if (CONFIG.disableAuth) return { ok: true };

  const header = (name: string): string | undefined => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };

  if (!isAllowedHost(header('host'))) {
    return { ok: false, status: 403, message: 'Host not allowed' };
  }
  if (!isAllowedOrigin(header('origin'), header('host'))) {
    return { ok: false, status: 403, message: 'Origin not allowed' };
  }

  const pathname = (req.url ?? '/').split('?')[0];
  if (isPublicApiPath(pathname)) return { ok: true };

  if (!sessionFromCookie(header('cookie'))) {
    // The client turns this into the sign-in screen (§9.2).
    return { ok: false, status: 401, message: 'Not signed in', code: 'NO_SESSION' };
  }
  return { ok: true };
}

/** Printed at startup. No secret in the URL any more — you sign in instead. */
export function launchUrl(): string {
  return `http://127.0.0.1:${CONFIG.port}/`;
}
