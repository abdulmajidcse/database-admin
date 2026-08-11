'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from 'sonner';

// Side-effect import: attaches every feature pane to the shell's slot/tab
// registry. Without it the workspace renders an empty frame.
import '@/components/register';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Schema and connection metadata are cached deliberately (§6); the
            // UI refetches on explicit action, not on every window focus.
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 30_000,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--bg-panel)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            fontSize: '13px',
          },
        }}
      />
    </QueryClientProvider>
  );
}
