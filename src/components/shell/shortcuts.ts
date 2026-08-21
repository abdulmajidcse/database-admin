'use client';

/**
 * The keyboard map (PLAN §12 M9 "keyboard map"; docs/roadmap.md M10).
 *
 * Every binding in the app is declared here, once, as data. The cheat sheet is
 * rendered from this table rather than maintained beside it — a hand-written
 * sheet is wrong the first time somebody adds a key, and being wrong is worse
 * than being absent, because you stop checking it.
 *
 * This is a registry, not a dispatcher. The handlers stay where they are: the
 * editor's bindings belong to CodeMirror's keymap, the grid's to its own
 * keydown, and both need context this module does not have. What lives here is
 * the *description* — id, keys, scope, label — so one table can drive the sheet
 * and, in time, a rebinding UI.
 *
 * Keys are written in CodeMirror's notation (`Mod-Enter`), since that is where
 * most of them are consumed. `display()` turns them into the symbols a Mac user
 * expects and the words everyone else does.
 */

export type ShortcutScope = 'global' | 'editor' | 'grid' | 'redis' | 'mongo';

export interface Shortcut {
  id: string;
  /** CodeMirror notation: Mod is Cmd on macOS, Ctrl elsewhere. */
  keys: string;
  scope: ShortcutScope;
  label: string;
}

export const SHORTCUT_SCOPES: { scope: ShortcutScope; title: string }[] = [
  { scope: 'global', title: 'Anywhere' },
  { scope: 'editor', title: 'SQL editor' },
  { scope: 'grid', title: 'Results grid' },
  { scope: 'redis', title: 'Redis console' },
  { scope: 'mongo', title: 'MongoDB' },
];

/**
 * The bindings, in the order they should be read rather than the order they
 * were written. Each `id` names the site that owns the handler, so a grep for
 * the id finds the code.
 */
export const SHORTCUTS: Shortcut[] = [
  { id: 'palette.open', keys: 'Mod-k', scope: 'global', label: 'Command palette' },
  { id: 'shortcuts.open', keys: '?', scope: 'global', label: 'Keyboard shortcuts' },
  { id: 'sidebar.toggle', keys: 'Mod-b', scope: 'global', label: 'Toggle the sidebar' },
  { id: 'bottom.toggle', keys: 'Mod-j', scope: 'global', label: 'Toggle the results panel' },
  { id: 'tab.next', keys: 'Mod-Alt-ArrowRight', scope: 'global', label: 'Next tab' },
  { id: 'tab.prev', keys: 'Mod-Alt-ArrowLeft', scope: 'global', label: 'Previous tab' },

  { id: 'editor.runStatement', keys: 'Mod-Enter', scope: 'editor', label: 'Run the statement under the cursor' },
  { id: 'editor.runScript', keys: 'Mod-Shift-Enter', scope: 'editor', label: 'Run the whole script' },
  { id: 'editor.runSelection', keys: 'Mod-r', scope: 'editor', label: 'Run the selection' },
  { id: 'editor.save', keys: 'Mod-s', scope: 'editor', label: 'Save the query' },
  { id: 'editor.format', keys: 'Mod-Shift-f', scope: 'editor', label: 'Format the selection, or the whole buffer' },

  { id: 'grid.copy', keys: 'Mod-c', scope: 'grid', label: 'Copy the selection as TSV' },
  { id: 'grid.copyHeader', keys: 'Mod-Shift-c', scope: 'grid', label: 'Copy with a header row' },
  { id: 'grid.selectAll', keys: 'Mod-a', scope: 'grid', label: 'Select every cell' },
  { id: 'grid.expand', keys: 'Space', scope: 'grid', label: 'Expand the focused cell' },
  { id: 'grid.edit', keys: 'Enter', scope: 'grid', label: 'Edit the focused cell' },
  { id: 'grid.setNull', keys: 'Delete', scope: 'grid', label: 'Set the selection to NULL' },
  { id: 'grid.contextMenu', keys: 'Right click', scope: 'grid', label: 'Foreign keys, and expand' },

  { id: 'redis.clear', keys: 'Mod-l', scope: 'redis', label: 'Clear the console' },
  { id: 'mongo.run', keys: 'Mod-Enter', scope: 'mongo', label: 'Run the query or pipeline' },
];

const IS_APPLE =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const SYMBOL: Record<string, string> = {
  Mod: IS_APPLE ? '⌘' : 'Ctrl',
  Shift: IS_APPLE ? '⇧' : 'Shift',
  Alt: IS_APPLE ? '⌥' : 'Alt',
  Ctrl: IS_APPLE ? '⌃' : 'Ctrl',
  Enter: '↩',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Space: 'Space',
  Delete: IS_APPLE ? '⌫' : 'Del',
};

/** A binding as it should be shown, e.g. `Mod-Shift-f` → `⌘⇧F`. */
export function display(keys: string): string {
  if (!keys.includes('-')) return SYMBOL[keys] ?? keys;
  const parts = keys.split('-');
  const rendered = parts.map((part, i) => {
    if (SYMBOL[part]) return SYMBOL[part];
    // The final part is the key itself; single letters read better capitalised.
    return i === parts.length - 1 && part.length === 1 ? part.toUpperCase() : part;
  });
  // Mac modifiers are conventionally run together; elsewhere they are joined.
  return IS_APPLE ? rendered.join('') : rendered.join('+');
}

/** Look one up, so a call site can label itself from the same table. */
export function shortcutFor(id: string): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** The display string for a binding, or '' when the id is unknown. */
export function keysFor(id: string): string {
  const found = shortcutFor(id);
  return found ? display(found.keys) : '';
}
