/**
 * Accounts and sessions (PLAN §9.2).
 *
 * This replaces the per-install token that used to ride in a header. The token
 * worked, but it made the app unusable the moment you opened the bare URL: the
 * only way in was to copy a 64-character string out of the container logs.
 *
 * What stops a cross-site request, now that no secret is in the header:
 *
 *   1. The session cookie is `SameSite=Strict`, so a request originating from
 *      any other site simply does not carry it — including form POSTs, which is
 *      what a header token was protecting against in the first place.
 *   2. The Host/Origin allow-list in security.ts is unchanged, and that — not
 *      the token — was always the real answer to DNS rebinding.
 *
 * Sign-up is open: anyone who can reach the port can create an account. The
 * port is bound to 127.0.0.1, so that means local processes and anyone with a
 * shell on this machine — not the internet. Connections are private per user
 * (see vault.ts), so a new account starts empty and can read nothing existing.
 *
 * One password does two jobs, deliberately:
 *   - it authenticates the session, and
 *   - it derives the AES key for that user's credential vault (§9.3).
 *
 * They are derived with DIFFERENT salts, so the verifier sitting on disk is not
 * the vault key and cannot be turned into it. Signing in unlocks the vault in
 * the same step, which is why there is one prompt rather than two.
 *
 * Sessions live in memory only. A restart signs everyone out — that is not an
 * oversight: vault keys are memory-only too, so after a restart the password is
 * needed regardless. Persisting sessions would only create the illusion of
 * being signed in to a vault that is locked.
 */

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { CONFIG, paths } from './config';
import { vaultFor } from './vault';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export const MIN_PASSWORD = 8;
export const SESSION_COOKIE = 'dbadmin_session';

/** Idle timeout. Long enough for a working day, short enough to matter. */
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

export interface UserRecord {
  id: string;
  username: string;
  /** Salt for the login verifier — NOT the vault salt (see the file header). */
  salt: string;
  verifier: string;
  createdAt: string;
}

interface AccountsFile {
  version: 2;
  users: UserRecord[];
}

interface Session {
  id: string;
  userId: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * The session store is pinned to `globalThis`, and that is load-bearing.
 *
 * This module is loaded TWICE in one process: once by tsx for server.ts, which
 * runs the edge check on every /api request, and once inside Next's bundle for
 * the route handlers that create sessions. Those are separate module registries
 * with separate module scopes, so a plain `const sessions = new Map()` gives the
 * two halves a Map each — sign-in would succeed in the route and every
 * subsequent request would still be rejected at the edge.
 *
 * `globalThis` is per-process, not per-registry, so both halves land on the
 * same Map. (The old header token avoided this only by living on disk.)
 *
 * Symbol.for(), not Symbol(): the registry lookup is what makes the two module
 * instances agree on the same key.
 */
const SESSION_STORE: unique symbol = Symbol.for('dbadmin.sessions');

type GlobalWithSessions = typeof globalThis & { [SESSION_STORE]?: Map<string, Session> };

const sessions: Map<string, Session> = ((): Map<string, Session> => {
  const g = globalThis as GlobalWithSessions;
  g[SESSION_STORE] ??= new Map<string, Session>();
  return g[SESSION_STORE];
})();

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

// --- storage ---------------------------------------------------------------

function emptyFile(): AccountsFile {
  return { version: 2, users: [] };
}

/**
 * Reads the accounts file, migrating the single-account format on the way.
 *
 * The v1 layout was one record in `account.json` with one vault at
 * `vault.json`. That user keeps working: they get an id, the vault file is
 * renamed onto it, and their existing connections are claimed by
 * `claimOrphanConnections()` in store/db.ts. Their password is unchanged —
 * the salt travels inside the vault file, so the same key still derives.
 */
function readAccounts(): AccountsFile {
  const file = paths.accountsFile();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as AccountsFile;
      if (Array.isArray(parsed.users)) return parsed;
    } catch {
      /* fall through to migration / empty */
    }
  }

  const legacy = paths.legacyAccountFile();
  if (!existsSync(legacy)) return emptyFile();

  try {
    const old = JSON.parse(readFileSync(legacy, 'utf8')) as Omit<UserRecord, 'id'>;
    const migrated: UserRecord = { ...old, id: randomUUID() };
    const legacyVault = paths.legacyVaultMeta();
    if (existsSync(legacyVault) && !existsSync(paths.vaultMeta(migrated.id))) {
      renameSync(legacyVault, paths.vaultMeta(migrated.id));
    }
    const next: AccountsFile = { version: 2, users: [migrated] };
    writeAccounts(next);
    unlinkSync(legacy);
    return next;
  } catch {
    return emptyFile();
  }
}

/**
 * Written via a temp file and renamed, because a half-written accounts file is
 * an account nobody can sign in to and which cannot be repaired from the UI.
 */
function writeAccounts(data: AccountsFile): void {
  mkdirSync(CONFIG.home, { recursive: true });
  const file = paths.accountsFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function findUser(username: string): UserRecord | undefined {
  const wanted = username.trim().toLowerCase();
  return readAccounts().users.find((u) => u.username.toLowerCase() === wanted);
}

export function userById(id: string): UserRecord | undefined {
  return readAccounts().users.find((u) => u.id === id);
}

export function anyAccountExists(): boolean {
  return readAccounts().users.length > 0;
}

export function listUsernames(): string[] {
  return readAccounts().users.map((u) => u.username);
}

/** How many accounts exist — decides whether pre-multi-user rows are claimed. */
export function readAccountsCount(): number {
  return readAccounts().users.length;
}

// --- validation ------------------------------------------------------------

export function normalizeUsername(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length < 3 || value.length > 64) {
    throw new AccountError('Username must be between 3 and 64 characters.', 400, 'USERNAME_LENGTH');
  }
  if (!/^[\w.@ -]+$/u.test(value)) {
    throw new AccountError(
      'Username may contain letters, numbers, spaces and . _ - @ only.',
      400,
      'USERNAME_CHARS',
    );
  }
  return value;
}

export function requirePassword(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  if (value.length < MIN_PASSWORD) {
    throw new AccountError(`Password must be at least ${MIN_PASSWORD} characters.`, 400, 'PASSWORD_LENGTH');
  }
  return value;
}

// --- sessions --------------------------------------------------------------

function newSession(user: UserRecord): string {
  const id = randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, { id, userId: user.id, username: user.username, createdAt: now, lastSeenAt: now });
  return id;
}

export function sessionFromCookie(cookieHeader: string | undefined): Session | null {
  const id = readCookie(cookieHeader, SESSION_COOKIE);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.lastSeenAt > SESSION_IDLE_MS) {
    sessions.delete(id);
    return null;
  }
  session.lastSeenAt = Date.now();
  return session;
}

export function currentSessionId(cookieHeader: string | undefined): string | null {
  return readCookie(cookieHeader, SESSION_COOKIE);
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * `SameSite=Strict` is the CSRF defence now that no token rides in a header —
 * see the file header. `Secure` is deliberately conditional: this app is served
 * over plain HTTP on loopback, and a Secure cookie would be silently dropped.
 */
export function sessionCookie(id: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_IDLE_MS / 1000)}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// --- operations ------------------------------------------------------------

/**
 * Creates an account and its vault under the same password, then signs the
 * browser in. Open to anyone who can reach the port — see the file header.
 */
export async function register(usernameRaw: unknown, passwordRaw: unknown): Promise<Session> {
  const username = normalizeUsername(usernameRaw);
  const password = requirePassword(passwordRaw);

  if (findUser(username)) {
    throw new AccountError('That username is already taken.', 409, 'USERNAME_TAKEN');
  }

  const user: UserRecord = {
    id: randomUUID(),
    username,
    salt: '',
    verifier: '',
    createdAt: new Date().toISOString(),
  };

  // The vault goes first: if it fails, nothing has been written and the user
  // can simply try again. The reverse order would leave an account whose vault
  // cannot be created because a stale meta file is in the way.
  await vaultFor(user.id).initialize(password);

  const salt = randomBytes(32);
  user.salt = salt.toString('base64');
  user.verifier = (await scryptAsync(password, salt, 32)).toString('base64');

  const data = readAccounts();
  // Re-checked after the await: two sign-ups racing on the same name would
  // otherwise both pass the check above and the second would shadow the first.
  if (data.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    vaultFor(user.id).lock();
    throw new AccountError('That username is already taken.', 409, 'USERNAME_TAKEN');
  }
  data.users.push(user);
  writeAccounts(data);

  const id = newSession(user);
  return sessions.get(id)!;
}

/** Verifies the password, unlocks that user's vault, returns the session. */
export async function signIn(usernameRaw: unknown, passwordRaw: unknown): Promise<Session> {
  const username = typeof usernameRaw === 'string' ? usernameRaw.trim() : '';
  const password = typeof passwordRaw === 'string' ? passwordRaw : '';
  const user = findUser(username);

  // Compared even when the user does not exist, so a missing account and a
  // wrong password cost the same time and report the same message.
  const expected = user ? Buffer.from(user.verifier, 'base64') : randomBytes(32);
  const salt = user ? Buffer.from(user.salt, 'base64') : randomBytes(32);
  const actual = await scryptAsync(password, salt, expected.length);
  const passwordOk = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!user || !passwordOk) {
    throw new AccountError('Incorrect username or password.', 401, 'BAD_CREDENTIALS');
  }

  // Same password, different salt: this is the vault key derivation, and it has
  // to succeed or the session would be signed in to a vault it cannot read.
  if (!(await vaultFor(user.id).unlock(password))) {
    throw new AccountError(
      'Signed in, but your credential vault did not accept that password. Its file may be missing or from another install.',
      500,
      'VAULT_MISMATCH',
    );
  }

  const id = newSession(user);
  return sessions.get(id)!;
}

/**
 * Drops the session and locks that user's vault — but only if this was their
 * last session. Signing out of one tab must not lock a vault another tab is
 * still using.
 */
export function signOut(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  sessions.delete(sessionId);
  const stillSignedIn = [...sessions.values()].some((s) => s.userId === session.userId);
  if (!stillSignedIn) vaultFor(session.userId).lock();
  return session.userId;
}

/**
 * Rewrites a user's stored verifier after their vault has re-wrapped its
 * secrets under a new password. Called only by the change-password flow, and
 * only once the vault half has succeeded — otherwise the login password and the
 * vault key would disagree and the account would open onto an unreadable vault.
 */
export async function updateVerifier(userId: string, password: string): Promise<void> {
  const data = readAccounts();
  const user = data.users.find((u) => u.id === userId);
  if (!user) throw new AccountError('No such account.', 404, 'NO_ACCOUNT');
  const salt = randomBytes(32);
  user.salt = salt.toString('base64');
  user.verifier = (await scryptAsync(password, salt, 32)).toString('base64');
  writeAccounts(data);
}

/**
 * Test/dev escape hatch (DBADMIN_DISABLE_AUTH=1): a fixed account so the smoke
 * tests can drive the app without a sign-in round trip. Never reachable in
 * production config.
 */
export async function autoProvisionForTests(): Promise<Session | null> {
  if (!CONFIG.disableAuth) return null;
  mkdirSync(CONFIG.home, { recursive: true });
  const existing = findUser('test');
  if (existing) {
    await vaultFor(existing.id).unlock('test-passphrase');
    const id = newSession(existing);
    return sessions.get(id)!;
  }
  return register('test', 'test-passphrase');
}

/** The fixed test session, so the edge check can attach a user context. */
export function testSession(): Session | undefined {
  return [...sessions.values()][0];
}
