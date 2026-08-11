'use client';

/**
 * Theme: light / dark / system (PLAN M9).
 *
 * The choice is written to localStorage under `dbadmin.theme` and applied as
 * `data-theme` on <html>. "system" REMOVES the attribute, because globals.css
 * already resolves the system case through `prefers-color-scheme`. The same key
 * is read by the inline script in layout.tsx so the first paint is never wrong.
 */

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button, cn } from '../ui/primitives';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'dbadmin.theme';
const MODES: ThemeMode[] = ['light', 'dark', 'system'];

let currentMode: ThemeMode = 'system';
let initialized = false;
const listeners = new Set<() => void>();

function isMode(v: unknown): v is ThemeMode {
  return typeof v === 'string' && (MODES as string[]).includes(v);
}

function readStored(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isMode(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

function applyMode(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

export function setThemeMode(mode: ThemeMode): void {
  currentMode = mode;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private-mode browsers still get the theme, just not the memory of it.
  }
  applyMode(mode);
  for (const l of [...listeners]) l();
}

function snapshot(): ThemeMode {
  if (!initialized && typeof window !== 'undefined') {
    currentMode = readStored();
    initialized = true;
  }
  return currentMode;
}

function serverSnapshot(): ThemeMode {
  return 'system';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The mode the user picked, plus what it actually resolves to right now. */
export function useTheme(): { mode: ThemeMode; resolved: 'light' | 'dark'; setMode: (m: ThemeMode) => void } {
  const mode = React.useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [systemDark, setSystemDark] = React.useState(false);

  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Re-assert on mount: the inline script ran before hydration, but a stale
  // attribute (e.g. after a manual localStorage edit) is fixed here.
  React.useEffect(() => {
    applyMode(mode);
  }, [mode]);

  return {
    mode,
    resolved: mode === 'system' ? (systemDark ? 'dark' : 'light') : mode,
    setMode: setThemeMode,
  };
}

export function cycleTheme(): ThemeMode {
  const next = MODES[(MODES.indexOf(snapshot()) + 1) % MODES.length];
  setThemeMode(next);
  return next;
}

const ICONS: Record<ThemeMode, React.ComponentType<{ className?: string }>> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

/** Compact three-state toggle for the status bar. */
export function ThemeToggle({ className }: { className?: string }) {
  const { mode } = useTheme();
  const Icon = ICONS[mode];
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn('px-1.5 text-[var(--fg-muted)]', className)}
      title={`Theme: ${mode} (click to change)`}
      aria-label={`Theme: ${mode}`}
      onClick={() => cycleTheme()}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}
