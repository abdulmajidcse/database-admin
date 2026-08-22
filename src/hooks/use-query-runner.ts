'use client';

/**
 * The query runner (PLAN §6, M2).
 *
 * Everything the SQL editor needs to execute something and live with the
 * consequences:
 *
 *  - **A run id per request** (`randomId`, secure-context safe), sent with the POST so
 *    /api/query/cancel can find the link. Closing the socket does not stop a
 *    server-side query, so cancel is a real request (§6 "Query cancellation").
 *  - **Statement boundaries come from the server's lexer.** `splitStatements` /
 *    `statementAtOffset` live in `server/db/sql/lexer.ts`, a pure module with no
 *    Node imports written to be shared with the editor (see its header). The
 *    browser therefore runs the *same* code the route runs, which is what makes
 *    the highlighted range and the executed range provably identical. Nothing is
 *    re-implemented here.
 *  - **State outlives the component.** Results and the run status live in a
 *    module-level store keyed by tab id, so switching tabs, a re-render, or a
 *    dropped tunnel never throws away a result set — and the editor text lives
 *    in the persisted workspace tab state. Losing an unsaved query to a dropped
 *    connection is what makes people stop using a tool (§8.3).
 *  - **Failure never clears the previous result.** A failed run sets `error` and
 *    leaves `results` alone.
 */

import { randomId } from '@/lib/ids';
import * as React from 'react';

import { api, ApiRequestError } from '@/lib/api-client';
import type { QueryRequest, QueryResponse, ServerMessage } from '@/lib/api-types';
import type { EngineKind } from '@/lib/schema-model';
import type { ExplainPlan, StatementResult } from '@/lib/results';
import type { Cell } from '@/lib/wire';
import { wsClient } from '@/lib/ws-client';
import {
  classifyStatement,
  isDestructive,
  splitStatements,
  statementAtOffset,
  type DestructiveVerdict,
  type SqlDialect,
  type SqlStatement,
  type StatementKind,
} from '@/server/db/sql/lexer';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type RunMode = 'statement' | 'script' | 'selection';

export interface RunError {
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
  /** Document offset the engine blamed, when it reported one. */
  offset?: number;
}

export interface RunnerState {
  running: boolean;
  runId: string | null;
  results: StatementResult[];
  /**
   * Document offset of each result's statement, parallel to `results`. Engine
   * error positions are statement-relative; this is what maps them back onto
   * the editor buffer.
   */
  offsets: number[];
  error: RunError | null;
  mode: RunMode | null;
  /** True when the run went through the atomic (pinned session) path. */
  atomic: boolean;
  startedAt: number | null;
  durationMs: number | null;
  /** Live row counter from the `query-progress` channel. */
  progress: { rows: number; phase: string } | null;
  /** The range the last run executed, so the editor can keep it highlighted. */
  ranRange: { from: number; to: number } | null;
  /**
   * Which result tab is on screen. It lives here rather than inside the results
   * pane because the toolbar's "Export result" has to know which statement the
   * user is actually looking at, and the two components are in different panes.
   */
  activeResult: number;
}

export const EMPTY_RUNNER_STATE: RunnerState = {
  running: false,
  runId: null,
  results: [],
  offsets: [],
  error: null,
  mode: null,
  atomic: false,
  startedAt: null,
  durationMs: null,
  progress: null,
  ranRange: null,
  activeResult: 0,
};

const states = new Map<string, RunnerState>();
const listeners = new Map<string, Set<() => void>>();

function readState(tabId: string): RunnerState {
  return states.get(tabId) ?? EMPTY_RUNNER_STATE;
}

function writeState(tabId: string, patch: Partial<RunnerState>): void {
  states.set(tabId, { ...readState(tabId), ...patch });
  for (const l of listeners.get(tabId) ?? []) l();
}

function subscribe(tabId: string, listener: () => void): () => void {
  const set = listeners.get(tabId) ?? new Set<() => void>();
  listeners.set(tabId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(tabId);
  };
}

/** Read-only view of a tab's run state — used by the results pane in the drawer. */
export function useRunnerState(tabId: string | null): RunnerState {
  const subscribeTo = React.useCallback(
    (listener: () => void) => (tabId ? subscribe(tabId, listener) : () => undefined),
    [tabId],
  );
  const snapshot = React.useCallback(() => (tabId ? readState(tabId) : EMPTY_RUNNER_STATE), [tabId]);
  const server = React.useCallback(() => EMPTY_RUNNER_STATE, []);
  return React.useSyncExternalStore(subscribeTo, snapshot, server);
}

/** Drop a closed tab's results so a long session does not hoard result sets. */
export function forgetRunnerState(tabId: string): void {
  states.delete(tabId);
  listeners.delete(tabId);
}

/** Which result tab the user is looking at — see `RunnerState.activeResult`. */
export function setActiveResult(tabId: string, index: number): void {
  if (readState(tabId).activeResult === index) return;
  writeState(tabId, { activeResult: index });
}

// ---------------------------------------------------------------------------
// "Reveal this offset" bus — the results pane points, the editor jumps
// ---------------------------------------------------------------------------

type RevealListener = (offset: number) => void;
const revealListeners = new Map<string, Set<RevealListener>>();

export function revealOffset(tabId: string, offset: number): void {
  for (const l of revealListeners.get(tabId) ?? []) l(offset);
}

export function onRevealOffset(tabId: string, listener: RevealListener): () => void {
  const set = revealListeners.get(tabId) ?? new Set<RevealListener>();
  revealListeners.set(tabId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) revealListeners.delete(tabId);
  };
}

// ---------------------------------------------------------------------------
// Error marks
// ---------------------------------------------------------------------------

export interface ErrorMark {
  /** Absolute document offset. */
  offset: number;
  message: string;
  statementIndex: number;
}

/**
 * Engine error positions are 1-based and relative to the statement that failed,
 * so they only mean something once the statement's own offset is added back.
 */
export function errorMarksFor(state: Pick<RunnerState, 'results' | 'offsets' | 'error'>): ErrorMark[] {
  const marks: ErrorMark[] = [];
  state.results.forEach((r, i) => {
    const position = r.error?.position;
    if (position === undefined || position === null) return;
    const base = state.offsets[i] ?? 0;
    marks.push({ offset: base + Math.max(0, position - 1), message: r.error?.message ?? 'Error', statementIndex: i });
  });
  if (marks.length === 0 && state.error?.offset !== undefined) {
    marks.push({ offset: state.error.offset, message: state.error.message, statementIndex: -1 });
  }
  return marks;
}

// ---------------------------------------------------------------------------
// The atomic (pinned session) response — /api/ddl/execute
// ---------------------------------------------------------------------------

interface AtomicOutcome {
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

interface AtomicResponse {
  executed: boolean;
  transactional: boolean;
  rolledBack: boolean;
  succeeded: number;
  durationMs: number;
  statements: AtomicOutcome[];
  warnings: string[];
  requiresConfirmation?: { phrase: string; reasons: string[] };
}

/**
 * The atomic path reports outcomes, not grids: /api/ddl/execute reads a
 * statement's rows only to check them, so a SELECT run inside a pinned
 * transaction comes back with its affected/row count and a notice explaining
 * where the grid went, rather than a silently empty table.
 */
function atomicToResults(response: AtomicResponse, dialect: SqlDialect): StatementResult[] {
  return response.statements.map((o) => {
    if (o.status === 'error' && o.error) {
      return { index: o.index, statement: o.statement, error: o.error, durationMs: o.durationMs };
    }
    const notices = [...(o.notices ?? [])];
    if (o.status === 'skipped') {
      notices.push(response.rolledBack ? 'Not run: the transaction was rolled back.' : 'Not run.');
    }
    if (returnsRows(o.statement, dialect)) {
      notices.push('Transaction mode reports statement outcomes; run without transaction mode to browse the rows.');
    }
    return {
      index: o.index,
      statement: o.statement,
      durationMs: o.durationMs,
      result: {
        statement: o.statement,
        columns: [],
        rows: [],
        truncated: false,
        affectedRows: o.affectedRows,
        durationMs: o.durationMs,
        notices: notices.length > 0 ? notices : undefined,
        editTarget: null,
        readOnlyReason: 'Statements run in transaction mode are not editable from the grid.',
      },
    };
  });
}

const ROW_KINDS = new Set<StatementKind>(['select', 'explain']);

function returnsRows(statement: string, dialect: SqlDialect): boolean {
  return ROW_KINDS.has(classifyStatement(statement, dialect));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunSpec {
  sql: string;
  mode: RunMode;
  /** Where `sql` starts in the editor buffer; 0 for a whole-script run. */
  baseOffset?: number;
  database?: string;
  schema?: string;
  /** Run the whole script in one transaction on one pinned session (§6). */
  atomic?: boolean;
  /** Echo of `requiresConfirmation.phrase` for the atomic path (§9). */
  confirm?: string;
  /** Values for `:name` bind placeholders (docs/roadmap.md M10). */
  params?: Record<string, Cell>;
}

export type RunOutcome =
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  /** §9: the server withheld the script until the user types the phrase. */
  | { kind: 'needs-confirmation'; phrase: string; reasons: string[] };

export interface QueryRunner extends RunnerState {
  dialect: SqlDialect;
  run: (spec: RunSpec) => Promise<RunOutcome>;
  cancel: () => Promise<void>;
  clear: () => void;
  explain: (sql: string, analyze: boolean) => Promise<ExplainPlan>;
  /** The statement the caret sits in, per the server's lexer. */
  statementAt: (sql: string, offset: number) => SqlStatement | null;
  /** Every statement in the buffer, for the destructive guard and offsets. */
  statements: (sql: string) => SqlStatement[];
  destructive: (sql: string) => DestructiveVerdict;
  /** True when running the script would write — drives the prod guard (§9). */
  writes: (sql: string) => boolean;
}

const WRITE_KINDS = new Set<StatementKind>(['insert', 'update', 'delete', 'ddl']);

function messageOf(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function useQueryRunner(
  tabId: string,
  connectionId: string | null,
  engine: EngineKind | null,
): QueryRunner {
  const state = useRunnerState(tabId);
  const dialect: SqlDialect =
    engine === 'mysql' || engine === 'mariadb'
      ? 'mysql'
      : engine === 'sqlite'
        ? 'sqlite'
        : 'postgres';

  // A run in flight when the component unmounts must still finish into the
  // store, so the id is kept in a ref rather than in React state.
  const runIdRef = React.useRef<string | null>(null);

  const statements = React.useCallback((sql: string) => splitStatements(sql, dialect), [dialect]);
  const statementAt = React.useCallback(
    (sql: string, offset: number) => statementAtOffset(sql, offset, dialect),
    [dialect],
  );
  const destructive = React.useCallback((sql: string) => isDestructive(sql, dialect), [dialect]);
  const writes = React.useCallback(
    (sql: string) => splitStatements(sql, dialect).some((s) => WRITE_KINDS.has(classifyStatement(s.text, dialect))),
    [dialect],
  );

  const cancel = React.useCallback(async () => {
    const runId = runIdRef.current;
    if (!connectionId || !runId) return;
    // An unknown run id is not an error server-side: the statement probably just
    // finished, and a won race must not turn into a red box.
    await api.post('/api/query/cancel', { connectionId, runId }).catch(() => undefined);
  }, [connectionId]);

  const clear = React.useCallback(() => {
    writeState(tabId, { ...EMPTY_RUNNER_STATE });
  }, [tabId]);

  const explain = React.useCallback(
    async (sql: string, analyze: boolean): Promise<ExplainPlan> => {
      if (!connectionId) throw new Error('Pick a connection first.');
      return await api.post<ExplainPlan>('/api/explain', { connectionId, sql, analyze });
    },
    [connectionId],
  );

  const run = React.useCallback(
    async (spec: RunSpec): Promise<RunOutcome> => {
      if (!connectionId) {
        const message = 'Pick a connection before running anything.';
        writeState(tabId, { error: { message } });
        return { kind: 'error', message };
      }
      if (spec.sql.trim() === '') {
        const message = 'There is nothing to run.';
        writeState(tabId, { error: { message } });
        return { kind: 'error', message };
      }

      const base = spec.baseOffset ?? 0;
      const parsed = splitStatements(spec.sql, dialect);
      const runId = randomId();
      runIdRef.current = runId;
      const startedAt = Date.now();

      writeState(tabId, {
        running: true,
        runId,
        error: null,
        mode: spec.mode,
        atomic: spec.atomic === true,
        startedAt,
        durationMs: null,
        progress: null,
        ranRange: { from: base, to: base + spec.sql.length },
      });

      // Live row counts while a big scan is running (§6). The subscription is
      // scoped to this run id and torn down with it.
      const offProgress = wsClient.onMessage((msg: ServerMessage) => {
        if (msg.type === 'query-progress' && msg.runId === runId) {
          writeState(tabId, { progress: { rows: msg.rows, phase: msg.phase } });
        }
      });
      const unsubscribe = wsClient.subscribe({ channel: 'query-progress', connectionId, arg: runId });

      try {
        if (spec.atomic) {
          const response = await api.post<AtomicResponse>('/api/ddl/execute', {
            connectionId,
            sql: spec.sql,
            confirm: spec.confirm,
          });
          if (!response.executed && response.requiresConfirmation) {
            writeState(tabId, { running: false, durationMs: Date.now() - startedAt });
            return {
              kind: 'needs-confirmation',
              phrase: response.requiresConfirmation.phrase,
              reasons: response.requiresConfirmation.reasons,
            };
          }
          const results = atomicToResults(response, dialect);
          writeState(tabId, {
            running: false,
            results,
            activeResult: 0,
            offsets: parsed.map((s) => base + s.start),
            durationMs: Date.now() - startedAt,
            error:
              response.rolledBack && results.some((r) => r.error)
                ? { message: 'The transaction was rolled back; nothing was committed.' }
                : null,
          });
          return { kind: 'done' };
        }

        const request: QueryRequest & { params?: Record<string, Cell> } = {
          connectionId,
          sql: spec.sql,
          // 'single' is the strict "statement under the cursor" path: the server
          // re-splits the text it was given and refuses it if the slice turned
          // out to be more than one statement, so the editor's idea of the
          // boundary is verified rather than trusted.
          mode: spec.mode === 'statement' ? 'single' : 'script',
          runId,
          database: spec.database,
          schema: spec.schema,
          // Not on QueryRequest: the contract is frozen, so the route reads bind
          // values off the raw body the same way it reads continueOnError.
          params: spec.params,
        };
        const response = await api.post<QueryResponse>('/api/query', request);
        writeState(tabId, {
          running: false,
          results: response.results,
          activeResult: 0,
          offsets: parsed.map((s) => base + s.start),
          durationMs: Date.now() - startedAt,
          progress: null,
        });
        return { kind: 'done' };
      } catch (err) {
        const position = err instanceof ApiRequestError ? err.position : undefined;
        const error: RunError = {
          message: messageOf(err),
          code: err instanceof ApiRequestError ? err.code : undefined,
          detail: err instanceof ApiRequestError ? err.detail : undefined,
          hint: err instanceof ApiRequestError ? err.hint : undefined,
          offset: position === undefined ? undefined : base + Math.max(0, position - 1),
        };
        // §8.3: the previous results stay on screen. A dropped tunnel must not
        // also cost you the answer you were reading.
        writeState(tabId, { running: false, error, durationMs: Date.now() - startedAt, progress: null });
        return { kind: 'error', message: error.message };
      } finally {
        offProgress();
        unsubscribe();
        if (runIdRef.current === runId) runIdRef.current = null;
      }
    },
    [connectionId, dialect, tabId],
  );

  return {
    ...state,
    dialect,
    run,
    cancel,
    clear,
    explain,
    statementAt,
    statements,
    destructive,
    writes,
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by the toolbar, tabs and status bar
// ---------------------------------------------------------------------------

export function totalRowCount(results: StatementResult[]): number {
  let n = 0;
  for (const r of results) {
    if (r.result) n += r.result.affectedRows ?? r.result.rows.length;
  }
  return n;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

/** One-line label for a result tab: the verb plus the first table-ish word. */
export function statementLabel(statement: string): string {
  const collapsed = statement.replace(/\s+/g, ' ').trim();
  return collapsed.length > 48 ? `${collapsed.slice(0, 47)}…` : collapsed;
}
