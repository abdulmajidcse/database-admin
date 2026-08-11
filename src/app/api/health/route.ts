/**
 * Liveness probe (PLAN §10.2 — the container HEALTHCHECK calls this).
 *
 * Deliberately the only /api route that needs neither the session token (see
 * server.ts) nor an unlocked vault: a health check that fails while the app is
 * merely locked would restart a perfectly healthy container. It therefore
 * touches nothing — no app database, no connections, no vault.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IS_CONTAINER } from '@/server/config';
import { handle } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let cachedVersion: string | null = null;

function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  // The custom server runs from the repo root, so package.json is right there.
  // A missing file must not fail the health check.
  try {
    const raw = readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    cachedVersion = process.env.npm_package_version ?? '0.0.0';
  }
  return cachedVersion;
}

export async function GET(): Promise<Response> {
  return handle(() => ({ ok: true, version: appVersion(), container: IS_CONTAINER }));
}
