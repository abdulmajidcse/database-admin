/**
 * Vault status and actions (PLAN §9.3).
 *
 * GET is the first thing the shell asks for: it decides between the first-run
 * "choose a master passphrase" screen, the unlock prompt, and the app itself.
 * Reading status never needs an unlocked vault, obviously.
 *
 * POST takes `{ action: 'initialize' | 'unlock' | 'lock' | 'change', … }` and
 * answers with the fresh status, so the client can render the next screen from
 * one round trip. The same operations also live at /api/vault/<action>.
 */

import { asRecord, handle, readJson } from '../lib/respond';
import { normalizeAction, runVaultAction } from '../lib/vault-actions';
import { vaultStatus } from '../lib/vault-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(() => vaultStatus());
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson<unknown>(req));
    return runVaultAction(normalizeAction(body.action), body);
  });
}
