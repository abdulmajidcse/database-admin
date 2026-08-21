/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Native + heavy drivers must never be bundled: they are loaded by the custom
  // server and the route handlers at runtime (PLAN §2 — Node runtime only).
  serverExternalPackages: [
    'better-sqlite3',
    'mysql2',
    'pg',
    'pg-cursor',
    'pg-copy-streams',
    'ioredis',
    'mongodb',
    'ssh2',
    'ws',
    'exceljs',
  ],
  // Next 16 blocks cross-origin requests to /_next/* dev resources, allowing only
  // `localhost`, `**.localhost` and the `hostname` handed to next() — which is
  // 0.0.0.0 in the container (src/server/config.ts). But the port is published on
  // 127.0.0.1 (§9, §10.2) and the container is also reachable by service name on
  // the compose network, so without naming those here every chunk 403s in dev
  // while the HTML shell still loads — a blank page with a spinner.
  // Mirrors isAllowedHost() in src/server/security.ts.
  allowedDevOrigins: ['127.0.0.1', '[::1]', '0.0.0.0', 'app', 'host.docker.internal'],
  typescript: { ignoreBuildErrors: false },
  experimental: {
    // Large result payloads move through route handlers.
    proxyTimeout: 1000 * 60 * 30,
  },
};

export default nextConfig;
