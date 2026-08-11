/**
 * Vault operations (PLAN §9.3), reachable as `POST /api/vault { action }` and
 * as `POST /api/vault/<action>`. The UI tries the action form first and falls
 * back to the sub-route, so both must behave identically — one implementation
 * is the only way to guarantee it.
 *
 * Each user has their own vault, keyed to their own password (§9.2), so every
 * operation here acts on the signed-in user's vault and nobody else's.
 * Initialization and unlocking now happen as part of register/sign-in; what is
 * left is locking and changing the password.
 */

import type { VaultStatus } from '@/lib/api-types';
import { requireUserId } from '@/server/context';
import { updateVerifier } from '@/server/account';
import { connectionManager } from '@/server/db/manager';
import { connectionsRepo } from '@/server/store/db';
import { vaultFor } from '@/server/vault';
import { badRequest, conflict, HttpError } from './respond';
import { vaultStatus } from './vault-status';

export const MIN_PASSWORD = 8;

export type VaultAction = 'unlock' | 'lock' | 'change';

export function normalizeAction(raw: unknown): VaultAction {
  const value = typeof raw === 'string' ? raw.toLowerCase() : '';
  switch (value) {
    case 'unlock':
      return 'unlock';
    case 'lock':
      return 'lock';
    case 'change':
    case 'change-passphrase':
    case 'change-password':
      return 'change';
    case 'init':
    case 'initialize':
      // Creating a vault is part of creating an account now (§9.2).
      throw conflict('Vaults are created with the account. Use POST /api/account/register.', {
        code: 'USE_REGISTER',
      });
    default:
      throw badRequest('"action" must be one of: unlock, lock, change.');
  }
}

export async function runVaultAction(action: VaultAction, body: Record<string, unknown>): Promise<VaultStatus> {
  switch (action) {
    case 'unlock':
      return unlockVault(body);
    case 'lock':
      return lockVault();
    case 'change':
      return changeVaultPassword(body);
  }
}

export async function unlockVault(body: Record<string, unknown>): Promise<VaultStatus> {
  const password = passwordField(body, ['password', 'passphrase', 'current']);
  const vault = vaultFor(requireUserId());
  if (!vault.isInitialized) {
    throw conflict('This account has no vault. Create the account again.', { code: 'VAULT_UNINITIALIZED' });
  }
  // Verified even when already unlocked: an unlock call is how the UI
  // re-confirms the password, and a wrong one must never report success.
  if (!(await vault.unlock(password))) {
    throw new HttpError('That password is not correct.', 401, { code: 'VAULT_PASSWORD' });
  }
  return vaultStatus();
}

/**
 * Zeroing the key is only half the job: live connections were opened with
 * already-decrypted credentials, and a pinned transaction session outliving a
 * lock would defeat the point. Every link of this user's is closed here; the
 * next query reopens it once they sign in again (§8.3).
 */
export async function lockVault(): Promise<VaultStatus> {
  const userId = requireUserId();
  vaultFor(userId).lock();
  await connectionManager.closeAllFor(userId, 'The vault was locked.');
  return vaultStatus();
}

export async function changeVaultPassword(body: Record<string, unknown>): Promise<VaultStatus> {
  const userId = requireUserId();
  const vault = vaultFor(userId);
  if (!vault.isInitialized) {
    throw conflict('This account has no vault.', { code: 'VAULT_UNINITIALIZED' });
  }
  const current = passwordField(body, ['current', 'currentPassword', 'currentPassphrase', 'oldPassword']);
  const next = passwordField(body, ['next', 'newPassword', 'newPassphrase', 'nextPassword']);
  requireLength(next);

  // Every secret this user owns is decrypted under the old key and re-encrypted
  // under the new one inside a single transaction (store/db.ts `rewrapAll`), so
  // a failure cannot leave half their connections unreadable.
  await vault.changePassword(current, next, (decrypt, encrypt) => connectionsRepo.rewrapAll(decrypt, encrypt));

  // The password signs you in as well as unlocking the vault (§9.2), so the
  // login verifier has to move with it. Done last, and only once the rewrap
  // succeeded: the reverse order could leave a password that opens the account
  // but derives a key no stored credential can be read with.
  await updateVerifier(userId, next);
  return vaultStatus();
}

function passwordField(body: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = body[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw badRequest(`"${names[0]}" is required.`);
}

function requireLength(password: string): void {
  // Mirrors the vault's own rule, so a short password is a 400 with a usable
  // message instead of a 500 out of the crypto layer.
  if (password.length < MIN_PASSWORD) {
    throw badRequest(`The password must be at least ${MIN_PASSWORD} characters.`);
  }
}
