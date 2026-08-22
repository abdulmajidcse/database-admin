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
 * Just the hostname, lowercased, with the port and any IPv6 brackets removed.
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

/** The explicit port in a Host header, or undefined when it carries none. */
function portOf(hostHeader: string): string | undefined {
  const raw = hostHeader.trim();
  if (raw.startsWith('[')) {
    const after = raw.slice(raw.indexOf(']') + 1);
    return after.startsWith(':') ? after.slice(1) : undefined;
  }
  if (raw.indexOf(':') !== raw.lastIndexOf(':')) return undefined; // bare IPv6
  const parts = raw.split(':');
  return parts.length > 1 && parts[1] !== '' ? parts[1] : undefined;
}

/**
 * Names this install answers on beyond loopback, from DBADMIN_ALLOWED_HOSTS.
 *
 * This is the supported way to put the app behind a reverse proxy: name the
 * hostname the proxy serves, e.g. `database-admin.localhost` or `db.internal`.
 * A leading `*.` matches one or more labels beneath that suffix.
 *
 * There is deliberately no blanket `*.localhost` allowance. It looks safe —
 * RFC 6761 reserves the TLD and Chrome and Firefox resolve it to loopback
 * without asking DNS — but Safari does not special-case subdomains of
 * localhost, and a resolver appending a search domain does not either. An
 * attacker who controls DNS for `evil.localhost` could then rebind it to
 * 127.0.0.1 and reach the API *same-host*, which means the SameSite=Strict
 * session cookie is sent and every defence in §9 passes at once. Naming the one
 * hostname you actually serve costs a line of config and gives an attacker
 * nothing.
 *
 * Entries are normalized the same way an incoming Host header is, so
 * `db.example.com:8080` and `[fd00::1]` match rather than silently never
 * matching.
 */
const EXTRA_HOSTS: readonly string[] = CONFIG.allowedHosts.map((h) =>
  h.startsWith('*.') ? `*.${hostnameOf(h.slice(2))}` : hostnameOf(h),
);

function matchesExtra(host: string): boolean {
  return EXTRA_HOSTS.some((entry) => {
    if (!entry.startsWith('*.')) return entry === host;
    const suffix = entry.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  });
}

/**
 * Host must be a name we actually serve on. A rebinding attack arrives with an
 * attacker-controlled Host header, so an allow-list is the defence (§9).
 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostnameOf(hostHeader);
  if (host === '') return false;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    // Reaching the container by its service name on a compose network is
    // legitimate; `app` is compose.yml's service.
    host === 'app' ||
    host === 'host.docker.internal' ||
    matchesExtra(host)
  );
}

/** Authority as `hostname:port`, with the scheme's default filled in. */
function authority(hostname: string, port: string | undefined, scheme: string): string {
  const fallback = scheme === 'https:' ? '443' : '80';
  return `${hostname}:${port && port !== '' ? port : fallback}`;
}

export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  // Same-origin fetches from the app itself often omit Origin on GET.
  if (!origin) return true;
  if (!hostHeader) return false;
  try {
    const u = new URL(origin);
    // Same-origin means the Origin IS the authority we were reached on. The
    // check this replaced compared the Origin's port to the port this process
    // listens on, which refuses every request behind a proxy — the browser
    // talks to :80 or :443 while the app serves 3456.
    //
    // Both sides are normalized rather than compared as strings: nginx's
    // widely-copied `proxy_set_header Host $host:$server_port` sends
    // `name:443` while the browser's Origin is `https://name` with the default
    // port implied, and a bracketed `[::1]:3456` Origin never equals a bare
    // `::1` Host.
    const originAuthority = authority(hostnameOf(u.host), u.port, u.protocol);
    const hostAuthority = authority(hostnameOf(hostHeader), portOf(hostHeader), u.protocol);
    return originAuthority === hostAuthority;
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
