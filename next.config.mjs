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
    // Same reason as exceljs: bundling it kills the build worker outright with a
    // bare SIGKILL. This entry is necessary but NOT sufficient — transfer/export/
    // zip.ts must also import it dynamically. Removing either brings the failure
    // back; see the note there.
    'archiver',
  ],
  typescript: { ignoreBuildErrors: false },
  experimental: {
    // Large result payloads move through route handlers.
    proxyTimeout: 1000 * 60 * 30,
  },
};

export default nextConfig;
