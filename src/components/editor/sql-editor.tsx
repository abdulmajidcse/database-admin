'use client';

/**
 * The SQL editor (PLAN M2).
 *
 * CodeMirror 6 with `@codemirror/lang-sql`, wired to the canonical schema model
 * for completion (see ./completion) and to the query runner for execution.
 *
 * Three details that are the whole point of this file:
 *
 *  1. **The active statement is highlighted from the SERVER's lexer.**
 *     `statementAtOffset` lives in `server/db/sql/lexer.ts`, a pure module with
 *     no Node imports written to be shared with the editor (its own header says
 *     so). Running the same function the route runs is what makes "the bit that
 *     lit up" and "the bit that executed" provably the same text — a browser
 *     re-implementation would drift on the first dollar-quoted function body.
 *  2. **Engine errors land on the offending character.** `StatementResult.error.
 *     position` is statement-relative and 1-based; the runner maps it back onto
 *     the buffer and it is underlined here.
 *  3. **The buffer lives in the persisted workspace tab state**, so a reload, a
 *     crashed tunnel or a closed laptop lid does not cost you the query you were
 *     writing (§8.3).
 */

import * as React from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { Prec, Range, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, PlugZap } from 'lucide-react';

import { api } from '@/lib/api-client';
import type { SchemaResponse } from '@/lib/api-types';
import type { EngineKind, SchemaModel } from '@/lib/schema-model';
import type { Cell } from '@/lib/wire';
import { Button, ConfirmDialog, EmptyState } from '@/components/ui/primitives';
import { registerTabView, registerWorkspaceSlot, type SlotProps, type TabViewProps } from '@/components/shell/workspace';
import { useConnections } from '@/components/shell/connection-sidebar';
import {
  emitWorkspaceCommand,
  onWorkspaceCommand,
  useConnectionState,
  useWorkspaceStore,
} from '@/state/workspace-store';
import {
  errorMarksFor,
  forgetRunnerState,
  onRevealOffset,
  totalRowCount,
  useQueryRunner,
  type ErrorMark,
  type RunSpec,
} from '@/hooks/use-query-runner';
import { statementAtOffset, type SqlDialect } from '@/server/db/sql/lexer';
import { FormatRefusedError, formatSql } from '@/server/db/sql/format';
import { lexerDialect, sqlLanguageExtension } from './completion';
import { EditorToolbar } from './editor-toolbar';
import { ParamsBar } from './params-bar';
import { ResultTabs } from './result-tabs';

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

const activeStatementMark = Decoration.mark({ class: 'cm-activeStatement' });

function activeStatementDecorations(state: EditorState, dialect: SqlDialect): DecorationSet {
  // A non-empty selection means "run this selection", so the statement halo
  // would only add noise.
  if (!state.selection.main.empty) return Decoration.none;
  const statement = statementAtOffset(state.doc.toString(), state.selection.main.head, dialect);
  if (!statement || statement.end <= statement.start) return Decoration.none;
  return Decoration.set([activeStatementMark.range(statement.start, statement.end)]);
}

function activeStatementField(dialect: SqlDialect): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => activeStatementDecorations(state, dialect),
    update: (value, tr) =>
      tr.docChanged || tr.selection ? activeStatementDecorations(tr.state, dialect) : value,
    provide: (field) => EditorView.decorations.from(field),
  });
}

const setErrorMarks = StateEffect.define<ErrorMark[]>();

function errorDecorations(state: EditorState, marks: ErrorMark[]): DecorationSet {
  const length = state.doc.length;
  const text = state.doc.toString();
  const ranges: Range<Decoration>[] = [];
  for (const mark of marks) {
    const from = Math.max(0, Math.min(mark.offset, Math.max(0, length - 1)));
    // Underline the whole token the engine pointed at; a single character is
    // almost invisible at 12px.
    let to = from + 1;
    while (to < length && /[\w$".`]/.test(text.charAt(to))) to++;
    if (to > length) to = length;
    if (from >= to) continue;
    ranges.push(
      Decoration.mark({ class: 'cm-sqlError', attributes: { title: mark.message } }).range(from, to),
    );
  }
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges);
}

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setErrorMarks)) next = errorDecorations(tr.state, effect.value);
    }
    // Typing clears a stale underline: the offset no longer means anything.
    if (tr.docChanged && !tr.effects.some((e) => e.is(setErrorMarks))) return Decoration.none;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const editorTheme = EditorView.theme({
  '&': { fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
  '.cm-content': { padding: '4px 0' },
  '.cm-activeStatement': { backgroundColor: 'var(--bg-subtle)' },
  '.cm-sqlError': {
    textDecoration: 'underline wavy var(--danger)',
    textUnderlineOffset: '3px',
    backgroundColor: 'var(--danger-bg)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    color: 'var(--fg)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--selection)',
    color: 'var(--fg)',
  },
  '.cm-completionDetail': { color: 'var(--fg-subtle)', fontStyle: 'normal', marginLeft: '8px' },
});

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  autocompletion: true,
  closeBrackets: true,
  bracketMatching: true,
  searchKeymap: true,
  tabSize: 2,
} as const;

// ---------------------------------------------------------------------------
// SqlEditor
// ---------------------------------------------------------------------------

export interface EditorHandle {
  getSql: () => string;
  getCursor: () => number;
  getSelection: () => { from: number; to: number; text: string } | null;
  setSql: (next: string) => void;
  reveal: (offset: number) => void;
  focus: () => void;
  format: () => void;
}

export interface SqlEditorProps {
  value: string;
  onChange: (next: string) => void;
  engine: EngineKind | null;
  model: SchemaModel | null;
  defaultSchema?: string;
  readOnly?: boolean;
  errorMarks: ErrorMark[];
  onRunStatement: () => void;
  onRunScript: () => void;
  onRunSelection: () => void;
  onSave: () => void;
}

export const SqlEditor = React.forwardRef<EditorHandle, SqlEditorProps>(function SqlEditor(props, ref) {
  const viewRef = React.useRef<ReactCodeMirrorRef>(null);
  const dark = useIsDark();
  const dialect = lexerDialect(props.engine);

  // Keybinding callbacks change identity on every render; routing them through
  // a ref keeps the keymap extension stable so CodeMirror is not reconfigured
  // on each keystroke.
  const handlers = React.useRef(props);
  handlers.current = props;

  const language = React.useMemo(
    () =>
      sqlLanguageExtension({
        engine: props.engine,
        model: props.model,
        defaultSchema: props.defaultSchema,
      }),
    [props.engine, props.model, props.defaultSchema],
  );

  const doFormat = React.useCallback(() => {
    const view = viewRef.current?.view;
    if (!view) return;
    const dialect = lexerDialect(handlers.current.engine);
    // Selection if there is one, whole document otherwise — predictable, and it
    // lets you format one statement of a long script without touching the rest.
    const range = view.state.selection.main;
    const hasSelection = !range.empty;
    const from = hasSelection ? range.from : 0;
    const to = hasSelection ? range.to : view.state.doc.length;
    const current = view.state.doc.sliceString(from, to);

    let next: string;
    try {
      next = formatSql(current, dialect);
    } catch (err) {
      // The guard refused: the statement count or a statement's kind changed,
      // so the buffer is left exactly as it was and the user is told why.
      if (err instanceof FormatRefusedError) {
        toast.error(err.message);
        return;
      }
      throw err;
    }
    if (next === current) return;
    view.dispatch({ changes: { from, to, insert: next } });
  }, []);

  const keys = React.useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              handlers.current.onRunStatement();
              return true;
            },
          },
          {
            key: 'Mod-Shift-Enter',
            preventDefault: true,
            run: () => {
              handlers.current.onRunScript();
              return true;
            },
          },
          {
            // Ctrl-R is the browser's reload, so this must claim the event.
            key: 'Mod-r',
            preventDefault: true,
            run: () => {
              handlers.current.onRunSelection();
              return true;
            },
          },
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              handlers.current.onSave();
              return true;
            },
          },
          {
            key: 'Mod-Shift-f',
            preventDefault: true,
            run: () => {
              doFormat();
              return true;
            },
          },
        ]),
      ),
    [doFormat],
  );

  const extensions = React.useMemo<Extension[]>(
    () => [keys, language, activeStatementField(dialect), errorField, editorTheme, EditorView.lineWrapping],
    [keys, language, dialect],
  );

  // Error underlines are pushed in as an effect rather than rebuilt into the
  // extension list, so a failed run does not reset the editor's own state.
  React.useEffect(() => {
    const view = viewRef.current?.view;
    if (!view) return;
    view.dispatch({ effects: setErrorMarks.of(props.errorMarks) });
  }, [props.errorMarks]);

  React.useImperativeHandle(
    ref,
    (): EditorHandle => ({
      getSql: () => viewRef.current?.view?.state.doc.toString() ?? props.value,
      getCursor: () => viewRef.current?.view?.state.selection.main.head ?? 0,
      getSelection: () => {
        const view = viewRef.current?.view;
        if (!view) return null;
        const range = view.state.selection.main;
        if (range.empty) return null;
        return { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) };
      },
      setSql: (next: string) => {
        const view = viewRef.current?.view;
        if (!view) {
          props.onChange(next);
          return;
        }
        // A normal dispatch, so Cmd-Z brings back whatever was there before.
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
          selection: { anchor: Math.min(next.length, view.state.selection.main.head) },
        });
        view.focus();
      },
      reveal: (offset: number) => {
        const view = viewRef.current?.view;
        if (!view) return;
        const pos = Math.max(0, Math.min(offset, view.state.doc.length));
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
        view.focus();
      },
      focus: () => viewRef.current?.view?.focus(),
      format: doFormat,
    }),
    [doFormat, props],
  );

  return (
    <CodeMirror
      ref={viewRef}
      value={props.value}
      onChange={props.onChange}
      height="100%"
      className="h-full"
      theme={dark ? githubDark : githubLight}
      basicSetup={BASIC_SETUP}
      editable={!props.readOnly}
      readOnly={props.readOnly}
      indentWithTab
      extensions={extensions}
      placeholder="SELECT …   ⌘↩ statement · ⇧⌘↩ script · ⌘R selection"
    />
  );
});

/** The resolved theme, read from the same `data-theme` attribute the shell sets. */
function useIsDark(): boolean {
  const [dark, setDark] = React.useState(false);
  React.useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const resolve = (): void => {
      const attribute = root.getAttribute('data-theme');
      setDark(attribute === 'dark' || (attribute === null && media.matches));
    };
    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    media.addEventListener('change', resolve);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', resolve);
    };
  }, []);
  return dark;
}

// ---------------------------------------------------------------------------
// SqlWorkspace — the tab view
// ---------------------------------------------------------------------------

interface PendingRun {
  spec: RunSpec;
  title: string;
  message: React.ReactNode;
  confirmWord?: string;
}

export function SqlWorkspace({ tab }: TabViewProps) {
  const connections = useConnections();
  const connection = connections.data?.connections.find((c) => c.id === tab.connectionId) ?? null;
  const engine: EngineKind | null = connection?.engine ?? null;
  const connectionState = useConnectionState(tab.connectionId);

  const editorRef = React.useRef<EditorHandle>(null);
  const runner = useQueryRunner(tab.id, tab.connectionId, engine);
  const [pending, setPending] = React.useState<PendingRun | null>(null);

  const sql = typeof tab.state.sql === 'string' ? tab.state.sql : '';
  const database = typeof tab.state.database === 'string' ? tab.state.database : undefined;
  const schema = typeof tab.state.schema === 'string' ? tab.state.schema : undefined;
  const txMode = tab.state.txMode === true;
  // Kept on the tab so a reload does not lose the values you just typed, the
  // same way the SQL itself and the transaction toggle are kept.
  const paramValues = (tab.state.params ?? {}) as Record<string, Cell>;

  const setSql = React.useCallback(
    (next: string) => useWorkspaceStore.getState().setTabState(tab.id, { sql: next }),
    [tab.id],
  );

  const schemaQuery = useQuery<SchemaResponse>({
    queryKey: ['schema', tab.connectionId],
    queryFn: () => api.get<SchemaResponse>(`/api/schema?connectionId=${encodeURIComponent(tab.connectionId ?? '')}`),
    enabled: !!tab.connectionId && connectionState === 'connected',
    retry: false,
    staleTime: 60_000,
  });

  // ---- execution -----------------------------------------------------------

  const execute = React.useCallback(
    async (spec: RunSpec): Promise<void> => {
      useWorkspaceStore.getState().setBottomTab('results');
      const outcome = await runner.run(spec);
      if (outcome.kind === 'needs-confirmation') {
        // The server withheld the script (§9). Its phrase is authoritative.
        setPending({
          spec: { ...spec, confirm: outcome.phrase },
          title: 'Confirm before this runs',
          message: (
            <ul className="list-disc pl-4">
              {outcome.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          ),
          confirmWord: outcome.phrase,
        });
        return;
      }
      if (outcome.kind === 'error') toast.error(outcome.message);
    },
    [runner],
  );

  /**
   * §9 destructive guard. A DROP/TRUNCATE or an unqualified UPDATE/DELETE always
   * asks; a prod connection asks for anything that writes. Pure reads on prod go
   * straight through — the red header is the standing reminder, and a dialog on
   * every SELECT trains people to type the phrase without reading it.
   */
  const launch = React.useCallback(
    (rawSpec: RunSpec): void => {
      if (!tab.connectionId) {
        toast.error('Pick a connection for this tab first.');
        return;
      }
      // Every run path funnels through here, so the bind values are attached
      // once rather than at each of the three call sites.
      const spec: RunSpec = { ...rawSpec, params: paramValues };
      const verdict = runner.destructive(spec.sql);
      const prodWrite = connection?.envTag === 'prod' && runner.writes(spec.sql);
      if (!verdict.destructive && !prodWrite) {
        void execute(spec);
        return;
      }
      const target = verdict.reason ?? 'a write against a production database';
      setPending({
        spec: { ...spec, confirm: connection?.name },
        title: verdict.destructive ? 'This destroys data' : 'Production write',
        message: (
          <div className="flex flex-col gap-2">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" />
              <span>
                About to run <strong>{target}</strong> on <strong>{connection?.name}</strong>
                {database ? ` · ${database}` : ''}.
              </span>
            </p>
            {verdict.unqualified && (
              <p className="text-[var(--danger)]">There is no WHERE clause, so every row is affected.</p>
            )}
          </div>
        ),
        confirmWord: connection?.name,
      });
    },
    [connection, database, execute, runner, tab.connectionId],
  );

  const runStatement = React.useCallback(() => {
    const text = editorRef.current?.getSql() ?? sql;
    const cursor = editorRef.current?.getCursor() ?? 0;
    const statement = runner.statementAt(text, cursor);
    if (!statement) {
      toast.error('There is no runnable statement under the cursor.');
      return;
    }
    launch({
      sql: statement.text,
      mode: 'statement',
      baseOffset: statement.start,
      database,
      schema,
      atomic: txMode,
    });
  }, [database, launch, runner, schema, sql, txMode]);

  const runScript = React.useCallback(() => {
    const text = editorRef.current?.getSql() ?? sql;
    launch({ sql: text, mode: 'script', baseOffset: 0, database, schema, atomic: txMode });
  }, [database, launch, schema, sql, txMode]);

  const runSelection = React.useCallback(() => {
    const selection = editorRef.current?.getSelection();
    if (!selection || selection.text.trim() === '') {
      toast.message('Select some SQL first, or use ⌘↩ to run the statement under the cursor.');
      return;
    }
    launch({
      sql: selection.text,
      mode: 'selection',
      baseOffset: selection.from,
      database,
      schema,
      atomic: txMode,
    });
  }, [database, launch, schema, txMode]);

  // ---- wiring --------------------------------------------------------------

  React.useEffect(() => onRevealOffset(tab.id, (offset) => editorRef.current?.reveal(offset)), [tab.id]);

  // The bus subscription is registered once per tab: the handlers travel in a
  // ref so a keystroke (which re-renders this component) does not churn the
  // listener set.
  const commands = React.useRef({ runStatement, runSelection, runner, schemaQuery });
  commands.current = { runStatement, runSelection, runner, schemaQuery };

  React.useEffect(
    () =>
      onWorkspaceCommand((command) => {
        if (useWorkspaceStore.getState().activeTabId !== tab.id) return;
        switch (command) {
          case 'run':
            commands.current.runStatement();
            break;
          case 'run-selection':
            commands.current.runSelection();
            break;
          case 'cancel':
            void commands.current.runner.cancel();
            break;
          case 'format':
            editorRef.current?.format();
            break;
          case 'refresh-schema':
            void commands.current.schemaQuery.refetch();
            break;
          default:
            break;
        }
      }),
    [tab.id],
  );

  // The status bar reads the active tab's status; keep it honest after a run.
  React.useEffect(() => {
    if (runner.running) return;
    useWorkspaceStore.getState().setTabStatus(tab.id, {
      rowCount: runner.results.length > 0 ? totalRowCount(runner.results) : undefined,
      durationMs: runner.durationMs ?? undefined,
      message: runner.error?.message,
    });
  }, [runner.durationMs, runner.error, runner.results, runner.running, tab.id]);

  // A closed tab's results are dead weight; the store outlives the component on
  // purpose, so it has to be told when the tab itself is gone.
  React.useEffect(
    () =>
      useWorkspaceStore.subscribe((state) => {
        if (!state.tabs.some((t) => t.id === tab.id)) forgetRunnerState(tab.id);
      }),
    [tab.id],
  );

  // Depends on the store snapshot's fields, not on the runner object, which is
  // rebuilt on every render — a new array here would re-dispatch the underline
  // effect on every keystroke.
  const errorMarks = React.useMemo(
    () => errorMarksFor({ results: runner.results, offsets: runner.offsets, error: runner.error }),
    [runner.error, runner.offsets, runner.results],
  );
  const droppedWithResults =
    (connectionState === 'closed' || connectionState === 'error' || connectionState === 'reconnecting') &&
    (runner.results.length > 0 || sql.trim() !== '');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorToolbar
        tab={tab}
        connection={connection}
        runner={runner}
        editor={editorRef}
        sql={sql}
        txMode={txMode}
        onToggleTx={(next) => useWorkspaceStore.getState().setTabState(tab.id, { txMode: next })}
        database={database}
        schema={schema}
        onContextChange={(patch) => useWorkspaceStore.getState().setTabState(tab.id, patch)}
        onRunStatement={runStatement}
        onRunScript={runScript}
        onRunSelection={runSelection}
        onFormat={() => editorRef.current?.format()}
        onLoadSql={(text, name) => {
          editorRef.current?.setSql(text);
          setSql(text);
          if (name) useWorkspaceStore.getState().renameTab(tab.id, name);
        }}
      />

      {droppedWithResults && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--warn-bg)] px-2 py-1 text-[11px] text-[var(--warn)]">
          <PlugZap className="size-3.5 shrink-0" />
          <span>
            The connection is {connectionState}. Your query and the results below are kept — reconnect and run again.
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => emitWorkspaceCommand('refresh-schema')}
            title="Re-introspect once the link is back"
          >
            Refresh schema
          </Button>
        </div>
      )}

      <ParamsBar
        sql={sql}
        dialect={lexerDialect(engine)}
        values={paramValues}
        onChange={(next) => useWorkspaceStore.getState().setTabState(tab.id, { params: next })}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab.connectionId ? (
          <SqlEditor
            ref={editorRef}
            value={sql}
            onChange={setSql}
            engine={engine}
            model={schemaQuery.data?.model ?? null}
            defaultSchema={schema}
            errorMarks={errorMarks}
            onRunStatement={runStatement}
            onRunScript={runScript}
            onRunSelection={runSelection}
            onSave={() => emitWorkspaceCommand('save')}
          />
        ) : (
          <EmptyState
            title="This tab has no connection"
            description="Pick one in the toolbar above; the editor needs to know which dialect and schema to complete against."
          />
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) void execute(pending.spec);
        }}
        title={pending?.title ?? 'Confirm'}
        message={pending?.message ?? null}
        confirmWord={pending?.confirmWord}
      />
    </div>
  );
}

/** The bottom drawer's results pane, for whichever SQL tab is active. */
function ResultsSlot({ connectionId, tab }: SlotProps) {
  return <ResultTabs connectionId={connectionId} tab={tab} />;
}

// Side-effecting registration: importing this module plugs the SQL editor into
// the shell. The shell deliberately knows nothing about feature modules.
registerTabView('sql', SqlWorkspace);
registerWorkspaceSlot('results', ResultsSlot);
