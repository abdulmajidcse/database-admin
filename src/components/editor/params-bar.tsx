'use client';

/**
 * Bind parameters (docs/roadmap.md M10).
 *
 * Appears only when the buffer contains `:name` placeholders, which is also
 * what the generated templates from `sql/dml.ts` emit — generate an INSERT from
 * the object tree and it arrives here ready to fill in.
 *
 * Values are parsed with the same `parseCellInput` the grid's cell editor uses,
 * so the typing rules are the ones the user already knows: an empty box is an
 * empty string, the NULL button is a real NULL, and a number that will not fit
 * a double is kept as its lossless text rather than rounded.
 *
 * Nothing here builds SQL. The values travel to /api/query as a map and are
 * bound by offset on the server (`sql/bind.ts`), so a value containing SQL is
 * only ever a value.
 */

import * as React from 'react';
import { CircleSlash2, Variable } from 'lucide-react';

import type { Cell } from '@/lib/wire';
import { parameterNames } from '@/server/db/sql/bind';
import type { SqlDialect } from '@/server/db/sql/lexer';
import { Button, cn } from '@/components/ui/primitives';

const INTEGER_TEXT = /^[-+]?\d+$/;
const NUMBER_TEXT = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * A bind parameter has no declared type — the engine coerces whatever arrives
 * using the target column's input function.
 *
 * This deliberately does NOT reuse the grid's `dynamicType` branch, which was
 * the first thing tried. That branch rounds anything numeric through a JS
 * double, so `9007199254740993` becomes `…92` and a `DELETE … WHERE id = :id`
 * silently addresses the wrong row. An integer too large for a double is kept
 * as its lossless text instead, which is what the grid does for a *declared*
 * integer column and what §6 requires everywhere.
 */
export function parseParamInput(text: string): Cell {
  const t = text.trim();
  if (t === '') return text;
  if (INTEGER_TEXT.test(t)) {
    return Number.isSafeInteger(Number(t)) ? Number(t) : { $t: 'bigint', v: t };
  }
  if (NUMBER_TEXT.test(t)) {
    // A decimal that does not survive the round trip keeps its text, for the
    // same reason: the engine's own input function is more precise than ours.
    return String(Number(t)) === t ? Number(t) : { $t: 'decimal', v: t };
  }
  return text;
}

/**
 * The stored value as editable text. Values are persisted on the tab, so after
 * a reload (or a tab switch) they exist while this component's local text state
 * does not — without this the box renders empty while a value is still bound,
 * and pressing run binds something the user cannot see.
 */
function displayOf(cell: Cell | undefined): string {
  if (cell === undefined || cell === null) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  return typeof cell.v === 'string' ? cell.v : '';
}

export interface ParamsBarProps {
  sql: string;
  dialect: SqlDialect;
  values: Record<string, Cell>;
  onChange: (values: Record<string, Cell>) => void;
}

export function ParamsBar({ sql, dialect, values, onChange }: ParamsBarProps) {
  // Re-scanned on every keystroke, which is cheap next to the highlighting the
  // editor is already doing, and means a placeholder typed by hand shows up at
  // once rather than on the next run.
  const names = React.useMemo(() => {
    try {
      return parameterNames(sql, dialect);
    } catch {
      // A half-typed statement can be unlexable; that is not an error worth
      // showing while someone is still typing.
      return [];
    }
  }, [sql, dialect]);

  const [text, setText] = React.useState<Record<string, string>>({});

  if (names.length === 0) return null;

  // parseParamInput has no failing branch — every input is bindable, because a
  // parameter has no declared type to violate. There is deliberately no error
  // state here; the try/catch and red border that used to sit in this file were
  // unreachable and only suggested a validation that does not exist.
  const commit = (name: string, raw: string): void => {
    setText((t) => ({ ...t, [name]: raw }));
    onChange({ ...values, [name]: parseParamInput(raw) });
  };

  const setNull = (name: string): void => {
    setText((t) => ({ ...t, [name]: '' }));
    onChange({ ...values, [name]: null });
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1">
      <span
        className="flex items-center gap-1 text-[11px] text-[var(--fg-muted)]"
        title="Values are bound as parameters, never pasted into the SQL"
      >
        <Variable className="size-3.5" />
        Parameters
      </span>
      {names.map((name) => {
        const isNull = values[name] === null;
        return (
          <label key={name} className="flex items-center gap-1">
            <span className="mono text-[11px] text-[var(--fg-muted)]">:{name}</span>
            <input
              value={isNull ? '' : (text[name] ?? displayOf(values[name]))}
              placeholder={isNull ? 'NULL' : ''}
              onChange={(e) => commit(name, e.target.value)}
              className={cn(
                'mono h-5 w-28 rounded border border-[var(--border)] bg-[var(--bg)] px-1',
                'text-[11px] outline-none focus:border-[var(--accent)]',
                isNull && 'italic text-[var(--fg-subtle)]',
              )}
            />
            <Button
              size="xs"
              variant="ghost"
              icon={<CircleSlash2 className="size-3" />}
              onClick={() => setNull(name)}
              title={`Bind :${name} as NULL`}
            />
          </label>
        );
      })}
    </div>
  );
}
