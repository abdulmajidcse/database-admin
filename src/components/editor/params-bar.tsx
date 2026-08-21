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

import type { ColumnMeta } from '@/lib/results';
import type { Cell } from '@/lib/wire';
import { parameterNames } from '@/server/db/sql/bind';
import type { SqlDialect } from '@/server/db/sql/lexer';
import { Button, cn } from '@/components/ui/primitives';
import { CellParseError, parseCellInput } from '@/components/grid/edit-state';

/**
 * A bind parameter has no declared type — the engine coerces whatever arrives
 * using the target column's input function. `dynamicType` is precisely that
 * rule in `parseCellInput`: infer a number when the text is one, otherwise pass
 * the text through. So the parameter box behaves like a SQLite cell, which is
 * the one place the grid already models an untyped value.
 */
const UNTYPED: ColumnMeta = { name: '', typeName: '', base: 'text', dynamicType: true };

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
  const [bad, setBad] = React.useState<Record<string, string>>({});

  if (names.length === 0) return null;

  const commit = (name: string, raw: string): void => {
    setText((t) => ({ ...t, [name]: raw }));
    try {
      const cell = parseCellInput(raw, UNTYPED, undefined);
      setBad((b) => {
        const { [name]: _drop, ...rest } = b;
        return rest;
      });
      onChange({ ...values, [name]: cell });
    } catch (err) {
      setBad((b) => ({ ...b, [name]: err instanceof CellParseError ? err.message : 'Invalid value' }));
    }
  };

  const setNull = (name: string): void => {
    setText((t) => ({ ...t, [name]: '' }));
    setBad((b) => {
      const { [name]: _drop, ...rest } = b;
      return rest;
    });
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
              value={isNull ? '' : (text[name] ?? '')}
              placeholder={isNull ? 'NULL' : ''}
              onChange={(e) => commit(name, e.target.value)}
              title={bad[name]}
              className={cn(
                'mono h-5 w-28 rounded border bg-[var(--bg)] px-1 text-[11px] outline-none',
                bad[name]
                  ? 'border-[var(--danger)]'
                  : 'border-[var(--border)] focus:border-[var(--accent)]',
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
      {Object.keys(bad).length > 0 && (
        <span className="text-[11px] text-[var(--danger)]">
          {Object.entries(bad)
            .map(([n, m]) => `:${n} — ${m}`)
            .join('; ')}
        </span>
      )}
    </div>
  );
}
