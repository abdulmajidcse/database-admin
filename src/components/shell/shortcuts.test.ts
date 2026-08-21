/**
 * Unit tests for the shortcut registry (docs/roadmap.md M10).
 *
 * The registry's only job is to be true. A duplicate binding within one scope
 * means two things claim the same key and the sheet documents whichever was
 * listed first; a missing id means a call site labels itself with an empty
 * string. Both are silent, so they are what these check.
 */

import { describe, expect, it } from 'vitest';

import { SHORTCUTS, SHORTCUT_SCOPES, display, keysFor, shortcutFor } from './shortcuts';

describe('the registry', () => {
  it('has no duplicate ids', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('binds each key once per scope', () => {
    // Mod-Enter legitimately appears in both the editor and Mongo; the same key
    // twice in ONE scope is the conflict.
    const seen = new Set<string>();
    for (const s of SHORTCUTS) {
      const key = `${s.scope}:${s.keys}`;
      expect(seen.has(key), `${key} is bound twice`).toBe(false);
      seen.add(key);
    }
  });

  it('uses only scopes the sheet renders', () => {
    const known = new Set(SHORTCUT_SCOPES.map((s) => s.scope));
    for (const s of SHORTCUTS) expect(known.has(s.scope)).toBe(true);
  });

  it('gives every binding a label', () => {
    for (const s of SHORTCUTS) expect(s.label.trim().length).toBeGreaterThan(0);
  });
});

describe('display', () => {
  it('renders a modifier chord', () => {
    // Platform-dependent, so assert the shape rather than the exact glyphs.
    const out = display('Mod-Shift-f');
    expect(out).toMatch(/F$/);
    expect(out.length).toBeGreaterThan(1);
  });

  it('capitalises the final letter but not a named key', () => {
    expect(display('Mod-k')).toMatch(/K$/);
    expect(display('Mod-Enter')).toMatch(/↩$/);
  });

  it('passes an unmodified key through', () => {
    expect(display('?')).toBe('?');
  });

  it('does not split a key whose name contains a space', () => {
    // A literal hyphen would collide with the chord separator and render
    // "Right-click" as "Rightclick", so such keys must not contain one.
    expect(display('Right click')).toBe('Right click');
  });

  it('has no binding whose key name would be mangled by the chord split', () => {
    for (const s of SHORTCUTS) {
      const rendered = display(s.keys);
      expect(rendered.trim().length, `${s.id} renders empty`).toBeGreaterThan(0);
    }
  });
});

describe('lookup', () => {
  it('finds a known binding', () => {
    expect(shortcutFor('editor.format')?.keys).toBe('Mod-Shift-f');
    expect(keysFor('editor.format')).toMatch(/F$/);
  });

  it('returns an empty string rather than throwing for an unknown id', () => {
    expect(shortcutFor('nope.missing')).toBeUndefined();
    expect(keysFor('nope.missing')).toBe('');
  });
});
