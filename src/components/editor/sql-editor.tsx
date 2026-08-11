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
import { lexerDialect, sqlLanguageExtension } from './completion';
import { EditorToolbar } from './editor-toolbar';
import { ResultTabs } from './result-tabs';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const FORMAT_KEYWORDS = new Set([
  'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'BEGIN', 'BETWEEN', 'BY', 'CASCADE', 'CASE',
  'CAST', 'CHECK', 'COLUMN', 'COMMIT', 'CONFLICT', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT',
  'DATABASE', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DO', 'DROP', 'ELSE', 'END', 'EXCEPT',
  'EXISTS', 'FALSE', 'FETCH', 'FILTER', 'FIRST', 'FOR', 'FOREIGN', 'FROM', 'FULL', 'GRANT',
  'GROUP', 'HAVING', 'IF', 'ILIKE', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS',
  'JOIN', 'KEY', 'LAST', 'LATERAL', 'LEFT', 'LIKE', 'LIMIT', 'MATERIALIZED', 'NATURAL', 'NOT',
  'NULL', 'NULLS', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION', 'PRIMARY',
  'PROCEDURE', 'REFERENCES', 'RENAME', 'REPLACE', 'RETURNING', 'RIGHT', 'ROLLBACK', 'ROW', 'ROWS',
  'SELECT', 'SET', 'TABLE', 'TEMPORARY', 'THEN', 'TO', 'TRUE', 'TRUNCATE', 'UNION', 'UNIQUE',
  'UPDATE', 'USING', 'VALUES', 'VIEW', 'WHEN', 'WHERE', 'WINDOW', 'WITH',
]);

/** Keywords that start a clause and therefore start a line. */
const CLAUSE_BREAK = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT',
  'EXCEPT', 'VALUES', 'SET', 'RETURNING', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'WINDOW', 'FETCH',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'NATURAL', 'ON',
]);

/** Clause keywords that read better indented under the one above them. */
const CLAUSE_INDENT = new Set(['ON']);

const JOIN_PREFIX = new Set(['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'NATURAL', 'OUTER']);

interface FmtToken {
  kind: 'word' | 'string' | 'comment' | 'punct' | 'number';
  text: string;
  upper: string;
}

/**
 * A scanner, not a parser: it exists only to know which characters are inside a
 * string, an identifier quote or a comment, so formatting can never rewrite
 * them. Dialect flags mirror the server lexer's rules.
 */
function tokenizeForFormat(sql: string, dialect: SqlDialect): FmtToken[] {
  const backslash = dialect === 'mysql';
  const backticks = dialect !== 'postgres';
  const brackets = dialect === 'sqlite';
  const dollars = dialect === 'postgres';
  const hashComments = dialect === 'mysql';

  const out: FmtToken[] = [];
  const push = (kind: FmtToken['kind'], text: string): void => {
    out.push({ kind, text, upper: kind === 'word' ? text.toUpperCase() : '' });
  };

  const at = (i: number): string => (i >= 0 && i < sql.length ? sql.charAt(i) : '');
  let i = 0;

  const scanQuoted = (start: number, quote: string, escapes: boolean): number => {
    let j = start + 1;
    while (j < sql.length) {
      const c = sql.charAt(j);
      if (escapes && c === '\\') {
        j += 2;
        continue;
      }
      if (c === quote) {
        if (at(j + 1) === quote) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return sql.length;
  };

  while (i < sql.length) {
    const c = sql.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === '-' && at(i + 1) === '-') {
      const end = sql.indexOf('\n', i);
      push('comment', sql.slice(i, end === -1 ? sql.length : end));
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (hashComments && c === '#') {
      const end = sql.indexOf('\n', i);
      push('comment', sql.slice(i, end === -1 ? sql.length : end));
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (c === '/' && at(i + 1) === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      push('comment', sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (dollars && c === '$') {
      const match = /^\$[A-Za-z_][\w]*\$|^\$\$/.exec(sql.slice(i));
      if (match) {
        const tagText = match[0];
        const end = sql.indexOf(tagText, i + tagText.length);
        const stop = end === -1 ? sql.length : end + tagText.length;
        push('string', sql.slice(i, stop));
        i = stop;
        continue;
      }
    }
    if (c === "'" || c === '"' || (backticks && c === '`')) {
      const end = scanQuoted(i, c, backslash && c !== '`');
      push('string', sql.slice(i, end));
      i = end;
      continue;
    }
    if (brackets && c === '[') {
      const end = sql.indexOf(']', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      push('string', sql.slice(i, stop));
      i = stop;
      continue;
    }
    // Any code point above ASCII is a legal unquoted identifier character in
    // every engine, so the ranges are spelled out rather than left to \w.
    if (/[A-Za-z_-￿]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$-￿]/.test(sql.charAt(j))) j++;
      push('word', sql.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql.charAt(j))) j++;
      push('number', sql.slice(i, j));
      i = j;
      continue;
    }
    push('punct', c);
    i++;
  }
  return out;
}

/**
 * Pretty-print the buffer. Deliberately conservative — it never touches the
 * inside of a string, an identifier quote or a comment, and a MySQL script that
 * redefines the delimiter is left exactly as written rather than risk mangling
 * a stored procedure body.
 */
export function formatSql(sql: string, dialect: SqlDialect): string {
  if (sql.trim() === '') return sql;
  if (dialect === 'mysql' && /^[ \t]*delimiter[ \t]+\S/im.test(sql)) return sql;

  const tokens = tokenizeForFormat(sql, dialect);
  const parts: string[] = [];
  let depth = 0;
  let atLineStart = true;
  let prev: FmtToken | null = null;

  const indent = (level: number): string => '  '.repeat(Math.max(0, level));
  const br = (level: number): void => {
    parts.push(`\n${indent(level)}`);
    atLineStart = true;
  };

  const suppressBreak = (token: FmtToken): boolean => {
    if (!prev) return true;
    if (prev.kind === 'punct' && prev.text === '(') return true;
    if (prev.kind !== 'word') return false;
    if (prev.upper === 'DELETE' && token.upper === 'FROM') return true;
    if (prev.upper === 'INSERT' && token.upper === 'INTO') return true;
    if (JOIN_PREFIX.has(prev.upper) && (token.upper === 'JOIN' || JOIN_PREFIX.has(token.upper))) return true;
    if (prev.upper === 'DISTINCT' && token.upper === 'ON') return true;
    if (prev.upper === 'UNION' && (token.upper === 'ALL' || token.upper === 'DISTINCT')) return true;
    return false;
  };

  const needsSpace = (token: FmtToken): boolean => {
    if (atLineStart || !prev) return false;
    if (token.kind === 'punct' && (token.text === ',' || token.text === ')' || token.text === ';' || token.text === '.')) {
      return false;
    }
    if (prev.kind === 'punct' && (prev.text === '(' || prev.text === '.')) return false;
    // `count(` stays tight; `IN (` keeps its space.
    if (token.kind === 'punct' && token.text === '(' && prev.kind === 'word' && !FORMAT_KEYWORDS.has(prev.upper)) {
      return false;
    }
    return true;
  };

  for (const token of tokens) {
    if (token.kind === 'punct' && token.text === ')') depth = Math.max(0, depth - 1);

    if (token.kind === 'word' && CLAUSE_BREAK.has(token.upper) && !suppressBreak(token)) {
      br(depth + (CLAUSE_INDENT.has(token.upper) ? 1 : 0));
    }

    if (needsSpace(token)) parts.push(' ');
    parts.push(
      token.kind === 'word' && FORMAT_KEYWORDS.has(token.upper) && prev?.text !== '.' ? token.upper : token.text,
    );
    atLineStart = false;

    if (token.kind === 'punct' && token.text === '(') depth++;
    if (token.kind === 'punct' && token.text === ',' && depth === 0) br(1);
    if (token.kind === 'comment' && !token.text.startsWith('/*')) br(depth);
    if (token.kind === 'punct' && token.text === ';' && depth === 0) {
      parts.push('\n\n');
      atLineStart = true;
      prev = null;
      continue;
    }
    prev = token;
  }

  return parts
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
    const current = view.state.doc.toString();
    const next = formatSql(current, lexerDialect(handlers.current.engine));
    if (next === current) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
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
    (spec: RunSpec): void => {
      if (!tab.connectionId) {
        toast.error('Pick a connection for this tab first.');
        return;
      }
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
