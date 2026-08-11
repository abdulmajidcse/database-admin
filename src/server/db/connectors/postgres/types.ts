/**
 * Postgres type fidelity (PLAN §6 "Type fidelity").
 *
 * The rule for this file: **the driver never converts anything**. Every text
 * value that comes off the wire stays a string, and this module turns it into a
 * `Cell` with full knowledge of the column's pg_type entry. That is the only way
 * to keep `int8`, `numeric`, `money`, `date`, `timestamp`, `timestamptz` and
 * `interval` lossless — node-postgres' defaults would hand us JS numbers (which
 * overflow at 2^53 and round decimals) and JS `Date`s (which mangle timezones
 * and truncate microseconds).
 *
 * `bytea` becomes a Buffer here and then a base64 `bytes` cell; arrays keep
 * their element structure and are tagged `array`.
 */

import { Buffer } from 'node:buffer';
import { escapeIdentifier, escapeLiteral, types as pgTypes } from 'pg';
import type { CustomTypesConfig } from 'pg';
import { bytesCell, tag } from '../../../../lib/wire';
import type { BaseType, Cell, TaggedCell } from '../../../../lib/wire';
import type { TypeDescriptor } from '../../../../lib/schema-model';
import { DbError } from '../../types';

// ---------------------------------------------------------------------------
// Driver-level parsers: keep everything as text.
// ---------------------------------------------------------------------------

/** node-postgres' own parser table, used only for the binary format. */
const defaultParser = pgTypes.getTypeParser as unknown as (
  oid: number,
  format?: string,
) => (value: string) => unknown;

const keepText = (value: string): string => value;

/**
 * Per-pool parser config (never the global `pg.types.setTypeParser`, which
 * would leak across connections to different servers).
 *
 * Text format → identity. We do the decoding ourselves in `encodePgCell` where
 * we still know the OID and can produce a lossless tagged cell.
 */
export const PG_TEXT_TYPES: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) =>
    format === 'binary' ? defaultParser(oid, format) : keepText) as CustomTypesConfig['getTypeParser'],
};

// ---------------------------------------------------------------------------
// Built-in OIDs. The registry below covers user types; these are the fallback
// so encoding still works if the catalog snapshot could not be loaded.
// ---------------------------------------------------------------------------

export const PG_OID = {
  bool: 16,
  bytea: 17,
  char: 18,
  name: 19,
  int8: 20,
  int2: 21,
  int4: 23,
  regproc: 24,
  text: 25,
  oid: 26,
  json: 114,
  xml: 142,
  point: 600,
  lseg: 601,
  path: 602,
  box: 603,
  polygon: 604,
  line: 628,
  cidr: 650,
  float4: 700,
  float8: 701,
  circle: 718,
  macaddr8: 774,
  money: 790,
  macaddr: 829,
  inet: 869,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
  bit: 1560,
  varbit: 1562,
  numeric: 1700,
  uuid: 2950,
  tsvector: 3614,
  jsonb: 3802,
} as const;

const BUILTIN_NAME_BY_OID: Record<number, string> = Object.fromEntries(
  Object.entries(PG_OID).map(([name, oid]) => [oid, name]),
);

/** Array OID → element OID for the built-ins (pg_type.typelem). */
const BUILTIN_ARRAY_ELEM: Record<number, number> = {
  199: PG_OID.json,
  629: PG_OID.line,
  651: PG_OID.cidr,
  719: PG_OID.circle,
  775: PG_OID.macaddr8,
  791: PG_OID.money,
  1000: PG_OID.bool,
  1001: PG_OID.bytea,
  1002: PG_OID.char,
  1003: PG_OID.name,
  1005: PG_OID.int2,
  1007: PG_OID.int4,
  1009: PG_OID.text,
  1014: PG_OID.bpchar,
  1015: PG_OID.varchar,
  1016: PG_OID.int8,
  1017: PG_OID.point,
  1018: PG_OID.lseg,
  1019: PG_OID.path,
  1020: PG_OID.box,
  1021: PG_OID.float4,
  1022: PG_OID.float8,
  1027: PG_OID.polygon,
  1028: PG_OID.oid,
  1040: PG_OID.macaddr,
  1041: PG_OID.inet,
  1115: PG_OID.timestamp,
  1182: PG_OID.date,
  1183: PG_OID.time,
  1185: PG_OID.timestamptz,
  1187: PG_OID.interval,
  1231: PG_OID.numeric,
  1270: PG_OID.timetz,
  1561: PG_OID.bit,
  1563: PG_OID.varbit,
  2951: PG_OID.uuid,
  3807: PG_OID.jsonb,
  143: PG_OID.xml,
};

// ---------------------------------------------------------------------------
// The catalog snapshot: one query at connect time buys correct decoding of
// enums, domains, ranges and arrays of user-defined types with no per-row work.
// ---------------------------------------------------------------------------

export interface PgTypeInfo {
  oid: number;
  name: string;
  schema: string;
  /** pg_type.typtype: b base, c composite, d domain, e enum, p pseudo, r range, m multirange. */
  kind: string;
  /** pg_type.typcategory; 'A' means array. */
  category: string;
  /** pg_type.typelem — the element type for arrays. */
  elem: number;
  /** pg_type.typbasetype — the underlying type for domains. */
  base: number;
  delim: string;
}

export class PgTypeRegistry {
  private byOid = new Map<number, PgTypeInfo>();

  set(info: PgTypeInfo): void {
    this.byOid.set(info.oid, info);
  }

  get(oid: number): PgTypeInfo | undefined {
    return this.byOid.get(oid);
  }

  /** OIDs we have never seen — triggers a lazy top-up query, never a per-row one. */
  missing(oids: Iterable<number>): number[] {
    const out = new Set<number>();
    for (const oid of oids) {
      if (!oid) continue;
      if (this.byOid.has(oid)) continue;
      if (BUILTIN_NAME_BY_OID[oid] || BUILTIN_ARRAY_ELEM[oid]) continue;
      out.add(oid);
    }
    return [...out];
  }

  nameOf(oid: number): string {
    return this.byOid.get(oid)?.name ?? BUILTIN_NAME_BY_OID[oid] ?? `oid:${oid}`;
  }

  /** Human type name used for `ColumnMeta.typeName`. Arrays render as `elem[]`. */
  displayName(oid: number): string {
    const info = this.byOid.get(oid);
    if (info && info.category === 'A' && info.elem) return `${this.nameOf(info.elem)}[]`;
    const elem = BUILTIN_ARRAY_ELEM[oid];
    if (!info && elem) return `${this.nameOf(elem)}[]`;
    return this.nameOf(oid);
  }

  baseOf(oid: number): BaseType {
    const info = this.byOid.get(oid);
    if (info) {
      if (info.kind === 'd' && info.base) return this.baseOf(info.base);
      if (info.category === 'A' && info.elem) return 'array';
      return pgBaseType(info.name, info.kind, info.category);
    }
    if (BUILTIN_ARRAY_ELEM[oid]) return 'array';
    const name = BUILTIN_NAME_BY_OID[oid];
    return name ? pgBaseType(name, 'b', '') : 'unknown';
  }
}

/** Maps a pg_type row onto the engine-neutral `BaseType` (PLAN §4). */
export function pgBaseType(name: string, kind: string, category: string): BaseType {
  if (kind === 'e') return 'enum';
  if (category === 'A') return 'array';
  switch (name) {
    case 'bool':
      return 'boolean';
    case 'int2':
    case 'int4':
    case 'oid':
    case 'xid':
    case 'cid':
      return 'integer';
    case 'int8':
      return 'bigint';
    case 'numeric':
      return 'decimal';
    case 'money':
      return 'money';
    case 'float4':
    case 'float8':
      return 'float';
    case 'char':
    case 'bpchar':
    case 'varchar':
    case 'name':
      return 'string';
    case 'text':
    case 'citext':
    case 'tsvector':
    case 'tsquery':
      return 'text';
    case 'bytea':
      return 'binary';
    case 'date':
      return 'date';
    case 'time':
    case 'timetz':
      return 'time';
    case 'timestamp':
    case 'timestamptz':
      return 'timestamp';
    case 'interval':
      return 'interval';
    case 'json':
    case 'jsonb':
      return 'json';
    case 'uuid':
      return 'uuid';
    case 'bit':
    case 'varbit':
      return 'bit';
    case 'xml':
      return 'xml';
    case 'inet':
    case 'cidr':
    case 'macaddr':
    case 'macaddr8':
      return 'network';
    case 'point':
    case 'line':
    case 'lseg':
    case 'box':
    case 'path':
    case 'polygon':
    case 'circle':
    case 'geometry':
    case 'geography':
      return 'geometry';
    default:
      if (kind === 'c') return 'json';
      if (kind === 'r' || kind === 'm') return 'string';
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Array + bytea text decoding.
// ---------------------------------------------------------------------------

export type PgArrayElement = string | null | PgArrayElement[];

/**
 * Parses Postgres' array output syntax, including nested dimensions, quoted
 * elements with backslash escapes, and the `[1:3]=` dimension prefix. We do this
 * ourselves rather than using pg's array parser because we need the *raw*
 * element text — the element parser must run through `encodePgCell` so a
 * `numeric[]` keeps full precision.
 */
export function parsePgArray(source: string, delim = ','): PgArrayElement[] {
  let i = 0;
  if (source.charAt(0) === '[') {
    const eq = source.indexOf('=');
    if (eq >= 0) i = eq + 1;
  }
  if (source.charAt(i) !== '{') return [];

  const parseList = (): PgArrayElement[] => {
    const out: PgArrayElement[] = [];
    i++; // '{'
    if (source.charAt(i) === '}') {
      i++;
      return out;
    }
    for (;;) {
      const ch = source.charAt(i);
      if (ch === '{') {
        out.push(parseList());
      } else if (ch === '"') {
        i++;
        let s = '';
        while (i < source.length && source.charAt(i) !== '"') {
          if (source.charAt(i) === '\\') i++;
          s += source.charAt(i);
          i++;
        }
        i++; // closing quote
        out.push(s);
      } else {
        let s = '';
        let escaped = false;
        while (i < source.length && source.charAt(i) !== delim && source.charAt(i) !== '}') {
          if (source.charAt(i) === '\\') {
            i++;
            escaped = true;
          }
          s += source.charAt(i);
          i++;
        }
        out.push(!escaped && s === 'NULL' ? null : s);
      }
      if (source.charAt(i) === delim) {
        i++;
        continue;
      }
      i++; // '}' or end of input
      break;
    }
    return out;
  };

  return parseList();
}

/** `bytea` text output: hex (`\x4142`, the default since 9.0) or the legacy escape format. */
export function decodeBytea(text: string): Buffer {
  if (text.startsWith('\\x')) return Buffer.from(text.slice(2), 'hex');
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== '\\') {
      out.push(text.charCodeAt(i));
      continue;
    }
    if (text.charAt(i + 1) === '\\') {
      out.push(0x5c);
      i++;
      continue;
    }
    out.push(parseInt(text.slice(i + 1, i + 4), 8));
    i += 3;
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// Value → wire Cell.
// ---------------------------------------------------------------------------

function numberCell(text: string): Cell {
  const n = Number(text);
  // NaN / Infinity survive in Postgres floats but not in JSON — keep the text.
  if (!Number.isFinite(n)) return tag('decimal', text);
  return n;
}

function encodeArrayElements(
  elements: PgArrayElement[],
  elemOid: number,
  reg: PgTypeRegistry,
): unknown[] {
  return elements.map((e) => {
    if (e === null) return null;
    if (Array.isArray(e)) return encodeArrayElements(e, elemOid, reg);
    return encodePgCell(elemOid, e, reg);
  });
}

/**
 * Turn one raw text value into a wire `Cell` (PLAN §6). `raw` is exactly what
 * the server sent — never a driver-converted value.
 */
export function encodePgCell(oid: number, raw: string, reg: PgTypeRegistry): Cell {
  const info = reg.get(oid);

  // Domains are transparent wrappers: decode as the underlying type.
  if (info && info.kind === 'd' && info.base) return encodePgCell(info.base, raw, reg);

  const elemOid = info && info.category === 'A' ? info.elem : BUILTIN_ARRAY_ELEM[oid];
  if (elemOid) {
    const parsed = parsePgArray(raw, info?.delim || ',');
    // `of` carries the element type so the grid can render/edit sensibly.
    return tag('array', JSON.stringify(encodeArrayElements(parsed, elemOid, reg)), reg.nameOf(elemOid));
  }

  if (info && info.kind === 'e') return raw; // enum labels are plain text

  const name = info?.name ?? BUILTIN_NAME_BY_OID[oid] ?? '';
  switch (name) {
    case 'bool':
      return raw === 't' || raw === 'true' || raw === 'y';
    case 'int2':
    case 'int4':
    case 'oid':
    case 'xid':
    case 'cid':
      return Number(raw);
    case 'int8':
      return tag('bigint', raw);
    case 'numeric':
      return tag('decimal', raw);
    case 'money':
      return tag('decimal', raw, 'money');
    case 'float4':
    case 'float8':
      return numberCell(raw);
    case 'bytea':
      return bytesCell(decodeBytea(raw));
    case 'date':
      return tag('date', raw);
    case 'time':
    case 'timetz':
      return tag('time', raw);
    case 'timestamp':
      return tag('timestamp', raw);
    case 'timestamptz':
      return tag('timestamptz', raw);
    case 'interval':
      return tag('interval', raw);
    case 'json':
    case 'jsonb':
      // Kept as text: JSON.parse would round `1e400` and lose numeric precision.
      return tag('json', raw);
    case 'uuid':
      return tag('uuid', raw);
    case 'bit':
    case 'varbit':
      return tag('bit', raw);
    case 'point':
    case 'line':
    case 'lseg':
    case 'box':
    case 'path':
    case 'polygon':
    case 'circle':
    case 'geometry':
    case 'geography':
      return tag('geo', raw, name);
    default:
      if (info?.kind === 'c') return tag('json', raw, info.name);
      return raw;
  }
}

/**
 * Wire `Cell` → a bound parameter. Postgres infers the parameter type from the
 * target column, so the lossless text form round-trips exactly; only bytea has
 * to become a Buffer, and `array` cells become real JS arrays so node-postgres
 * builds a correct `{…}` literal (including nesting and embedded quotes).
 */
export function cellToPgParam(cell: unknown): unknown {
  if (cell === null || cell === undefined) return null;
  if (Array.isArray(cell)) return cell.map(cellToPgParam);
  if (typeof cell !== 'object') return cell;
  const tagged = cell as TaggedCell;
  if (tagged.$t === 'bytes') return Buffer.from(tagged.v, 'base64');
  if (tagged.$t === 'array') return (JSON.parse(tagged.v) as unknown[]).map(cellToPgParam);
  return tagged.v;
}

// ---------------------------------------------------------------------------
// Quoting. Identifiers we build ourselves NEVER get string-concatenated (§9).
// ---------------------------------------------------------------------------

export function quoteIdent(name: string): string {
  return escapeIdentifier(name);
}

export function quoteLiteral(value: string): string {
  return escapeLiteral(value);
}

export function qualify(schema: string | undefined, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
}

/** Postgres array output syntax, for the preview only. */
function arrayLiteralText(items: unknown[]): string {
  const parts = items.map((item) => {
    if (item === null || item === undefined) return 'NULL';
    if (Array.isArray(item)) return arrayLiteralText(item);
    const tagged = typeof item === 'object' ? (item as TaggedCell) : null;
    const text = tagged ? tagged.v : String(item);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(',')}}`;
}

/** SQL literal for a wire cell — used by changeset *previews*, never to execute. */
export function cellToSqlLiteral(cell: Cell): string {
  if (cell === null) return 'NULL';
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : quoteLiteral(String(cell));
  if (typeof cell === 'string') return quoteLiteral(cell);
  if (cell.$t === 'bytes') return `'\\x${Buffer.from(cell.v, 'base64').toString('hex')}'::bytea`;
  if (cell.$t === 'array') return quoteLiteral(arrayLiteralText(JSON.parse(cell.v) as unknown[]));
  return quoteLiteral(cell.v);
}

// ---------------------------------------------------------------------------
// Type descriptors for the canonical schema model (PLAN §4).
// ---------------------------------------------------------------------------

export interface PgTypeDescriptorInput {
  /** `format_type(atttypid, atttypmod)` — the engine's own spelling. */
  raw: string;
  typeName: string;
  typeKind: string;
  typeCategory: string;
  elemTypeName?: string | null;
  baseTypeName?: string | null;
  typmod: number;
  dims: number;
  enumValues?: string[];
}

function applyTypmod(desc: TypeDescriptor, typeName: string, typmod: number): void {
  if (typmod < 0) return;
  switch (typeName) {
    case 'numeric': {
      const t = typmod - 4;
      desc.precision = (t >> 16) & 0xffff;
      desc.scale = t & 0xffff;
      break;
    }
    case 'varchar':
    case 'bpchar':
      desc.length = typmod - 4;
      break;
    case 'bit':
    case 'varbit':
      desc.length = typmod;
      break;
    case 'time':
    case 'timetz':
    case 'timestamp':
    case 'timestamptz':
      desc.precision = typmod;
      break;
    case 'interval':
      desc.precision = typmod & 0xffff;
      break;
    default:
      break;
  }
}

export function pgTypeDescriptor(input: PgTypeDescriptorInput): TypeDescriptor {
  const { raw, typeName, typeKind, typeCategory, typmod, dims } = input;

  if (typeCategory === 'A' && input.elemTypeName) {
    const elementRaw = raw.replace(/(\[\d*\])+$/, '');
    const element: TypeDescriptor = {
      raw: elementRaw || input.elemTypeName,
      base: pgBaseType(input.elemTypeName, 'b', ''),
    };
    applyTypmod(element, input.elemTypeName, typmod);
    if (input.enumValues) {
      element.base = 'enum';
      element.values = input.enumValues;
    }
    if (input.elemTypeName === 'timestamptz' || input.elemTypeName === 'timetz') element.withTimezone = true;
    return {
      raw,
      base: 'array',
      elementType: element,
      dimensions: Math.max(dims, 1),
    };
  }

  // Domains report their own name in `raw` but behave like the base type.
  const effective = typeKind === 'd' && input.baseTypeName ? input.baseTypeName : typeName;
  const desc: TypeDescriptor = { raw, base: pgBaseType(effective, typeKind, typeCategory) };
  applyTypmod(desc, effective, typmod);
  if (effective === 'timestamptz' || effective === 'timetz') desc.withTimezone = true;
  if (input.enumValues) {
    desc.base = 'enum';
    desc.values = input.enumValues;
  }
  return desc;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface PgErrorShape {
  message?: string;
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
  severity?: string;
}

/** Wrap a driver error so the UI can special-case by SQLSTATE. */
export function toDbError(err: unknown, context?: string): DbError {
  if (err instanceof DbError) return err;
  const e = (err ?? {}) as PgErrorShape;
  const message = e.message ?? String(err);
  const detail = [e.detail, e.hint].filter(Boolean).join('\n') || undefined;
  const position = e.position ? Number(e.position) : undefined;
  return new DbError(context ? `${context}: ${message}` : message, e.code, detail, position);
}
