/**
 * The one place `VaultStatus` is assembled (PLAN §9.3). Each user has their own
 * vault, so "initialized" and "unlocked" are answered for the signed-in user;
 * with nobody signed in there is no vault to describe and both are false.
 *
 * The roots travel with the status because every path in the UI is a CONTAINER
 * path and the picker has to say so (§10.4).
 */

import type { VaultStatus } from '@/lib/api-types';
import { CONFIG, IS_CONTAINER } from '@/server/config';
import { currentUserId } from '@/server/context';
import { vaultFor } from '@/server/vault';

export function vaultStatus(): VaultStatus {
  const userId = currentUserId();
  const vault = userId ? vaultFor(userId) : null;
  return {
    initialized: vault?.isInitialized ?? false,
    unlocked: vault?.isUnlocked ?? false,
    isContainer: IS_CONTAINER,
    sqliteRoot: CONFIG.sqliteRoot,
    exportRoot: CONFIG.exportRoot,
  };
}
