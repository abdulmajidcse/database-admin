'use client';

/**
 * The only page. Everything else is panes inside the workspace shell.
 *
 * The vault gate wraps it because every connection needs a decryption key that
 * exists only in the server's memory (§9.3) — until it is there, there is
 * nothing useful to render.
 */

import { AuthGate } from '../components/shell/auth-gate';
import { Workspace } from '../components/shell/workspace';

export default function Page() {
  return (
    <AuthGate>
      <Workspace />
    </AuthGate>
  );
}
