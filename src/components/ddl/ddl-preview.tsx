'use client';

/**
 * The review pane of the table designer (PLAN §6, §9, M3).
 *
 * Every edit to the draft re-POSTs `{ current, desired }` to /api/ddl/plan and
 * shows the statements the SERVER generated. Nothing is rendered from a
 * client-side guess: the script shown here is byte-for-byte the one
 * /api/ddl/execute will run, which is the only way a preview is worth trusting.
 *
 * Two things this pane refuses to hide:
 *
 *  - **SQLite rebuilds.** `ALTER TABLE` barely exists there (§6 trap 3), so
 *    almost any change becomes the 12-step rebuild: pragmas outside the
 *    transaction, a new table, a copy, a drop, a rename, then the indexes and a
 *    `foreign_key_check`. It is presented as what it is — a multi-statement
 *    script that moves your data — rather than dressed up as a simple ALTER.
 *  - **Destructive statements.** The plan route flags them by index; they are
 *    badged in the listing, and running the script asks for the table name to be
 *    typed. The server then applies its own gate (§9) and asks for the
 *    connection's name as well; both are echoed here rather than auto-answered.
 */

import * as React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import { sql as sqlLanguage } from '@codemirror/lang-sql';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, Play, RefreshCw, TriangleAlert, X } from 'lucide-react';

import { ApiRequestError, api } from '@/lib/api-client';
import type { DdlResponse } from '@/lib/api-types';
import type { EngineKind, TableModel } from '@/lib/schema-model';
import { codeMirrorDialect } from '@/components/editor/completion';
import { useTheme } from '@/components/shell/theme';
import { Badge, Button, ConfirmDialog, ErrorBox, Spinner, Toolbar, cn } from '@/components/ui/primitives';

// ---------------------------------------------------------------------------
// /api/ddl/execute response
//
// The route owns this shape (src/app/api/ddl/execute/route.ts) but importing it
// would drag the connector layer — and its Node dependencies — into the browser
// bundle, so it is mirrored structurally here. api-types.ts covers the plan
// half of the contract only.
// ---------------------------------------------------------------------------

export interface DdlStatementOutcome {
  index: number;
  statement: string;
  status: 'ok' | 'error' | 'skipped';
  affectedRows?: number;
  durationMs: number;
  error?: { message: string; code?: string; detail?: string; position?: number };
  destructive: boolean;
  destructiveReason?: string;
  unqualified?: boolean;
  notices?: string[];
}

export interface DdlExecuteResult {
  executed: boolean;
  transactional: boolean;
  rolledBack: boolean;
  succeeded: number;
  durationMs: number;
  statements: DdlStatementOutcome[];
  warnings: string[];
  requiresConfirmation?: { phrase: string; reasons: string[] };
}

// ---------------------------------------------------------------------------
// Read-only SQL view — shared with the object DDL viewer
// ---------------------------------------------------------------------------

const VIEW_THEME = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'var(--bg)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
  '.cm-content': { padding: '4px 0', caretColor: 'transparent' },
  '.cm-cursor': { display: 'none' },
});

const VIEW_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  closeBrackets: false,
  bracketMatching: true,
  searchKeymap: true,
  drawSelection: true,
  tabSize: 2,
} as const;

export interface SqlViewProps {
  sql: string;
  engine: EngineKind | null;
  /** Off for a script whose long lines matter (a rebuild's INSERT … SELECT). */
  wrap?: boolean;
  className?: string;
}

/** A read-only, syntax-highlighted SQL surface. Selectable and searchable. */
export function SqlView({ sql, engine, wrap = true, className }: SqlViewProps) {
  const { resolved } = useTheme();
  const extensions = React.useMemo<Extension[]>(() => {
    const list: Extension[] = [sqlLanguage({ dialect: codeMirrorDialect(engine) }), VIEW_THEME];
    if (wrap) list.push(EditorView.lineWrapping);
    return list;
  }, [engine, wrap]);

  return (
    <CodeMirror
      value={sql}
      height="100%"
      className={cn('h-full', className)}
      theme={resolved === 'dark' ? githubDark : githubLight}
      basicSetup={VIEW_SETUP}
      editable={false}
      readOnly
      extensions={extensions}
    />
  );
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

/** Re-planning on every keystroke would hammer the connection for nothing. */
const PLAN_DEBOUNCE_MS = 350;

/** The plan route names destructive statements by index; this reads them back. */
const DESTRUCTIVE_WARNING = /^Statement (\d+) is destructive:\s*(.*)$/i;

function destructiveByIndex(warnings: string[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const warning of warnings) {
    const m = DESTRUCTIVE_WARNING.exec(warning.trim());
    if (m) out.set(Number.parseInt(m[1], 10) - 1, m[2] || 'data will be lost');
  }
  return out;
}

export function scriptFrom(statements: string[]): string {
  return statements
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => (s.endsWith(';') ? s : `${s};`))
    .join('\n\n');
}

/**
 * SQLite's 12-step rebuild is recognisable structurally: it brackets its own
 * transaction with `PRAGMA foreign_keys`, which is a no-op inside one. That is a
 * far more stable signal than matching on warning text.
 */
function isSqliteRebuild(engine: EngineKind, statements: string[]): boolean {
  return engine === 'sqlite' && statements.some((s) => /^\s*PRAGMA\s+foreign_keys/i.test(s));
}

function errorParts(err: unknown): { message: string; hint?: string; detail?: string } {
  if (err instanceof ApiRequestError) return { message: err.message, hint: err.hint, detail: err.detail };
  if (err instanceof Error) return { message: err.message };
  return { message: 'The request failed.' };
}

// ---------------------------------------------------------------------------
// DdlPreview
// ---------------------------------------------------------------------------

export interface DdlPreviewProps {
  connectionId: string;
  /** The phrase the server will demand back before it runs anything (§9). */
  connectionName: string;
  engine: EngineKind;
  /** Null when the draft describes a table that does not exist yet. */
  current: TableModel | null;
  desired: TableModel;
  /** Reasons the draft cannot be planned; nothing is sent while any remain. */
  problems?: string[];
  /** A read-only connection can be previewed but never executed (§8.5). */
  readOnly?: boolean;
  onExecuted?: (result: DdlExecuteResult) => void;
  className?: string;
}

export function DdlPreview({
  connectionId,
  connectionName,
  engine,
  current,
  desired,
  problems = [],
  readOnly = false,
  onExecuted,
  className,
}: DdlPreviewProps) {
  const queryClient = useQueryClient();
  const [plan, setPlan] = React.useState<DdlResponse | null>(null);
  const [planning, setPlanning] = React.useState(false);
  const [planError, setPlanError] = React.useState<{ message: string; hint?: string; detail?: string } | null>(
    null,
  );
  const [result, setResult] = React.useState<DdlExecuteResult | null>(null);
  const [askTable, setAskTable] = React.useState(false);
  const [serverGate, setServerGate] = React.useState<{ phrase: string; reasons: string[] } | null>(null);
  const [copied, setCopied] = React.useState(false);

  const blocked = problems.length > 0;

  // The plan depends on the CONTENT of the two models, not on their object
  // identity — a parent that rebuilds `desired` on every render must not cause a
  // request storm, and an edit that changes nothing structurally must not
  // re-plan. Hence: signature in the dependency list, values through a ref.
  const signature = React.useMemo(() => JSON.stringify({ current, desired }), [current, desired]);
  const latest = React.useRef({ current, desired });
  latest.current = { current, desired };

  React.useEffect(() => {
    if (blocked) {
      setPlanning(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPlanning(true);
      api
        .post<DdlResponse>(
          '/api/ddl/plan',
          { connectionId, current: latest.current.current, desired: latest.current.desired },
          controller.signal,
        )
        .then((response) => {
          if (controller.signal.aborted) return;
          setPlan(response);
          setPlanError(null);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // Keep the last good script on screen: a half-typed column name
          // should not blank the pane the user is reading.
          setPlanError(errorParts(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setPlanning(false);
        });
    }, PLAN_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [signature, connectionId, blocked]);

  // A new draft invalidates the previous run's outcome.
  React.useEffect(() => {
    setResult(null);
  }, [signature]);

  const statements = plan?.statements ?? [];
  const warnings = plan?.warnings ?? [];
  const destructive = React.useMemo(() => destructiveByIndex(warnings), [warnings]);
  const otherWarnings = React.useMemo(
    () => warnings.filter((w) => !DESTRUCTIVE_WARNING.test(w.trim())),
    [warnings],
  );
  const script = React.useMemo(() => scriptFrom(statements), [statements]);
  const rebuild = isSqliteRebuild(engine, statements);

  const execute = useMutation<DdlExecuteResult, unknown, string | undefined>({
    mutationFn: (confirm) =>
      api.post<DdlExecuteResult>('/api/ddl/execute', {
        connectionId,
        statements,
        ...(confirm ? { confirm } : {}),
      }),
    onSuccess: (response) => {
      if (response.requiresConfirmation) {
        // §9: the server withheld the script. Its phrase is authoritative — the
        // dialog asks for it rather than the client echoing it back silently.
        setServerGate(response.requiresConfirmation);
        return;
      }
      setResult(response);
      const failed = response.statements.find((s) => s.status === 'error');
      if (failed) {
        toast.error(failed.error?.message ?? 'A statement failed.');
      } else {
        toast.success(
          `${response.succeeded} statement${response.succeeded === 1 ? '' : 's'} applied in ${response.durationMs} ms.`,
        );
      }
      // The server invalidated its own cache; the client's copies of the schema
      // and the lazily loaded tree are just as stale, failure or not (§6).
      void queryClient.invalidateQueries({ queryKey: ['schema', connectionId] });
      void queryClient.invalidateQueries({ queryKey: ['tree', connectionId] });
      onExecuted?.(response);
    },
    onError: (err) => toast.error(errorParts(err).message),
  });

  function run(): void {
    if (statements.length === 0) return;
    // Gate one, ours: name the table being changed (§9). Gate two lives on the
    // server and names the connection.
    if (destructive.size > 0) setAskTable(true);
    else execute.mutate(undefined);
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error('The browser refused clipboard access.');
    }
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col border-l border-[var(--border)]', className)}>
      <Toolbar>
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">
          {current ? 'Migration' : 'Create'} script
        </span>
        {planning && <Spinner className="size-3" />}
        {statements.length > 0 && (
          <Badge>
            {statements.length} statement{statements.length === 1 ? '' : 's'}
          </Badge>
        )}
        {destructive.size > 0 && <Badge tone="danger">{destructive.size} destructive</Badge>}
        {rebuild && (
          <Badge tone="warn" className="cursor-help">
            12-step rebuild
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            disabled={script === ''}
            onClick={() => void copy()}
            title="Copy the script"
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            size="xs"
            variant="primary"
            icon={<Play className="size-3.5" />}
            loading={execute.isPending}
            disabled={readOnly || blocked || statements.length === 0}
            onClick={run}
            title={readOnly ? 'This connection is read-only' : 'Run this script'}
          >
            Run
          </Button>
        </span>
      </Toolbar>

      {rebuild && (
        <p className="shrink-0 border-b border-[var(--border)] bg-[var(--warn-bg)] px-2 py-1.5 text-[11px] text-[var(--warn)]">
          SQLite cannot alter this table in place, so this is the documented rebuild: it creates a new table,
          copies every row into it, drops the original and renames. It runs inside its own transaction with the
          foreign-key pragma toggled around it, and it is not wrapped in a second one.
        </p>
      )}

      <div className="min-h-0 shrink-0 max-h-[30%] overflow-auto">
        {blocked && (
          <ul className="m-2 list-disc space-y-0.5 rounded border border-[var(--danger)]/40 bg-[var(--danger-bg)] px-6 py-2 text-[12px] text-[var(--fg)]">
            {problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        )}

        {planError && !blocked && (
          <div className="m-2">
            <ErrorBox title="The server could not plan this change" message={planError.message} hint={planError.hint} />
          </div>
        )}

        {otherWarnings.length > 0 && (
          <ul className="m-2 space-y-1">
            {otherWarnings.map((warning, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11px] text-[var(--warn)]">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        )}

        {destructive.size > 0 && (
          <ul className="m-2 space-y-1">
            {[...destructive.entries()].map(([index, reason]) => (
              <li key={index} className="flex items-start gap-1.5 text-[11px] text-[var(--danger)]">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                <span>
                  Statement {index + 1}: {reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {statements.length > 0 ? (
          <SqlView sql={script} engine={engine} wrap={false} />
        ) : (
          <p className="p-4 text-center text-[12px] text-[var(--fg-subtle)]">
            {blocked
              ? 'Fix the problems above and the script will appear here.'
              : planning
                ? 'Planning…'
                : current
                  ? 'The draft matches the table on the server — there is nothing to run.'
                  : 'Add a column to see the CREATE TABLE this will run.'}
          </p>
        )}
      </div>

      {result && <ExecutionReport result={result} />}

      <ConfirmDialog
        open={askTable}
        onClose={() => setAskTable(false)}
        onConfirm={() => execute.mutate(undefined)}
        title="This script destroys data"
        confirmWord={desired.name}
        message={
          <div className="flex flex-col gap-2">
            <p>
              {destructive.size} of the {statements.length} statements below drop or rewrite data in{' '}
              <strong className="mono">{desired.name}</strong> on <strong>{connectionName}</strong>.
            </p>
            <ul className="list-disc pl-4 text-[var(--fg-muted)]">
              {[...destructive.entries()].map(([index, reason]) => (
                <li key={index}>
                  Statement {index + 1}: {reason}
                </li>
              ))}
            </ul>
          </div>
        }
      />

      <ConfirmDialog
        open={serverGate !== null}
        onClose={() => setServerGate(null)}
        onConfirm={() => {
          const phrase = serverGate?.phrase;
          setServerGate(null);
          if (phrase) execute.mutate(phrase);
        }}
        title="Confirm the connection"
        confirmWord={serverGate?.phrase}
        message={
          <div className="flex flex-col gap-2">
            <p>The server held this script back until the connection is named:</p>
            <ul className="list-disc pl-4 text-[var(--fg-muted)]">
              {(serverGate?.reasons ?? []).map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </div>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// What actually happened
// ---------------------------------------------------------------------------

function ExecutionReport({ result }: { result: DdlExecuteResult }) {
  const failed = result.statements.filter((s) => s.status === 'error');

  return (
    <div className="max-h-[38%] shrink-0 overflow-auto border-t border-[var(--border)] bg-[var(--bg-subtle)]">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-[11px]">
        {result.rolledBack ? (
          <Badge tone="danger">rolled back</Badge>
        ) : failed.length === 0 ? (
          <Badge tone="ok">applied</Badge>
        ) : (
          <Badge tone="warn">partly applied</Badge>
        )}
        <span className="text-[var(--fg-muted)]">
          {result.succeeded}/{result.statements.length} statements · {result.durationMs} ms ·{' '}
          {result.transactional ? 'one transaction' : 'no wrapping transaction'}
        </span>
      </div>

      {result.warnings.map((warning, i) => (
        <p key={i} className="px-2 pb-1 text-[11px] text-[var(--warn)]">
          {warning}
        </p>
      ))}

      <ul className="px-2 pb-2">
        {result.statements.map((outcome) => (
          <li key={outcome.index} className="flex items-start gap-1.5 border-t border-[var(--border)] py-1">
            <span className="mt-0.5 shrink-0">
              {outcome.status === 'ok' ? (
                <Check className="size-3 text-[var(--ok)]" />
              ) : outcome.status === 'error' ? (
                <X className="size-3 text-[var(--danger)]" />
              ) : (
                <RefreshCw className="size-3 text-[var(--fg-subtle)]" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="mono block truncate text-[11px] text-[var(--fg-muted)]">
                {outcome.statement.split('\n')[0]}
              </span>
              {outcome.error && (
                <span className="mono block whitespace-pre-wrap text-[11px] text-[var(--danger)]">
                  {outcome.error.message}
                </span>
              )}
              {outcome.notices?.map((notice, i) => (
                <span key={i} className="block text-[11px] text-[var(--fg-subtle)]">
                  {notice}
                </span>
              ))}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--fg-subtle)]">
              {outcome.status === 'skipped'
                ? 'not run'
                : `${outcome.durationMs} ms${
                    typeof outcome.affectedRows === 'number' ? ` · ${outcome.affectedRows} rows` : ''
                  }`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
