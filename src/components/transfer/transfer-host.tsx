'use client';

/**
 * The transfer host — one mounted `ExportDialog` and one mounted `ImportDialog`
 * for the whole app (PLAN §7.1).
 *
 * Both wizards are opened from four unrelated places: the object tree's context
 * menu, the data grid's toolbar, the SQL editor's toolbar and the command
 * palette. Rendering a copy inside each of them would mean four sets of wizard
 * state, four schema queries and four native-tool probes — so instead each
 * caller states an *intent* and this renders the single dialog for it.
 *
 * Two ways in, deliberately:
 *   - `openExportDialog()` / `openImportDialog()` for callers that already own a
 *     connection id, matching the house style of `openJobsDrawer()`,
 *     `openCommandPalette()` and `openConnectionEditor()`.
 *   - the object-action bus (`onObjectAction`), which is what the tree menu
 *     fires. It exists so the tree never has to import the transfer feature;
 *     see the note on that bus in tree/object-context-menu.tsx.
 *
 * Mounted through the shell's `overlays` slot (components/register.tsx), so it
 * is present for the whole session regardless of which tab is active — the
 * reason a palette-triggered export works with no SQL tab open.
 */

import * as React from 'react';
import { create } from 'zustand';
import type { ExportFormat, ExportRequest } from '@/lib/api-types';
import type { EngineKind } from '@/lib/schema-model';
import { Button, Dialog } from '@/components/ui/primitives';
import { onObjectAction } from '@/components/tree/object-context-menu';
import { ExportDialog } from './export-dialog';
import { ImportDialog } from './import-dialog';
import { NativeToolsPanel } from './native-tools-panel';

export interface ExportIntent {
  connectionId: string | null;
  /** Preselects the scope. Omit to let the dialog ask. */
  source?: ExportRequest['source'];
  /** The statement behind the current result; enables the "current result" scope. */
  sql?: string;
  format?: ExportFormat;
}

export interface ImportIntent {
  connectionId: string | null;
  path?: string;
  target?: { schema?: string; table: string };
}

interface TransferState {
  exportIntent: ExportIntent | null;
  importIntent: ImportIntent | null;
  /**
   * Bumped on every open request, and used as each dialog's `key`.
   *
   * Both wizards seed themselves from their props on the false → true edge of
   * `open` and nowhere else, so a second request arriving while one is already
   * up would be dropped on the floor — and the dialog is not a focus trap, so
   * that is easy to reach: ⌘K opens the palette straight over it. Exporting
   * `public.orders` and then asking to export the current result would keep
   * showing `public.orders`, and Download would write it.
   */
  exportSeq: number;
  importSeq: number;
  /** §7.2: which dump/restore binaries were found, and at what version. */
  toolsFor: EngineKind | null | false;
}

/**
 * A module store rather than context: the openers are called from event
 * handlers and command listeners that are nowhere near this in the tree.
 */
const useTransferStore = create<TransferState>(() => ({
  exportIntent: null,
  importIntent: null,
  exportSeq: 0,
  importSeq: 0,
  // `false` is closed; `null` is open with no engine highlighted.
  toolsFor: false,
}));

/**
 * Each opener bumps its sequence — which is the dialog's `key`, so the wizard
 * remounts and re-seeds even when it was already open — and closes the other,
 * because two `fixed inset-0 z-50` overlays stacked on each other share a single
 * Escape. Clearing the intent and re-setting it would not work: React batches
 * both updates into one render, so `open` never passes through false.
 */
export function openExportDialog(intent: ExportIntent): void {
  useTransferStore.setState((s) => ({
    exportIntent: intent,
    importIntent: null,
    exportSeq: s.exportSeq + 1,
  }));
}

export function openImportDialog(intent: ImportIntent): void {
  useTransferStore.setState((s) => ({
    importIntent: intent,
    exportIntent: null,
    importSeq: s.importSeq + 1,
  }));
}

function closeExport(): void {
  useTransferStore.setState({ exportIntent: null });
}

function closeImport(): void {
  useTransferStore.setState({ importIntent: null });
}

/**
 * The bundled `mysqldump`/`pg_dump`/`mongodump` and their versions (§7.2 "probe
 * PATH at startup and record versions, shown in a panel"). It is the only place
 * that answers "why did my native dump fall back to the built-in engine?", and
 * the export wizard's Advanced section only ever shows the one-line summary.
 */
export function openNativeToolsDialog(engine: EngineKind | null = null): void {
  useTransferStore.setState({ toolsFor: engine });
}

export function TransferHost(): React.ReactElement {
  const exportIntent = useTransferStore((s) => s.exportIntent);
  const importIntent = useTransferStore((s) => s.importIntent);
  const exportSeq = useTransferStore((s) => s.exportSeq);
  const importSeq = useTransferStore((s) => s.importSeq);
  const toolsFor = useTransferStore((s) => s.toolsFor);

  // Claiming the bus is what makes the tree menu's Export…/Import… entries open
  // the wizard instead of falling through to their built-in fallbacks (a fixed
  // CSV download and a bare path prompt).
  React.useEffect(
    () =>
      onObjectAction((request) => {
        if (request.type === 'export') {
          openExportDialog({ connectionId: request.connectionId, source: request.source });
        } else {
          openImportDialog({ connectionId: request.connectionId, target: request.target });
        }
        // Anything but `false` counts as handled.
      }),
    [],
  );

  return (
    <>
      {/* Keyed on the sequence: a fresh request remounts the wizard, which is
          what makes its open-edge reset run again. Remounting is cheap — a
          closed Dialog renders null, and both wizards' queries are gated on
          `open` and share the app-wide query cache. */}
      <ExportDialog
        key={`export-${exportSeq}`}
        open={exportIntent !== null}
        onClose={closeExport}
        connectionId={exportIntent?.connectionId ?? null}
        initialSource={exportIntent?.source}
        sql={exportIntent?.sql}
        defaultFormat={exportIntent?.format}
      />
      <ImportDialog
        key={`import-${importSeq}`}
        open={importIntent !== null}
        onClose={closeImport}
        connectionId={importIntent?.connectionId ?? null}
        initialPath={importIntent?.path}
        initialTarget={importIntent?.target}
      />
      <Dialog
        open={toolsFor !== false}
        onClose={() => useTransferStore.setState({ toolsFor: false })}
        title="Dump and restore tools"
        width="lg"
        footer={<Button onClick={() => useTransferStore.setState({ toolsFor: false })}>Close</Button>}
      >
        {/* The panel is `h-full flex-col`, so it needs a bounded parent. */}
        <div className="h-96">
          <NativeToolsPanel engine={toolsFor === false ? null : toolsFor} />
        </div>
      </Dialog>
    </>
  );
}

/** The shell slot contract passes props this ignores — it is a pure overlay. */
export function TransferSlot(): React.ReactElement {
  return <TransferHost />;
}
