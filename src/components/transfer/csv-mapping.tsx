'use client';

/**
 * Per-column mapping for the import wizard (PLAN §7.4: "per-column mapping to
 * target columns with type coercion and an explicit date format; NULL-literal
 * and trim settings").
 *
 * The four settings that are not decoration:
 *   - **target column** — `null` means "skip this source column", which is the
 *     only way to import a file that has more columns than the table.
 *   - **type** — what the value is coerced to (and what a CREATE TABLE would
 *     use). The sniffer's guess is the default, never the last word.
 *   - **date format** — explicit, because `03/04/2026` is two different days
 *     depending on who wrote the file, and guessing silently is how import
 *     wizards corrupt data.
 *   - **NULL literal / trim** — per column, because one file routinely mixes
 *     `\N`, `NULL` and empty strings across its columns.
 */

import * as React from 'react';
import { ArrowRightLeft, Ban, Wand } from 'lucide-react';
import type { ColumnMapping } from '@/lib/api-types';
import { Button, Checkbox, Input, Select, Separator, cn } from '@/components/ui/primitives';

/**
 * Engine-neutral types the import layer coerces to. Deliberately short: these
 * are canonical names (§4), not a dialect's full type list.
 */
export const TARGET_TYPES = [
  'text',
  'integer',
  'bigint',
  'decimal',
  'float',
  'boolean',
  'date',
  'time',
  'timestamp',
  'json',
  'uuid',
  'binary',
] as const;

export type TargetType = (typeof TARGET_TYPES)[number];

const DATE_TYPES = new Set<string>(['date', 'time', 'timestamp']);

/** Offered in the date-format box; free text is allowed for anything else. */
const DATE_FORMAT_PRESETS = [
  'YYYY-MM-DD',
  'YYYY-MM-DD HH:mm:ss',
  'YYYY-MM-DDTHH:mm:ssZ',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD.MM.YYYY',
  'HH:mm:ss',
  'epoch-seconds',
  'epoch-millis',
];

/** Normalizes a sniffed type name onto the list above; unknowns become text. */
function coerceType(inferred: string | undefined): string {
  if (!inferred) return 'text';
  const lower = inferred.toLowerCase();
  const direct = TARGET_TYPES.find((t) => t === lower);
  if (direct) return direct;
  if (/^(int|int4|int8|smallint|serial)/.test(lower)) return 'integer';
  if (/^(long|bigserial)/.test(lower)) return 'bigint';
  if (/^(numeric|money)/.test(lower)) return 'decimal';
  if (/^(double|real|number)/.test(lower)) return 'float';
  if (/^(bool)/.test(lower)) return 'boolean';
  if (/^(datetime|timestamptz)/.test(lower)) return 'timestamp';
  if (/^(blob|bytea|bytes)/.test(lower)) return 'binary';
  if (/^(jsonb|object|array)/.test(lower)) return 'json';
  return 'text';
}

/** Case/underscore-insensitive match, which is what a header-to-column match is in practice. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

export interface BuildMappingOptions {
  headers: string[];
  inferredTypes?: string[];
  targetColumns?: string[];
  nullLiteral?: string;
  trim?: boolean;
}

/** The wizard's starting point: match by name, keep the sniffed type. */
export function buildMappings({
  headers,
  inferredTypes,
  targetColumns,
  nullLiteral,
  trim = true,
}: BuildMappingOptions): ColumnMapping[] {
  const byName = new Map((targetColumns ?? []).map((c) => [normalizeName(c), c]));
  return headers.map((header, index) => ({
    sourceIndex: index,
    sourceName: header,
    targetColumn: targetColumns && targetColumns.length > 0 ? (byName.get(normalizeName(header)) ?? null) : header,
    targetType: coerceType(inferredTypes?.[index]),
    dateFormat: undefined,
    nullLiteral: nullLiteral && nullLiteral !== '' ? nullLiteral : undefined,
    trim,
  }));
}

export interface CsvMappingProps {
  headers: string[];
  /** Preview rows, used for the sample value column. */
  rows: string[][];
  inferredTypes?: string[];
  value: ColumnMapping[];
  onChange: (next: ColumnMapping[]) => void;
  /** Columns of an existing target table; absent when the table is being created. */
  targetColumns?: string[];
  /** True when `createTable` is on — the type column then defines the DDL. */
  creatingTable?: boolean;
  className?: string;
}

export function CsvMapping({
  headers,
  rows,
  inferredTypes,
  value,
  onChange,
  targetColumns,
  creatingTable,
  className,
}: CsvMappingProps) {
  const hasTargets = (targetColumns?.length ?? 0) > 0;

  const patch = React.useCallback(
    (index: number, change: Partial<ColumnMapping>) => {
      onChange(value.map((m, i) => (i === index ? { ...m, ...change } : m)));
    },
    [onChange, value],
  );

  const mapByName = React.useCallback(() => {
    onChange(buildMappings({ headers, inferredTypes, targetColumns }));
  }, [headers, inferredTypes, onChange, targetColumns]);

  const skipAll = React.useCallback(() => {
    onChange(value.map((m) => ({ ...m, targetColumn: null })));
  }, [onChange, value]);

  const mapped = value.filter((m) => m.targetColumn !== null).length;
  const unmatchedTargets = hasTargets
    ? (targetColumns ?? []).filter((c) => !value.some((m) => m.targetColumn === c))
    : [];

  /** First non-empty sample for a column — an empty cell teaches nothing. */
  const sampleFor = (index: number): string => {
    for (const row of rows) {
      const cell = row[index];
      if (cell !== undefined && cell !== '') return cell;
    }
    return '';
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-[var(--fg-muted)]">
          {mapped} of {value.length} source columns mapped
          {hasTargets && unmatchedTargets.length > 0 && (
            <>
              {' · '}
              <span className="text-[var(--warn)]">
                {unmatchedTargets.length} target column{unmatchedTargets.length > 1 ? 's' : ''} will keep their default
                value
              </span>
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="ghost" icon={<Wand className="size-3" />} onClick={mapByName}>
            Match by name
          </Button>
          <Separator vertical />
          <Button size="xs" variant="ghost" icon={<Ban className="size-3" />} onClick={skipAll}>
            Skip all
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto border border-[var(--border)]">
        <table className="w-full text-xs">
          <thead className="bg-[var(--grid-header)] text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Source column</th>
              <th className="px-2 py-1 text-left font-medium">Sample</th>
              <th className="px-2 py-1 text-left font-medium">
                <span className="flex items-center gap-1">
                  <ArrowRightLeft className="size-3" /> Target column
                </span>
              </th>
              <th className="px-2 py-1 text-left font-medium">Type</th>
              <th className="px-2 py-1 text-left font-medium">Date format</th>
              <th className="px-2 py-1 text-left font-medium">NULL literal</th>
              <th className="px-2 py-1 text-left font-medium">Trim</th>
            </tr>
          </thead>
          <tbody>
            {value.map((m, i) => {
              const skipped = m.targetColumn === null;
              const isDate = DATE_TYPES.has(m.targetType ?? '');
              return (
                <tr
                  key={`${m.sourceIndex}-${m.sourceName}`}
                  className={cn(
                    'border-b border-[var(--border)] last:border-0 even:bg-[var(--row-alt)]',
                    skipped && 'opacity-55',
                  )}
                >
                  <td className="mono max-w-[12rem] truncate px-2 py-1" title={m.sourceName}>
                    {m.sourceName || <span className="text-[var(--fg-subtle)]">column {m.sourceIndex + 1}</span>}
                  </td>
                  <td
                    className="mono max-w-[12rem] truncate px-2 py-1 text-[var(--fg-subtle)]"
                    title={sampleFor(m.sourceIndex)}
                  >
                    {sampleFor(m.sourceIndex) || <span className="null-cell">empty</span>}
                  </td>
                  <td className="px-2 py-1">
                    {hasTargets ? (
                      <Select
                        className="min-w-40"
                        value={m.targetColumn ?? ''}
                        onChange={(e) => patch(i, { targetColumn: e.target.value === '' ? null : e.target.value })}
                      >
                        <option value="">— skip —</option>
                        {(targetColumns ?? []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                        {/* A mapping restored from a saved wizard may name a
                            column the current schema no longer has; keep it
                            selectable rather than silently switching to skip. */}
                        {m.targetColumn !== null && !(targetColumns ?? []).includes(m.targetColumn) && (
                          <option value={m.targetColumn}>{m.targetColumn} (not in table)</option>
                        )}
                      </Select>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Input
                          className="mono min-w-32"
                          value={m.targetColumn ?? ''}
                          placeholder="skipped"
                          onChange={(e) => patch(i, { targetColumn: e.target.value === '' ? null : e.target.value })}
                        />
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <Select
                      className="min-w-28"
                      value={m.targetType ?? 'text'}
                      disabled={skipped}
                      onChange={(e) => patch(i, { targetType: e.target.value })}
                    >
                      {TARGET_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      className="mono min-w-40"
                      list="dbadmin-date-formats"
                      value={m.dateFormat ?? ''}
                      disabled={skipped || !isDate}
                      placeholder={isDate ? 'ISO 8601 (auto)' : '—'}
                      onChange={(e) => patch(i, { dateFormat: e.target.value === '' ? undefined : e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      className="mono min-w-24"
                      value={m.nullLiteral ?? ''}
                      disabled={skipped}
                      placeholder="empty = NULL"
                      onChange={(e) => patch(i, { nullLiteral: e.target.value === '' ? undefined : e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Checkbox
                      checked={m.trim ?? false}
                      disabled={skipped}
                      onChange={(e) => patch(i, { trim: e.target.checked })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <datalist id="dbadmin-date-formats">
        {DATE_FORMAT_PRESETS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>

      <p className="text-[11px] leading-snug text-[var(--fg-subtle)]">
        {creatingTable
          ? 'The table does not exist yet, so the types above are the ones its columns will be created with.'
          : 'Types coerce the incoming text before it is written; a value that will not convert is reported as a bad row.'}{' '}
        Set an explicit date format for anything that is not ISO 8601 — a dd/mm vs mm/dd guess is silent and wrong half
        the time.
      </p>
    </div>
  );
}
