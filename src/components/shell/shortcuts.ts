'use client';

/**
 * The keyboard map (PLAN §12 M9 "keyboard map"; docs/roadmap.md M10).
 *
 * Bindings are declared here as data and the cheat sheet is rendered from this
 * table rather than maintained beside it.
 *
 * Be precise about what that buys, because the first draft of this comment
 * overclaimed and the README repeated it: generating the sheet stops it
 * contradicting the table. It does NOT stop the table falling behind the code,
 * because the handlers live elsewhere and nothing cross-checks them. A binding
 * added to the grid's switch and not added here is invisible, and this file was
 * already missing eight of the grid's own keys when it was written. Treat it as
 * documentation that has to be maintained, not as a source of truth.
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
  { id: 'grid.move', keys: 'Arrows', scope: 'grid', label: 'Move the selection' },
  { id: 'grid.extend', keys: 'Shift-Arrows', scope: 'grid', label: 'Extend the selection' },
  { id: 'grid.nextCell', keys: 'Tab', scope: 'grid', label: 'Next cell (Shift-Tab for previous)' },
  { id: 'grid.rowEnds', keys: 'Home', scope: 'grid', label: 'First column (⌘Home for the first cell)' },
  { id: 'grid.rowEnd', keys: 'End', scope: 'grid', label: 'Last column (⌘End for the last cell)' },
  { id: 'grid.page', keys: 'PageDown', scope: 'grid', label: 'Page down (PageUp to go back)' },
  { id: 'grid.clearSelection', keys: 'Escape', scope: 'grid', label: 'Clear the selection' },

  { id: 'redis.clear', keys: 'Mod-l', scope: 'redis', label: 'Clear the console' },
  { id: 'mongo.run', keys: 'Mod-Enter', scope: 'mongo', label: 'Run the query or pipeline' },
];

/**
 * Resolved on each call rather than at import. Evaluating `navigator` at module
 * scope bakes the server's answer (always non-Apple) into anything rendered
 * before hydration, so a label rendered on the server would say Ctrl while the
 * client says ⌘. editor-toolbar's useModifierLabel() defers for the same reason.
 */
function isApple(): boolean {
  return (
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  );
}

function symbols(): Record<string, string> {
  const apple = isApple();
  return {
    Mod: apple ? '⌘' : 'Ctrl',
    Shift: apple ? '⇧' : 'Shift',
    Alt: apple ? '⌥' : 'Alt',
    Ctrl: apple ? '⌃' : 'Ctrl',
    Enter: '↩',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Space: 'Space',
    Delete: apple ? '⌫' : 'Del',
  };
}

/** A binding as it should be shown, e.g. `Mod-Shift-f` → `⌘⇧F`. */
export function display(keys: string): string {
  const SYMBOL = symbols();
  if (!keys.includes('-')) return SYMBOL[keys] ?? keys;
  const parts = keys.split('-');
  const rendered = parts.map((part, i) => {
    if (SYMBOL[part]) return SYMBOL[part];
    // The final part is the key itself; single letters read better capitalised.
    return i === parts.length - 1 && part.length === 1 ? part.toUpperCase() : part;
  });
  // Mac modifiers are conventionally run together; elsewhere they are joined.
  return isApple() ? rendered.join('') : rendered.join('+');
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
