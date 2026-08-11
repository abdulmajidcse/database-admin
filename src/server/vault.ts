/**
 * Credential vault (PLAN §9.3) — one per user.
 *
 * AES-256-GCM with a key derived from that user's password via scrypt. The key
 * lives in process memory only: never on disk, never in the app database.
 * Passwords never travel back to the browser; the API answers `hasPassword`.
 *
 * Why per user rather than one shared vault: connections are private to their
 * owner (§9.2), and a shared key would make that a matter of remembering to add
 * `WHERE owner_id = ?` to every query. With a key per user, another user's
 * secrets are not merely hidden — they cannot be decrypted at all, because the
 * key is derived from a password the process does not have.
 *
 * Keys are held in a `globalThis`-pinned map because this module is loaded
 * twice in one process (see account.ts); two maps would mean signing in on one
 * side and staying locked on the other.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG, paths } from './config';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

interface VaultMeta {
  version: 1;
  salt: string;
  /** Encrypted known plaintext, so a password can be verified without a DB read. */
  check: { nonce: string; blob: string };
}

const CHECK_PLAINTEXT = 'dbadmin-vault-v1';

export class VaultLockedError extends Error {
  constructor() {
    super('Vault is locked. Sign in again to continue.');
    this.name = 'VaultLockedError';
  }
}

const KEY_STORE: unique symbol = Symbol.for('dbadmin.vaultKeys');

type GlobalWithKeys = typeof globalThis & { [KEY_STORE]?: Map<string, Buffer> };

const keys: Map<string, Buffer> = ((): Map<string, Buffer> => {
  const g = globalThis as GlobalWithKeys;
  g[KEY_STORE] ??= new Map<string, Buffer>();
  return g[KEY_STORE];
})();

function ensureHome(): void {
  mkdirSync(CONFIG.home, { recursive: true });
  mkdirSync(paths.tmp(), { recursive: true });
}

function readMeta(userId: string): VaultMeta {
  return JSON.parse(readFileSync(paths.vaultMeta(userId), 'utf8')) as VaultMeta;
}

function encryptWith(key: Buffer, plaintext: string): { blob: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const blob = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { blob, nonce };
}

function decryptWith(key: Buffer, nonce: Buffer, blobWithTag: Buffer): Buffer {
  const tag = blobWithTag.subarray(blobWithTag.length - 16);
  const data = blobWithTag.subarray(0, blobWithTag.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * A handle onto one user's vault. Cheap to construct — the key lives in the
 * shared map, not on the instance — so callers can make one per operation.
 */
export class UserVault {
  constructor(readonly userId: string) {}

  get isInitialized(): boolean {
    return existsSync(paths.vaultMeta(this.userId));
  }

  get isUnlocked(): boolean {
    return keys.has(this.userId);
  }

  /** Called when the account is created; the password is the only input. */
  async initialize(password: string): Promise<void> {
    if (this.isInitialized) throw new Error('Vault already initialized');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    ensureHome();
    const salt = randomBytes(32);
    const key = await scryptAsync(password, salt, 32);
    const { blob, nonce } = encryptWith(key, CHECK_PLAINTEXT);
    const meta: VaultMeta = {
      version: 1,
      salt: salt.toString('base64'),
      check: { nonce: nonce.toString('base64'), blob: blob.toString('base64') },
    };
    writeFileSync(paths.vaultMeta(this.userId), JSON.stringify(meta, null, 2), { mode: 0o600 });
    keys.set(this.userId, key);
  }

  async unlock(password: string): Promise<boolean> {
    if (!this.isInitialized) throw new Error('Vault not initialized');
    const meta = readMeta(this.userId);
    const key = await scryptAsync(password, Buffer.from(meta.salt, 'base64'), 32);
    try {
      const plain = decryptWith(
        key,
        Buffer.from(meta.check.nonce, 'base64'),
        Buffer.from(meta.check.blob, 'base64'),
      );
      const expected = Buffer.from(CHECK_PLAINTEXT, 'utf8');
      if (plain.length !== expected.length || !timingSafeEqual(plain, expected)) return false;
      keys.set(this.userId, key);
      return true;
    } catch {
      return false;
    }
  }

  lock(): void {
    keys.get(this.userId)?.fill(0);
    keys.delete(this.userId);
  }

  private requireKey(): Buffer {
    const key = keys.get(this.userId);
    if (!key) throw new VaultLockedError();
    return key;
  }

  encrypt(plaintext: string): { blob: Buffer; nonce: Buffer } {
    return encryptWith(this.requireKey(), plaintext);
  }

  decrypt(blob: Buffer, nonce: Buffer): string {
    return decryptWith(this.requireKey(), nonce, blob).toString('utf8');
  }

  /** Rewrap every secret this user owns under a new password. */
  async changePassword(
    current: string,
    next: string,
    rewrap: (
      decrypt: (b: Buffer, n: Buffer) => string,
      encrypt: (s: string) => { blob: Buffer; nonce: Buffer },
    ) => void,
  ): Promise<void> {
    if (!(await this.unlock(current))) throw new Error('Current password is incorrect');
    const oldKey = this.requireKey();
    const meta = readMeta(this.userId);
    const salt = Buffer.from(meta.salt, 'base64');
    const newKey = await scryptAsync(next, salt, 32);

    rewrap(
      (b, n) => decryptWith(oldKey, n, b).toString('utf8'),
      (s) => encryptWith(newKey, s),
    );

    const check = encryptWith(newKey, CHECK_PLAINTEXT);
    writeFileSync(
      paths.vaultMeta(this.userId),
      JSON.stringify(
        {
          version: 1,
          salt: meta.salt,
          check: { nonce: check.nonce.toString('base64'), blob: check.blob.toString('base64') },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    keys.set(this.userId, newKey);
  }
}

export function vaultFor(userId: string): UserVault {
  return new UserVault(userId);
}

/** Used at sign-out and when the process wants to forget everything. */
export function lockAllVaults(): void {
  for (const key of keys.values()) key.fill(0);
  keys.clear();
}
