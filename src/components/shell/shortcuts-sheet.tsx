'use client';

/**
 * The keyboard cheat sheet (docs/roadmap.md M10).
 *
 * Rendered entirely from `shortcuts.ts`, so it cannot drift from the registry.
 * Anything added there shows up here with no edit to this file — which is the
 * point of the registry existing at all.
 */

import * as React from 'react';

import { Dialog, Input } from '@/components/ui/primitives';
import { SHORTCUTS, SHORTCUT_SCOPES, display } from './shortcuts';

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = React.useState('');

  const needle = q.trim().toLowerCase();
  const groups = SHORTCUT_SCOPES.map((scope) => ({
    ...scope,
    items: SHORTCUTS.filter(
      (s) =>
        s.scope === scope.scope &&
        (needle === '' ||
          s.label.toLowerCase().includes(needle) ||
          display(s.keys).toLowerCase().includes(needle)),
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <Input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter…"
        className="mb-3"
      />
      <div className="max-h-[60vh] overflow-y-auto pr-1">
        {groups.length === 0 && (
          <p className="py-6 text-center text-xs text-[var(--fg-subtle)]">Nothing matches “{q}”.</p>
        )}
        {groups.map((g) => (
          <section key={g.scope} className="mb-4 last:mb-0">
            <h3 className="mb-1 text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]">{g.title}</h3>
            <ul>
              {g.items.map((s) => (
                <li
                  key={s.id}
                  className="flex items-baseline justify-between gap-4 border-b border-[var(--border)] py-1 last:border-0"
                >
                  <span className="text-xs">{s.label}</span>
                  <kbd className="mono shrink-0 rounded border border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[11px]">
                    {display(s.keys)}
                  </kbd>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
