'use client';

/**
 * The front door (PLAN §9.2, §9.3).
 *
 * Sign in, or create an account — one screen with a link between the two.
 * Nothing else in the UI renders until one of them succeeds, because every
 * connection needs that user's vault open.
 *
 * There is one password, not two. It authenticates the session AND derives the
 * AES key for that user's credential vault — with different salts, so the
 * verifier on disk is not the key (server/account.ts explains the derivation).
 * That is why signing in lands you in the app rather than at a second prompt.
 *
 * Accounts do not see each other's connections: each has its own vault, so
 * another user's saved credentials are not merely hidden, they are undecryptable.
 *
 * The password is never stored client-side and never comes back from the API;
 * the session is an HttpOnly cookie this code cannot read.
 */

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, ShieldCheck, UserPlus } from 'lucide-react';
import { api, ApiRequestError } from '../../lib/api-client';
import type { AccountStatus, VaultStatus } from '../../lib/api-types';
import { Button, ErrorBox, Field, Input, Spinner } from '../ui/primitives';

export const ACCOUNT_QUERY_KEY = ['account'] as const;

export function useAccountStatus() {
  return useQuery<AccountStatus>({
    queryKey: ACCOUNT_QUERY_KEY,
    queryFn: () => api.get<AccountStatus>('/api/account'),
    retry: false,
    staleTime: 5_000,
    // The session expires on its own and a restart drops it, so the gate has to
    // be able to reappear without the user having to reload the page.
    refetchInterval: 60_000,
  });
}

/**
 * The vault half of the status, for the parts of the UI that only care about
 * the container roots (§10.4). Kept as its own hook so those call sites do not
 * have to know that the vault now travels inside the account status.
 */
export function useVaultStatus(): { data: VaultStatus | undefined } {
  const account = useAccountStatus();
  return { data: account.data?.vault };
}

type AccountAction = 'register' | 'signin' | 'signout';

/**
 * The account resource takes the action in the body and answers with the fresh
 * status; the same operations also live at /api/account/<action>, so a 404/405
 * on the first form falls back rather than stranding the user at the door.
 */
async function accountAction(action: AccountAction, body: Record<string, unknown> = {}): Promise<AccountStatus> {
  try {
    return await api.post<AccountStatus>('/api/account', { action, ...body });
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 404 || err.status === 405)) {
      return await api.post<AccountStatus>(`/api/account/${action}`, body);
    }
    throw err;
  }
}

export async function signOut(): Promise<AccountStatus> {
  return accountAction('signout');
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAccountStatus();
  const client = useQueryClient();

  // Every action answers with the fresh status, so the next screen renders from
  // one round trip; the refetch is only the fallback path.
  const onDone = React.useCallback(
    async (fresh?: AccountStatus | null) => {
      if (fresh && typeof fresh.signedIn === 'boolean') {
        client.setQueryData(ACCOUNT_QUERY_KEY, fresh);
        return;
      }
      await client.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
    },
    [client],
  );

  if (status.isPending) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }

  // A 401 here would mean the status endpoint itself is gated, which it is not
  // (§9.2) — so any error is a genuine transport failure, not a missing session.
  if (status.isError) {
    return (
      <Centered>
        <div className="w-full max-w-md">
          <ErrorBox
            title="Cannot reach the server"
            message={status.error instanceof Error ? status.error.message : String(status.error)}
            hint="The app is served by its own Node process (PLAN §2). Check that the container is running."
          />
          <div className="mt-3 flex justify-end">
            <Button onClick={() => void status.refetch()}>Retry</Button>
          </div>
        </div>
      </Centered>
    );
  }

  const account = status.data;
  // A live session over a locked vault is reachable — POST /api/vault/lock does
  // exactly that — and every route would answer 423 while the shell sat there
  // looking fine. Signing in again is what re-derives the key, so ask for it.
  const needsAuth = !account.signedIn || !account.vault.unlocked;
  if (!needsAuth) return <>{children}</>;

  // With no account yet there is nothing to sign in to, so registration is the
  // landing screen; otherwise sign-in is, with a link across to registration.
  return <AuthForms initial={account.exists ? 'signin' : 'register'} username={account.username} onDone={onDone} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full w-full items-center justify-center bg-[var(--bg)] p-8">{children}</div>;
}

function Panel({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Centered>
      <div className="w-full max-w-sm border border-[var(--border)] bg-[var(--bg-panel)] p-5 shadow-[var(--shadow)]">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[var(--accent)]">{icon}</span>
          <h1 className="text-[13px] font-semibold">{title}</h1>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-[var(--fg-muted)]">{subtitle}</p>
        {children}
      </div>
    </Centered>
  );
}

type Done = (fresh?: AccountStatus | null) => Promise<void>;
type Mode = 'signin' | 'register';

/**
 * Sign-in and registration are one screen with a link between them, because
 * sign-up is open (server/account.ts): anyone reaching the app can create an
 * account, so registration has to be reachable and not only on first run.
 */
function AuthForms({ initial, username, onDone }: { initial: Mode; username: string | null; onDone: Done }) {
  const [mode, setMode] = React.useState<Mode>(initial);
  return mode === 'register' ? (
    <RegisterForm onDone={onDone} onSwitch={() => setMode('signin')} />
  ) : (
    <SignInForm username={username} onDone={onDone} onSwitch={() => setMode('register')} />
  );
}

/** The link between the two forms. A button, because it is not navigation. */
function SwitchLink({ prompt, action, onClick }: { prompt: string; action: string; onClick: () => void }) {
  return (
    <p className="mt-1 text-center text-xs text-[var(--fg-muted)]">
      {prompt}{' '}
      <button
        type="button"
        onClick={onClick}
        className="text-[var(--accent)] underline underline-offset-2 hover:opacity-80"
      >
        {action}
      </button>
    </p>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function RegisterForm({ onDone, onSwitch }: { onDone: Done; onSwitch: () => void }) {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const shortName = username.length > 0 && username.trim().length < 3;
  const shortPassword = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = username.trim().length >= 3 && password.length >= 8 && confirm === password;

  const create = useMutation({
    mutationFn: () => accountAction('register', { username: username.trim(), password }),
    onSuccess: (fresh) => onDone(fresh),
    onError: (err: unknown) => setError(errorMessage(err)),
  });

  return (
    <Panel
      icon={<ShieldCheck className="size-4" />}
      title="Create your account"
      subtitle={
        <>
          Accounts live only on this machine — nothing is registered anywhere. Your connections are private to this
          account: the password encrypts them with AES-256-GCM under a key only it derives, held in the server
          process&apos;s memory and never written to disk.{' '}
          <span className="text-[var(--warn)]">There is no recovery: forget it and the saved credentials are gone.</span>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (ready && !create.isPending) create.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <Field label="Username" error={shortName ? 'At least 3 characters.' : undefined}>
          <Input
            value={username}
            autoFocus
            autoComplete="username"
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Password" error={shortPassword ? 'At least 8 characters.' : undefined}>
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm password" error={mismatch ? 'The two entries differ.' : undefined}>
          <Input
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        {error && <ErrorBox message={error} />}
        <Button
          type="submit"
          variant="primary"
          size="md"
          icon={<UserPlus className="size-3.5" />}
          disabled={!ready}
          loading={create.isPending}
        >
          Create account
        </Button>
      </form>
      <SwitchLink prompt="Already have an account?" action="Sign in" onClick={onSwitch} />
    </Panel>
  );
}

function SignInForm({
  username: stored,
  onDone,
  onSwitch,
}: {
  username: string | null;
  onDone: Done;
  onSwitch: () => void;
}) {
  const [username, setUsername] = React.useState(stored ?? '');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const signin = useMutation({
    mutationFn: () => accountAction('signin', { username: username.trim(), password }),
    onSuccess: (fresh) => onDone(fresh),
    onError: (err: unknown) => {
      setError(errorMessage(err));
      setPassword('');
    },
  });

  const ready = username.trim().length > 0 && password.length > 0;

  return (
    <Panel
      icon={<LogIn className="size-4" />}
      title="Sign in"
      subtitle="Your password unlocks the credential vault for this session, so saved connections can be decrypted."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (ready && !signin.isPending) signin.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <Field label="Username">
          <Input
            value={username}
            // The password is the field that needs filling when the username is
            // already known, which it is on every visit after the first.
            autoFocus={!stored}
            autoComplete="username"
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            autoFocus={Boolean(stored)}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <ErrorBox message={error} />}
        <Button
          type="submit"
          variant="primary"
          size="md"
          icon={<LogIn className="size-3.5" />}
          disabled={!ready}
          loading={signin.isPending}
        >
          Sign in
        </Button>
      </form>
      <SwitchLink prompt="No account yet?" action="Create one" onClick={onSwitch} />
    </Panel>
  );
}
