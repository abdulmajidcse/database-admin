/**
 * Unit tests for the Host/Origin gate (PLAN §9).
 *
 * This is the DNS-rebinding defence, so the tests that matter most are the ones
 * asserting what stays *out*. A reverse proxy is a legitimate way to reach the
 * app and must work, but widening the allow-list to admit one must not admit
 * an attacker's domain resolving to 127.0.0.1.
 */

import { describe, expect, it } from 'vitest';

import { isAllowedHost, isAllowedOrigin } from './security';

describe('isAllowedHost', () => {
  it('allows the loopback names the app is published on', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'localhost:3456', '[::1]:3456']) {
      expect(isAllowedHost(h), h).toBe(true);
    }
  });

  it('allows a compose service name', () => {
    expect(isAllowedHost('app:3456')).toBe(true);
    expect(isAllowedHost('host.docker.internal:3456')).toBe(true);
  });

  it('refuses a .localhost subdomain unless it was named explicitly', () => {
    // Deliberately NOT allowed wholesale. Chrome and Firefox resolve
    // *.localhost to loopback without asking DNS; Safari does not, so an
    // attacker controlling DNS for evil.localhost could rebind it to 127.0.0.1
    // and reach the API same-host — which sends the SameSite=Strict cookie.
    expect(isAllowedHost('database-admin.localhost')).toBe(false);
    expect(isAllowedHost('evil.localhost')).toBe(false);
    // The degenerate empty first label must not slip through either.
    expect(isAllowedHost('.localhost')).toBe(false);
  });

  it('refuses an attacker domain, including one dressed up to look local', () => {
    for (const h of [
      'evil.com',
      'localhost.evil.com',
      'notlocalhost',
      '127.0.0.1.evil.com',
      'evil.com:3456',
      // The suffix has to be a label boundary, not a substring.
      'xlocalhost',
    ]) {
      expect(isAllowedHost(h), h).toBe(false);
    }
  });

  it('refuses a missing Host header', () => {
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost('')).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('allows a request with no Origin, which same-origin GETs omit', () => {
    expect(isAllowedOrigin(undefined, 'localhost:3456')).toBe(true);
  });

  it('allows an Origin that matches the Host we were reached on', () => {
    expect(isAllowedOrigin('http://localhost:3456', 'localhost:3456')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3456', '127.0.0.1:3456')).toBe(true);
  });

  it('allows a proxied Origin on the default port', () => {
    // Behind Caddy the browser talks to :80 while the app listens on 3456.
    // Comparing the Origin's port to the app's own port rejects this.
    expect(isAllowedOrigin('http://database-admin.localhost', 'database-admin.localhost')).toBe(true);
  });

  it('allows an https proxy in front of a plain-http app', () => {
    expect(isAllowedOrigin('https://database-admin.localhost', 'database-admin.localhost')).toBe(true);
  });

  it('refuses a cross-site Origin', () => {
    expect(isAllowedOrigin('http://evil.com', 'localhost:3456')).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.com', 'localhost:3456')).toBe(false);
  });

  it('matches a Host carrying an explicit default port against an Origin without one', () => {
    // nginx's widely-copied `proxy_set_header Host $host:$server_port` sends
    // name:443 while the browser's Origin implies it.
    expect(isAllowedOrigin('https://localhost', 'localhost:443')).toBe(true);
    expect(isAllowedOrigin('http://localhost', 'localhost:80')).toBe(true);
  });

  it('matches a bracketed IPv6 Origin against a bare IPv6 Host', () => {
    expect(isAllowedOrigin('http://[::1]:3456', '::1:3456')).toBe(false);
    expect(isAllowedOrigin('http://[::1]:3456', '[::1]:3456')).toBe(true);
  });

  it('refuses an allowed-looking Origin that is not the Host we answered on', () => {
    // Both are loopback, but they are still different origins, and a browser
    // making a genuine same-origin request never sends this pair.
    expect(isAllowedOrigin('http://localhost:9999', 'localhost:3456')).toBe(false);
  });

  it('refuses a malformed Origin rather than parsing around it', () => {
    expect(isAllowedOrigin('not a url', 'localhost:3456')).toBe(false);
  });
});
