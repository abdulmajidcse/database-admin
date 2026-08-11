'use client';

/**
 * The column list of the table designer (PLAN M3 "table/index/FK editors").
 *
 * Everything here edits a draft `ColumnModel[]` in place; nothing is sent
 * anywhere. Three decisions are worth spelling out:
 *
 *  1. **`type.raw` is always written.** The server's `renderTypeSql` prefers the
 *     engine's own spelling and only synthesises from the normalized descriptor
 *     when `raw` is empty, and /api/ddl/plan outright rejects a column whose
 *     `type.raw` is blank. So the editor keeps a parsed view of the type for the
 *     length/precision/scale boxes but composes `raw` back on every keystroke —
 *     a type the parser did not recognise round-trips verbatim.
 *  2. **A rename is only safe when nothing else about the column changes.**
 *     `detectColumnRenames` (server, ddl-common) treats a differing name as a
 *     rename only when the column counts match and every positional pair is
 *     otherwise identical; anything less certain becomes DROP + ADD, which
 *     destroys the data. The editor says so inline rather than letting the user
 *     find out from the generated script.
 *  3. **Dropping a column is destructive** (§9), so an existing column asks for
 *     its name to be typed. A column that only ever existed in this draft is
 *     removed without ceremony — there is nothing to lose.
 */

import * as React from 'react';
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  KeyRound,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { ColumnModel, EngineKind, TypeDescriptor } from '@/lib/schema-model';
import type { BaseType } from '@/lib/wire';
import { Badge, Button, Checkbox, ConfirmDialog, Input, Select, cn } from '@/components/ui/primitives';

// ---------------------------------------------------------------------------
// Type catalogue
// ---------------------------------------------------------------------------

/** Which parameter boxes a type shows. Anything else shows none. */
export type TypeParamKind = 'none' | 'length' | 'optional-length' | 'precision' | 'precision-scale' | 'values';

export interface TypeOption {
  /** The engine's spelling, lower case — what goes into `type.raw`. */
  name: string;
  base: BaseType;
  params: TypeParamKind;
  /** MySQL numerics accept UNSIGNED. */
  unsigned?: boolean;
  /** Postgres date/time types accept WITH TIME ZONE. */
  timezone?: boolean;
  /** Pre-filled parameter boxes when this type is picked. */
  defaults?: string[];
}

const MYSQL_TYPES: TypeOption[] = [
  { name: 'tinyint', base: 'integer', params: 'optional-length', unsigned: true },
  { name: 'smallint', base: 'integer', params: 'optional-length', unsigned: true },
  { name: 'mediumint', base: 'integer', params: 'optional-length', unsigned: true },
  { name: 'int', base: 'integer', params: 'optional-length', unsigned: true },
  { name: 'bigint', base: 'bigint', params: 'optional-length', unsigned: true },
  { name: 'decimal', base: 'decimal', params: 'precision-scale', unsigned: true, defaults: ['10', '0'] },
  { name: 'float', base: 'float', params: 'none', unsigned: true },
  { name: 'double', base: 'float', params: 'none', unsigned: true },
  { name: 'bit', base: 'bit', params: 'length', defaults: ['1'] },
  { name: 'boolean', base: 'boolean', params: 'none' },
  { name: 'char', base: 'string', params: 'length', defaults: ['1'] },
  { name: 'varchar', base: 'string', params: 'length', defaults: ['255'] },
  { name: 'tinytext', base: 'text', params: 'none' },
  { name: 'text', base: 'text', params: 'none' },
  { name: 'mediumtext', base: 'text', params: 'none' },
  { name: 'longtext', base: 'text', params: 'none' },
  { name: 'binary', base: 'binary', params: 'length', defaults: ['16'] },
  { name: 'varbinary', base: 'binary', params: 'length', defaults: ['255'] },
  { name: 'tinyblob', base: 'binary', params: 'none' },
  { name: 'blob', base: 'binary', params: 'none' },
  { name: 'mediumblob', base: 'binary', params: 'none' },
  { name: 'longblob', base: 'binary', params: 'none' },
  { name: 'enum', base: 'enum', params: 'values', defaults: ["''"] },
  { name: 'set', base: 'set', params: 'values', defaults: ["''"] },
  { name: 'date', base: 'date', params: 'none' },
  { name: 'time', base: 'time', params: 'precision' },
  { name: 'datetime', base: 'timestamp', params: 'precision' },
  { name: 'timestamp', base: 'timestamp', params: 'precision' },
  { name: 'year', base: 'integer', params: 'none' },
  { name: 'json', base: 'json', params: 'none' },
  { name: 'geometry', base: 'geometry', params: 'none' },
  { name: 'point', base: 'geometry', params: 'none' },
  { name: 'linestring', base: 'geometry', params: 'none' },
  { name: 'polygon', base: 'geometry', params: 'none' },
];

const POSTGRES_TYPES: TypeOption[] = [
  { name: 'smallint', base: 'integer', params: 'none' },
  { name: 'integer', base: 'integer', params: 'none' },
  { name: 'bigint', base: 'bigint', params: 'none' },
  { name: 'smallserial', base: 'integer', params: 'none' },
  { name: 'serial', base: 'integer', params: 'none' },
  { name: 'bigserial', base: 'bigint', params: 'none' },
  { name: 'numeric', base: 'decimal', params: 'precision-scale', defaults: ['10', '0'] },
  { name: 'real', base: 'float', params: 'none' },
  { name: 'double precision', base: 'float', params: 'none' },
  { name: 'money', base: 'money', params: 'none' },
  { name: 'boolean', base: 'boolean', params: 'none' },
  { name: 'char', base: 'string', params: 'length', defaults: ['1'] },
  { name: 'varchar', base: 'string', params: 'length', defaults: ['255'] },
  { name: 'text', base: 'text', params: 'none' },
  { name: 'bytea', base: 'binary', params: 'none' },
  { name: 'date', base: 'date', params: 'none' },
  { name: 'time', base: 'time', params: 'precision', timezone: true },
  { name: 'timestamp', base: 'timestamp', params: 'precision', timezone: true },
  { name: 'interval', base: 'interval', params: 'none' },
  { name: 'uuid', base: 'uuid', params: 'none' },
  { name: 'json', base: 'json', params: 'none' },
  { name: 'jsonb', base: 'json', params: 'none' },
  { name: 'xml', base: 'xml', params: 'none' },
  { name: 'inet', base: 'network', params: 'none' },
  { name: 'cidr', base: 'network', params: 'none' },
  { name: 'macaddr', base: 'network', params: 'none' },
  { name: 'bit', base: 'bit', params: 'length', defaults: ['1'] },
  { name: 'bit varying', base: 'bit', params: 'length', defaults: ['8'] },
  { name: 'tsvector', base: 'text', params: 'none' },
  { name: 'point', base: 'geometry', params: 'none' },
  { name: 'polygon', base: 'geometry', params: 'none' },
];

/** SQLite stores by affinity; the declared name is free text, these are the ones that matter. */
const SQLITE_TYPES: TypeOption[] = [
  { name: 'INTEGER', base: 'integer', params: 'none' },
  { name: 'TEXT', base: 'text', params: 'none' },
  { name: 'REAL', base: 'float', params: 'none' },
  { name: 'BLOB', base: 'binary', params: 'none' },
  { name: 'NUMERIC', base: 'decimal', params: 'precision-scale' },
  { name: 'BOOLEAN', base: 'boolean', params: 'none' },
  { name: 'DATE', base: 'date', params: 'none' },
  { name: 'DATETIME', base: 'timestamp', params: 'none' },
  { name: 'VARCHAR', base: 'string', params: 'length', defaults: ['255'] },
];

export function typeCatalog(engine: EngineKind): TypeOption[] {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return MYSQL_TYPES;
    case 'postgres':
      return POSTGRES_TYPES;
    case 'sqlite':
      return SQLITE_TYPES;
    default:
      return [];
  }
}

function findTypeOption(engine: EngineKind, name: string): TypeOption | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return undefined;
  const own = typeCatalog(engine).find((t) => t.name.toLowerCase() === wanted);
  if (own) return own;
  // Aliases the catalogue does not list but every engine understands.
  const alias = ALIASES[wanted];
  if (alias) return typeCatalog(engine).find((t) => t.name.toLowerCase() === alias);
  return undefined;
}

const ALIASES: Record<string, string> = {
  int4: 'integer',
  int8: 'bigint',
  int2: 'smallint',
  int: 'integer',
  bool: 'boolean',
  'character varying': 'varchar',
  character: 'char',
  bpchar: 'char',
  decimal: 'numeric',
  float8: 'double precision',
  float4: 'real',
  timestamptz: 'timestamp',
  timetz: 'time',
  varbit: 'bit varying',
};

// ---------------------------------------------------------------------------
// Parsing / composing `type.raw`
// ---------------------------------------------------------------------------

export interface TypeParts {
  /** `varchar`, `double precision`, `numeric` … */
  name: string;
  /** Whatever was inside the parentheses, split at top level. */
  args: string[];
  unsigned: boolean;
  timezone: boolean;
  /** Postgres `text[][]`. */
  arrayDims: number;
  /** Modifiers the editor does not model (`zerofill`, …), preserved verbatim. */
  tail: string;
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === "'") {
        if (text.charAt(i + 1) === "'") i += 1;
        else quoted = false;
      }
      continue;
    }
    if (ch === "'") quoted = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split at commas that are not inside quotes or nested parentheses. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted) {
      buf += ch;
      if (ch === "'") {
        if (text.charAt(i + 1) === "'") {
          buf += "'";
          i += 1;
        } else quoted = false;
      }
      continue;
    }
    if (ch === "'") {
      quoted = true;
      buf += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== '') out.push(buf.trim());
  return out;
}

const TZ_RE = /\bwith(out)?\s+time\s+zone\b/i;
const UNSIGNED_RE = /\bunsigned\b/i;

export function parseTypeRaw(raw: string): TypeParts {
  let text = (raw ?? '').trim();
  let arrayDims = 0;
  while (text.endsWith('[]')) {
    arrayDims += 1;
    text = text.slice(0, -2).trim();
  }

  let namePart = text;
  let tailPart = '';
  let args: string[] = [];
  const open = text.indexOf('(');
  if (open >= 0) {
    const close = matchingParen(text, open);
    if (close > open) {
      namePart = text.slice(0, open).trim();
      args = splitArgs(text.slice(open + 1, close));
      tailPart = text.slice(close + 1).trim();
    }
  }

  let timezone = false;
  let unsigned = false;
  const strip = (value: string): string => {
    let out = value;
    const tz = TZ_RE.exec(out);
    if (tz) {
      timezone = !tz[1];
      out = out.replace(TZ_RE, ' ');
    }
    if (UNSIGNED_RE.test(out)) {
      unsigned = true;
      out = out.replace(UNSIGNED_RE, ' ');
    }
    return out.replace(/\s+/g, ' ').trim();
  };

  return { name: strip(namePart), args, unsigned, timezone, arrayDims, tail: strip(tailPart) };
}

export function composeTypeRaw(parts: TypeParts): string {
  const args = parts.args.filter((a) => a.trim() !== '');
  const out = [
    parts.name.trim(),
    args.length > 0 ? `(${args.join(',')})` : '',
    parts.unsigned ? ' unsigned' : '',
    parts.tail ? ` ${parts.tail}` : '',
    parts.timezone ? ' with time zone' : '',
    '[]'.repeat(parts.arrayDims),
  ].join('');
  return out.trim();
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Build the canonical descriptor from the edited parts. `raw` is authoritative
 * for every generator; the normalized fields exist for the differ, which falls
 * back to them when two models were both built by hand.
 */
export function descriptorFrom(parts: TypeParts, engine: EngineKind): TypeDescriptor {
  const option = findTypeOption(engine, parts.name);
  const raw = composeTypeRaw(parts);
  const base: BaseType = option?.base ?? guessBase(parts.name);
  const kind: TypeParamKind = option?.params ?? (parts.args.length >= 2 ? 'precision-scale' : parts.args.length === 1 ? 'length' : 'none');

  const descriptor: TypeDescriptor = { raw, base };
  if (kind === 'length' || kind === 'optional-length') descriptor.length = toNumber(parts.args[0]);
  if (kind === 'precision') descriptor.precision = toNumber(parts.args[0]);
  if (kind === 'precision-scale') {
    descriptor.precision = toNumber(parts.args[0]);
    descriptor.scale = toNumber(parts.args[1]);
  }
  if (kind === 'values') descriptor.values = parts.args.map(unquote);
  if (parts.unsigned) descriptor.unsigned = true;
  if (parts.timezone) descriptor.withTimezone = true;
  if (parts.arrayDims > 0) {
    // The element keeps the scalar descriptor; the outer one becomes the array.
    const element: TypeDescriptor = { ...descriptor, raw: composeTypeRaw({ ...parts, arrayDims: 0 }) };
    return { raw, base: 'array', dimensions: parts.arrayDims, elementType: element };
  }
  return descriptor;
}

/** Last-resort classification for a type the catalogue does not know. */
function guessBase(name: string): BaseType {
  const n = name.trim().toLowerCase();
  if (n === '') return 'unknown';
  for (const catalog of [MYSQL_TYPES, POSTGRES_TYPES, SQLITE_TYPES]) {
    const hit = catalog.find((t) => t.name.toLowerCase() === n);
    if (hit) return hit.base;
  }
  if (/int/.test(n)) return /big/.test(n) ? 'bigint' : 'integer';
  if (/char|string/.test(n)) return 'string';
  if (/text|clob/.test(n)) return 'text';
  if (/blob|binary|bytea/.test(n)) return 'binary';
  if (/bool/.test(n)) return 'boolean';
  if (/timestamp|datetime/.test(n)) return 'timestamp';
  if (/date/.test(n)) return 'date';
  if (/time/.test(n)) return 'time';
  if (/dec|numeric/.test(n)) return 'decimal';
  if (/float|real|double/.test(n)) return 'float';
  if (/json/.test(n)) return 'json';
  if (/uuid|guid/.test(n)) return 'uuid';
  return 'unknown';
}

/** A fresh column, typed the way each engine spells its default integer. */
export function newColumn(engine: EngineKind, position: number, name?: string): ColumnModel {
  const raw = engine === 'postgres' ? 'integer' : engine === 'sqlite' ? 'INTEGER' : 'int';
  return {
    name: name ?? `column_${position}`,
    position,
    type: { raw, base: 'integer' },
    nullable: true,
    defaultValue: null,
  };
}

/** Positions are authoritative for ordering (`orderedColumns`), so renumber on every move. */
export function renumber(columns: ColumnModel[]): ColumnModel[] {
  return columns.map((c, i) => (c.position === i + 1 ? c : { ...c, position: i + 1 }));
}

// ---------------------------------------------------------------------------
// Engine capability predicates
// ---------------------------------------------------------------------------

function isMysqlFamily(engine: EngineKind): boolean {
  return engine === 'mysql' || engine === 'mariadb';
}

/** What the auto-increment checkbox is actually called on this engine. */
export function autoIncrementLabel(engine: EngineKind): string {
  if (isMysqlFamily(engine)) return 'AUTO_INCREMENT';
  if (engine === 'postgres') return 'IDENTITY';
  return 'AUTOINCREMENT';
}

function supportsColumnComment(engine: EngineKind): boolean {
  // Postgres has column comments, but as a separate COMMENT ON statement; the
  // planner emits them, so the box is offered there too. SQLite has none.
  return engine !== 'sqlite';
}

function supportsCharset(engine: EngineKind): boolean {
  return isMysqlFamily(engine);
}

// ---------------------------------------------------------------------------
// ColumnEditor
// ---------------------------------------------------------------------------

/** Renames and drops have to follow through into indexes, keys and the PK. */
export type ColumnEffect =
  | { type: 'rename'; from: string; to: string }
  | { type: 'drop'; name: string };

export interface ColumnEditorProps {
  engine: EngineKind;
  columns: ColumnModel[];
  primaryKey: string[];
  /** Column names that exist on the server: dropping one of those loses data. */
  existingNames: ReadonlySet<string>;
  onChange: (columns: ColumnModel[], primaryKey: string[], effect?: ColumnEffect) => void;
  readOnly?: boolean;
}

export function ColumnEditor({
  engine,
  columns,
  primaryKey,
  existingNames,
  onChange,
  readOnly = false,
}: ColumnEditorProps) {
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [dropIndex, setDropIndex] = React.useState<number | null>(null);
  const [pendingDrop, setPendingDrop] = React.useState<{ index: number; name: string } | null>(null);
  const listId = React.useId();

  const catalog = typeCatalog(engine);

  function patch(index: number, changes: Partial<ColumnModel>): void {
    const next = columns.map((c, i) => (i === index ? { ...c, ...changes } : c));
    onChange(renumber(next), primaryKey);
  }

  function rename(index: number, to: string): void {
    const from = columns[index].name;
    const next = columns.map((c, i) => (i === index ? { ...c, name: to } : c));
    const pk = primaryKey.map((k) => (k === from ? to : k));
    onChange(renumber(next), pk, from === to ? undefined : { type: 'rename', from, to });
  }

  function togglePk(name: string, on: boolean): void {
    const pk = on ? [...primaryKey.filter((k) => k !== name), name] : primaryKey.filter((k) => k !== name);
    // A key column is NOT NULL by definition: MySQL rejects the DDL outright and
    // Postgres silently promotes it, so the draft is made to say what will
    // actually happen rather than leaving the checkbox lying.
    const next = on ? columns.map((c) => (c.name === name ? { ...c, nullable: false } : c)) : columns;
    onChange(next, pk);
  }

  function removeAt(index: number): void {
    const name = columns[index].name;
    const next = columns.filter((_, i) => i !== index);
    onChange(renumber(next), primaryKey.filter((k) => k !== name), { type: 'drop', name });
    setExpanded(new Set());
  }

  function requestRemove(index: number): void {
    const name = columns[index].name;
    // §9: only an existing column has data to lose; a draft-only one just goes.
    if (existingNames.has(name)) setPendingDrop({ index, name });
    else removeAt(index);
  }

  function add(): void {
    // Adding after a delete must not resurrect a name that is still in use.
    const taken = new Set(columns.map((c) => c.name));
    let n = columns.length + 1;
    while (taken.has(`column_${n}`)) n += 1;
    const next = [...columns, newColumn(engine, columns.length + 1, `column_${n}`)];
    onChange(renumber(next), primaryKey);
  }

  function move(from: number, to: number): void {
    if (from === to || to < 0 || to >= columns.length) return;
    const next = [...columns];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(renumber(next), primaryKey);
  }

  function toggleExpanded(index: number): void {
    const next = new Set(expanded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setExpanded(next);
  }

  const duplicates = React.useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const c of columns) {
      const key = c.name.trim().toLowerCase();
      if (key === '') continue;
      if (seen.has(key)) dupes.add(key);
      seen.add(key);
    }
    return dupes;
  }, [columns]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-[980px]">
          <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--border)] bg-[var(--grid-header)] px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">
            <span className="w-4" />
            <span className="w-6 text-center" title="Primary key">
              PK
            </span>
            <span className="w-44">Name</span>
            <span className="w-40">Type</span>
            <span className="w-[104px]">Params</span>
            <span className="w-16 text-center">Null</span>
            <span className="w-40">Default</span>
            <span className="w-24 text-center" title={autoIncrementLabel(engine)}>
              Auto
            </span>
            <span className="ml-auto w-16 text-right">More</span>
          </div>

          {columns.map((column, index) => {
            const parts = parseTypeRaw(column.type.raw ?? '');
            const option = findTypeOption(engine, parts.name);
            const isPk = primaryKey.includes(column.name);
            const isNew = !existingNames.has(column.name);
            const isDup = duplicates.has(column.name.trim().toLowerCase());

            const setParts = (nextParts: TypeParts): void =>
              patch(index, { type: descriptorFrom(nextParts, engine) });

            const setArg = (position: number, value: string): void => {
              const args = [...parts.args];
              while (args.length <= position) args.push('');
              args[position] = value;
              setParts({ ...parts, args });
            };

            return (
              <div
                key={index}
                draggable={!readOnly}
                onDragStart={(e) => {
                  setDragIndex(index);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDropIndex(index);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null) move(dragIndex, index);
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                className={cn(
                  'border-b border-[var(--border)]',
                  index % 2 === 1 && 'bg-[var(--row-alt)]',
                  dragIndex === index && 'opacity-40',
                  dropIndex === index && dragIndex !== null && dragIndex !== index && 'shadow-[inset_0_2px_0_var(--accent)]',
                )}
              >
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <span
                    className={cn(
                      'w-4 shrink-0 text-[var(--fg-subtle)]',
                      readOnly ? 'opacity-30' : 'cursor-grab active:cursor-grabbing',
                    )}
                    title="Drag to reorder"
                  >
                    <GripVertical className="size-3.5" />
                  </span>

                  <span className="flex w-6 shrink-0 justify-center">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--accent)] cursor-pointer"
                      checked={isPk}
                      disabled={readOnly}
                      title="Part of the primary key"
                      onChange={(e) => togglePk(column.name, e.target.checked)}
                    />
                  </span>

                  <Input
                    className={cn('w-44 shrink-0 mono', isDup && 'border-[var(--danger)]')}
                    value={column.name}
                    disabled={readOnly}
                    spellCheck={false}
                    onChange={(e) => rename(index, e.target.value)}
                    title={isDup ? 'Another column already has this name' : column.name}
                  />

                  <Input
                    className="w-40 shrink-0 mono"
                    value={parts.name}
                    disabled={readOnly}
                    spellCheck={false}
                    list={`${listId}-types`}
                    placeholder="type"
                    onChange={(e) => setParts(retype(parts, e.target.value, engine))}
                  />

                  <span className="flex w-[104px] shrink-0 items-center gap-1">
                    <TypeParams
                      option={option}
                      parts={parts}
                      disabled={readOnly}
                      onArg={setArg}
                      onArgs={(args) => setParts({ ...parts, args })}
                    />
                  </span>

                  <span className="flex w-16 shrink-0 justify-center">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--accent)] cursor-pointer"
                      checked={column.nullable}
                      disabled={readOnly || isPk}
                      title={isPk ? 'A primary key column is never nullable' : 'Allow NULL'}
                      onChange={(e) => patch(index, { nullable: e.target.checked })}
                    />
                  </span>

                  <Input
                    className="w-40 shrink-0 mono"
                    value={column.defaultValue ?? ''}
                    disabled={readOnly || !!column.generated}
                    spellCheck={false}
                    placeholder={column.generated ? 'generated' : 'none'}
                    onChange={(e) => patch(index, { defaultValue: e.target.value === '' ? null : e.target.value })}
                    title={
                      isMysqlFamily(engine)
                        ? 'MySQL reports defaults unquoted: a bare word in a text column is quoted for you, a parenthesised expression is not.'
                        : 'Written verbatim into DEFAULT — quote string literals yourself.'
                    }
                  />

                  <span className="flex w-24 shrink-0 justify-center">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--accent)] cursor-pointer"
                      checked={!!column.autoIncrement}
                      disabled={readOnly || !!column.generated}
                      title={autoIncrementLabel(engine)}
                      onChange={(e) => patch(index, { autoIncrement: e.target.checked || undefined })}
                    />
                  </span>

                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {isPk && (
                      <KeyRound className="size-3 text-[var(--warn)]" aria-label="primary key" />
                    )}
                    {isNew && existingNames.size > 0 && <Badge tone="accent">new</Badge>}
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => toggleExpanded(index)}
                      title="Generated, collation, comment"
                    >
                      {expanded.has(index) ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={readOnly}
                      onClick={() => requestRemove(index)}
                      title="Drop this column"
                    >
                      <Trash2 className="size-3.5 text-[var(--danger)]" />
                    </Button>
                  </span>
                </div>

                {expanded.has(index) && (
                  <ColumnDetails
                    engine={engine}
                    column={column}
                    parts={parts}
                    option={option}
                    disabled={readOnly}
                    onPatch={(changes) => patch(index, changes)}
                    onParts={setParts}
                  />
                )}
              </div>
            );
          })}

          <datalist id={`${listId}-types`}>
            {catalog.map((t) => (
              <option key={t.name} value={t.name} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-2 py-1.5">
        <Button size="xs" icon={<Plus className="size-3.5" />} disabled={readOnly} onClick={add}>
          Add column
        </Button>
        <span className="text-[11px] text-[var(--fg-subtle)]">
          {columns.length} column{columns.length === 1 ? '' : 's'}
          {primaryKey.length > 0 ? ` · PK (${primaryKey.join(', ')})` : ' · no primary key'}
        </span>
        {primaryKey.length === 0 && (
          <span className="flex items-center gap-1 text-[11px] text-[var(--warn)]">
            <TriangleAlert className="size-3" />
            Without a unique key the grid cannot edit this table&apos;s rows.
          </span>
        )}
      </div>

      <ConfirmDialog
        open={pendingDrop !== null}
        onClose={() => setPendingDrop(null)}
        onConfirm={() => {
          if (pendingDrop) removeAt(pendingDrop.index);
        }}
        title="Drop this column?"
        confirmWord={pendingDrop?.name}
        message={
          <div className="flex flex-col gap-2">
            <p>
              <strong className="mono">{pendingDrop?.name}</strong> exists on the server. Dropping it deletes
              every value it holds, and no rollback brings them back once the script commits.
            </p>
            <p className="text-[var(--fg-muted)]">
              If you meant to rename it, close this and edit the name in place instead — a rename keeps the
              data, but only when nothing else about the column changes in the same script.
            </p>
          </div>
        }
      />
    </div>
  );
}

/**
 * Switching to a different family of type must not carry the old parameters
 * over (`decimal(10,2)` → `varchar(10,2)` is not valid SQL), so the boxes reset
 * to the new type's defaults whenever the parameter shape changes. A type the
 * catalogue does not know keeps whatever the user typed.
 */
function retype(previous: TypeParts, typed: string, engine: EngineKind): TypeParts {
  const parsed = parseTypeRaw(typed);
  const before = findTypeOption(engine, previous.name);
  const after = findTypeOption(engine, parsed.name);

  // The user typed the whole spelling (`varchar(80)`) — take it as written.
  if (parsed.args.length > 0) return { ...previous, ...parsed };

  const sameShape = (before?.params ?? 'none') === (after?.params ?? 'none');
  const args = sameShape ? previous.args : (after?.defaults ?? []);
  return {
    ...previous,
    name: parsed.name,
    args,
    unsigned: after?.unsigned ? previous.unsigned : false,
    timezone: after?.timezone ? previous.timezone : false,
  };
}

// ---------------------------------------------------------------------------
// Parameter boxes — only for types that take them
// ---------------------------------------------------------------------------

function TypeParams({
  option,
  parts,
  disabled,
  onArg,
  onArgs,
}: {
  option: TypeOption | undefined;
  parts: TypeParts;
  disabled: boolean;
  onArg: (position: number, value: string) => void;
  onArgs: (args: string[]) => void;
}) {
  const kind: TypeParamKind = option?.params ?? (parts.args.length > 0 ? 'length' : 'none');

  if (kind === 'none') return <span className="text-[11px] text-[var(--fg-subtle)]">—</span>;

  if (kind === 'values') {
    return (
      <Input
        className="mono w-[104px]"
        value={parts.args.join(',')}
        disabled={disabled}
        spellCheck={false}
        placeholder="'a','b'"
        title="Quoted values, comma separated"
        onChange={(e) => onArgs(splitArgs(e.target.value))}
      />
    );
  }

  if (kind === 'precision-scale') {
    return (
      <>
        <Input
          className="mono w-12"
          value={parts.args[0] ?? ''}
          disabled={disabled}
          inputMode="numeric"
          placeholder="p"
          title="Precision"
          onChange={(e) => onArg(0, e.target.value)}
        />
        <Input
          className="mono w-12"
          value={parts.args[1] ?? ''}
          disabled={disabled}
          inputMode="numeric"
          placeholder="s"
          title="Scale"
          onChange={(e) => onArg(1, e.target.value)}
        />
      </>
    );
  }

  return (
    <Input
      className="mono w-[104px]"
      value={parts.args[0] ?? ''}
      disabled={disabled}
      inputMode="numeric"
      placeholder={kind === 'precision' ? 'precision' : kind === 'optional-length' ? 'display' : 'length'}
      title={kind === 'precision' ? 'Fractional-seconds precision' : 'Length'}
      onChange={(e) => onArg(0, e.target.value)}
    />
  );
}

// ---------------------------------------------------------------------------
// The per-column drawer: generated columns, collation, comment
// ---------------------------------------------------------------------------

function ColumnDetails({
  engine,
  column,
  parts,
  option,
  disabled,
  onPatch,
  onParts,
}: {
  engine: EngineKind;
  column: ColumnModel;
  parts: TypeParts;
  option: TypeOption | undefined;
  disabled: boolean;
  onPatch: (changes: Partial<ColumnModel>) => void;
  onParts: (parts: TypeParts) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-dashed border-[var(--border)] bg-[var(--bg-subtle)] px-8 py-2">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">Generated</span>
        <Select
          className="w-28"
          value={column.generated ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const value = e.target.value;
            onPatch({
              generated: value === '' ? undefined : (value as 'stored' | 'virtual'),
              // A generated column cannot also carry a default or auto-increment.
              defaultValue: value === '' ? column.defaultValue : null,
              autoIncrement: value === '' ? column.autoIncrement : undefined,
              generatedExpression: value === '' ? undefined : (column.generatedExpression ?? ''),
            });
          }}
        >
          <option value="">no</option>
          <option value="stored">stored</option>
          <option value="virtual">virtual</option>
        </Select>
      </label>

      {column.generated && (
        <label className="flex min-w-[240px] flex-1 flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">Expression</span>
          <Input
            className="mono"
            value={column.generatedExpression ?? ''}
            disabled={disabled}
            spellCheck={false}
            placeholder="price * quantity"
            onChange={(e) => onPatch({ generatedExpression: e.target.value })}
          />
        </label>
      )}

      {option?.unsigned && isMysqlFamily(engine) && (
        <Checkbox
          label={<span className="text-[11px]">unsigned</span>}
          checked={parts.unsigned}
          disabled={disabled}
          onChange={(e) => onParts({ ...parts, unsigned: e.target.checked })}
        />
      )}

      {option?.timezone && engine === 'postgres' && (
        <Checkbox
          label={<span className="text-[11px]">with time zone</span>}
          checked={parts.timezone}
          disabled={disabled}
          onChange={(e) => onParts({ ...parts, timezone: e.target.checked })}
        />
      )}

      {engine === 'postgres' && (
        <Checkbox
          label={<span className="text-[11px]">array</span>}
          checked={parts.arrayDims > 0}
          disabled={disabled}
          onChange={(e) => onParts({ ...parts, arrayDims: e.target.checked ? 1 : 0 })}
        />
      )}

      {supportsCharset(engine) && (
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">Charset</span>
          <Input
            className="mono w-32"
            value={column.charset ?? ''}
            disabled={disabled}
            spellCheck={false}
            placeholder="table default"
            onChange={(e) => onPatch({ charset: e.target.value || undefined })}
          />
        </label>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">Collation</span>
        <Input
          className="mono w-44"
          value={column.collation ?? ''}
          disabled={disabled}
          spellCheck={false}
          placeholder={engine === 'postgres' ? 'database default' : 'table default'}
          onChange={(e) => onPatch({ collation: e.target.value || undefined })}
        />
      </label>

      {supportsColumnComment(engine) && (
        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">Comment</span>
          <Input
            value={column.comment ?? ''}
            disabled={disabled}
            onChange={(e) => onPatch({ comment: e.target.value || undefined })}
          />
        </label>
      )}

      <span className="mono w-full text-[11px] text-[var(--fg-subtle)]">{column.type.raw}</span>
    </div>
  );
}
