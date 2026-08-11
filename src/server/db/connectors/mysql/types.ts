/**
 * MySQL / MariaDB type fidelity (PLAN §6 "Type fidelity").
 *
 * mysql2's defaults lose data: BIGINT overflows a JS number, DECIMAL becomes a
 * float, DATETIME is inflated into a `Date` in the *server process* timezone,
 * and JSON is parsed then re-stringified (which loses key order, duplicate keys
 * and integer precision). This module holds the three pieces that stop that:
 *
 *   1. `mysqlTypeCast` — the pool-level typeCast (BLOB/BINARY → Buffer,
 *      DECIMAL → string, JSON → raw text, BIT/GEOMETRY → Buffer).
 *   2. `encodeCell` / `encodeRow` — driver value + column metadata → wire `Cell`.
 *   3. `mysqlTypeDescriptor` — information_schema type text → canonical
 *      `TypeDescriptor` for the SchemaModel (PLAN §4).
 *
 * It also owns flavor detection: MySQL and MariaDB share one connector and
 * diverge on JSON, sequences, RETURNING and system versioning (PLAN §4).
 *
 * No React, no Next (PLAN §11).
 */

import type { FieldPacket, TypeCastField, TypeCastNext } from 'mysql2';
import type { BaseType, Cell, Row } from '../../../../lib/wire';
import { bytesCell, tag } from '../../../../lib/wire';
import type { TypeDescriptor } from '../../../../lib/schema-model';
import type { ColumnMeta } from '../../../../lib/results';

// ---------------------------------------------------------------------------
// Protocol constants (copied, not imported: mysql2 does not export its
// internal `lib/constants/*` through its package `exports` map).
// ---------------------------------------------------------------------------

export const MYSQL_TYPE = {
  DECIMAL: 0x00,
  TINY: 0x01,
  SHORT: 0x02,
  LONG: 0x03,
  FLOAT: 0x04,
  DOUBLE: 0x05,
  NULL: 0x06,
  TIMESTAMP: 0x07,
  LONGLONG: 0x08,
  INT24: 0x09,
  DATE: 0x0a,
  TIME: 0x0b,
  DATETIME: 0x0c,
  YEAR: 0x0d,
  NEWDATE: 0x0e,
  VARCHAR: 0x0f,
  BIT: 0x10,
  VECTOR: 0xf2,
  JSON: 0xf5,
  NEWDECIMAL: 0xf6,
  ENUM: 0xf7,
  SET: 0xf8,
  TINY_BLOB: 0xf9,
  MEDIUM_BLOB: 0xfa,
  LONG_BLOB: 0xfb,
  BLOB: 0xfc,
  VAR_STRING: 0xfd,
  STRING: 0xfe,
  GEOMETRY: 0xff,
} as const;

export const FIELD_FLAG = {
  NOT_NULL: 1,
  PRI_KEY: 2,
  UNIQUE_KEY: 4,
  MULTIPLE_KEY: 8,
  BLOB: 16,
  UNSIGNED: 32,
  ZEROFILL: 64,
  BINARY: 128,
  ENUM: 256,
  AUTO_INCREMENT: 512,
  TIMESTAMP: 1024,
  SET: 2048,
  NO_DEFAULT_VALUE: 4096,
  ON_UPDATE_NOW: 8192,
  NUM: 32768,
} as const;

/** charset id 63 is `binary`; it is the only way to tell BLOB from TEXT. */
export const BINARY_CHARSET = 63;

// ---------------------------------------------------------------------------
// Flavor (PLAN §4: "MySQL and MariaDB share one connector with a flavor flag")
// ---------------------------------------------------------------------------

export type MysqlFlavor = 'mysql' | 'mariadb';

export interface FlavorInfo {
  flavor: MysqlFlavor;
  /** Raw VERSION() output. */
  versionText: string;
  /** Numeric form: 8.0.18 → 80018, 10.6.12 → 100612. Compare with `>=`. */
  version: number;
  edition?: string;
  /** Native JSON column type (MySQL 5.7.8+). MariaDB fakes it with LONGTEXT. */
  supportsJsonType: boolean;
  /** information_schema.CHECK_CONSTRAINTS exists (MySQL 8.0.16+, MariaDB 10.2.22+). */
  supportsCheckConstraints: boolean;
  /** COLUMNS.GENERATION_EXPRESSION exists (MySQL 5.7+, MariaDB 10.2+). */
  supportsGeneratedColumns: boolean;
  /** STATISTICS.EXPRESSION exists — functional indexes (MySQL 8.0.13+ only). */
  supportsFunctionalIndexes: boolean;
  /** CREATE SEQUENCE (MariaDB 10.3+). */
  supportsSequences: boolean;
  /** INSERT … RETURNING (MariaDB 10.5+; DELETE … RETURNING since 10.0). */
  supportsReturning: boolean;
  /** WITH SYSTEM VERSIONING (MariaDB 10.3+). */
  supportsSystemVersioning: boolean;
  /** EXPLAIN ANALYZE (MySQL 8.0.18+). MariaDB uses ANALYZE FORMAT=JSON instead. */
  supportsExplainAnalyze: boolean;
  /** ANALYZE FORMAT=JSON with r_rows/r_total_time_ms (MariaDB 10.1+). */
  supportsAnalyzeJson: boolean;
  /** EXPLAIN FORMAT=JSON (MySQL 5.6+, MariaDB 10.1+). */
  supportsExplainJson: boolean;
  /** SET max_execution_time (MySQL 5.7.8+, milliseconds). */
  supportsMaxExecutionTime: boolean;
  /** SET max_statement_time (MariaDB 10.1+, seconds as a float). */
  supportsMaxStatementTime: boolean;
}

/**
 * MariaDB ≥10 reports itself as `5.5.5-10.x.y-MariaDB` on the wire so ancient
 * clients don't choke on the leading `10`; strip that prefix before parsing.
 */
export function detectFlavor(versionText: string, versionComment?: string, hint?: MysqlFlavor): FlavorInfo {
  const cleaned = versionText.replace(/^5\.5\.5-/, '');
  const isMaria =
    /mariadb/i.test(versionText) || /mariadb/i.test(versionComment ?? '') || hint === 'mariadb';
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  const major = m ? Number(m[1]) : isMaria ? 10 : 8;
  const minor = m ? Number(m[2]) : 0;
  const patch = m ? Number(m[3]) : 0;
  const version = major * 10000 + minor * 100 + patch;

  return {
    flavor: isMaria ? 'mariadb' : 'mysql',
    versionText: cleaned,
    version,
    edition: versionComment,
    supportsJsonType: !isMaria && version >= 50708,
    supportsCheckConstraints: isMaria ? version >= 100222 : version >= 80016,
    supportsGeneratedColumns: isMaria ? version >= 100200 : version >= 50700,
    supportsFunctionalIndexes: !isMaria && version >= 80013,
    supportsSequences: isMaria && version >= 100300,
    supportsReturning: isMaria && version >= 100500,
    supportsSystemVersioning: isMaria && version >= 100300,
    supportsExplainAnalyze: !isMaria && version >= 80018,
    supportsAnalyzeJson: isMaria && version >= 100100,
    supportsExplainJson: isMaria ? version >= 100100 : version >= 50600,
    supportsMaxExecutionTime: !isMaria && version >= 50708,
    supportsMaxStatementTime: isMaria && version >= 100100,
  };
}

// ---------------------------------------------------------------------------
// typeCast (PLAN §6): runs inside the row parser, once per value.
// ---------------------------------------------------------------------------

/**
 * The wrapper object mysql2 hands to `typeCast` exposes only
 * {type, extendedTypeName, extendedFormat, length, db, table, name} plus the
 * three readers — notably NOT the column charset. Exactly one reader may be
 * called per value (`string()`, `buffer()`, `geometry()` or `next()`).
 */
export function mysqlTypeCast(field: TypeCastField, next: TypeCastNext): unknown {
  // MariaDB sends JSON as LONGTEXT and only flags it in extended metadata.
  if (field.extendedFormat === 'json') return field.string('utf8');

  switch (field.type) {
    case 'DECIMAL':
    case 'NEWDECIMAL':
      // Lossless: 12345678901234567890.12 must not become a float.
      return field.string('ascii');
    case 'JSON':
      // Raw document text. Explicitly asking for utf8 also avoids the driver's
      // "JSON column interpreted as BINARY" warning (JSON always reports
      // charset 63 on the wire).
      return field.string('utf8');
    case 'BIT':
      // Raw bits; encodeCell renders them as a 0/1 string.
      return field.buffer();
    case 'GEOMETRY':
      // Keep SRID + WKB bytes. The driver's parsed {x, y} shape drops the SRID
      // and cannot represent every geometry type.
      return field.buffer();
    default:
      // TEXT/BLOB share type codes (TINY_BLOB…BLOB) and CHAR/BINARY share
      // STRING/VAR_STRING, so telling them apart needs the charset — which this
      // wrapper does not carry. mysql2's own reader does have it and returns a
      // Buffer exactly when the charset is binary (63) and a decoded string
      // otherwise, which is precisely the rule we want; the pool's
      // dateStrings/supportBigNumbers/bigNumberStrings settings also apply
      // inside next(). So delegate rather than guess.
      return next();
  }
}

// ---------------------------------------------------------------------------
// Column metadata
// ---------------------------------------------------------------------------

function fieldType(field: FieldPacket): number {
  return field.columnType ?? field.type ?? MYSQL_TYPE.NULL;
}

function fieldFlags(field: FieldPacket): number {
  const f = field.flags;
  return typeof f === 'number' ? f : 0;
}

function fieldCharset(field: FieldPacket): number {
  return field.characterSet ?? field.charsetNr ?? 0;
}

function isBinaryField(field: FieldPacket): boolean {
  return fieldCharset(field) === BINARY_CHARSET;
}

/** The engine's own spelling of a result column's type, for the grid header. */
export function typeNameForField(field: FieldPacket): string {
  const t = fieldType(field);
  const flags = fieldFlags(field);
  const bin = isBinaryField(field);
  const unsigned = (flags & FIELD_FLAG.UNSIGNED) !== 0 ? ' unsigned' : '';

  // MariaDB 10.5+ extended metadata names types the protocol cannot express.
  if (field.extendedFormat === 'json') return 'json';
  if (field.extendedTypeName) return field.extendedTypeName;

  switch (t) {
    case MYSQL_TYPE.TINY:
      return `tinyint${unsigned}`;
    case MYSQL_TYPE.SHORT:
      return `smallint${unsigned}`;
    case MYSQL_TYPE.INT24:
      return `mediumint${unsigned}`;
    case MYSQL_TYPE.LONG:
      return `int${unsigned}`;
    case MYSQL_TYPE.LONGLONG:
      return `bigint${unsigned}`;
    case MYSQL_TYPE.FLOAT:
      return `float${unsigned}`;
    case MYSQL_TYPE.DOUBLE:
      return `double${unsigned}`;
    case MYSQL_TYPE.DECIMAL:
    case MYSQL_TYPE.NEWDECIMAL:
      return `decimal${unsigned}`;
    case MYSQL_TYPE.DATE:
    case MYSQL_TYPE.NEWDATE:
      return 'date';
    case MYSQL_TYPE.DATETIME:
      return 'datetime';
    case MYSQL_TYPE.TIMESTAMP:
      return 'timestamp';
    case MYSQL_TYPE.TIME:
      return 'time';
    case MYSQL_TYPE.YEAR:
      return 'year';
    case MYSQL_TYPE.BIT:
      return 'bit';
    case MYSQL_TYPE.JSON:
      return 'json';
    case MYSQL_TYPE.ENUM:
      return 'enum';
    case MYSQL_TYPE.SET:
      return 'set';
    case MYSQL_TYPE.GEOMETRY:
      return 'geometry';
    case MYSQL_TYPE.VECTOR:
      return 'vector';
    case MYSQL_TYPE.TINY_BLOB:
      return bin ? 'tinyblob' : 'tinytext';
    case MYSQL_TYPE.MEDIUM_BLOB:
      return bin ? 'mediumblob' : 'mediumtext';
    case MYSQL_TYPE.LONG_BLOB:
      return bin ? 'longblob' : 'longtext';
    case MYSQL_TYPE.BLOB:
      return bin ? 'blob' : 'text';
    case MYSQL_TYPE.VAR_STRING:
    case MYSQL_TYPE.VARCHAR:
      return bin ? 'varbinary' : 'varchar';
    case MYSQL_TYPE.STRING:
      // ENUM/SET are sent as STRING with a flag on older servers.
      if ((flags & FIELD_FLAG.ENUM) !== 0) return 'enum';
      if ((flags & FIELD_FLAG.SET) !== 0) return 'set';
      return bin ? 'binary' : 'char';
    case MYSQL_TYPE.NULL:
      return 'null';
    default:
      return 'unknown';
  }
}

export function baseTypeForField(field: FieldPacket): BaseType {
  const t = fieldType(field);
  const flags = fieldFlags(field);
  const bin = isBinaryField(field);

  if (field.extendedFormat === 'json') return 'json';
  if (field.extendedTypeName === 'uuid') return 'uuid';
  if (field.extendedTypeName === 'inet4' || field.extendedTypeName === 'inet6') return 'network';

  switch (t) {
    case MYSQL_TYPE.TINY:
    case MYSQL_TYPE.SHORT:
    case MYSQL_TYPE.INT24:
    case MYSQL_TYPE.LONG:
    case MYSQL_TYPE.YEAR:
      return 'integer';
    case MYSQL_TYPE.LONGLONG:
      return 'bigint';
    case MYSQL_TYPE.FLOAT:
    case MYSQL_TYPE.DOUBLE:
      return 'float';
    case MYSQL_TYPE.DECIMAL:
    case MYSQL_TYPE.NEWDECIMAL:
      return 'decimal';
    case MYSQL_TYPE.DATE:
    case MYSQL_TYPE.NEWDATE:
      return 'date';
    case MYSQL_TYPE.DATETIME:
    case MYSQL_TYPE.TIMESTAMP:
      return 'timestamp';
    case MYSQL_TYPE.TIME:
      return 'time';
    case MYSQL_TYPE.BIT:
      return 'bit';
    case MYSQL_TYPE.JSON:
      return 'json';
    case MYSQL_TYPE.ENUM:
      return 'enum';
    case MYSQL_TYPE.SET:
      return 'set';
    case MYSQL_TYPE.GEOMETRY:
      return 'geometry';
    case MYSQL_TYPE.VECTOR:
      return 'array';
    case MYSQL_TYPE.TINY_BLOB:
    case MYSQL_TYPE.MEDIUM_BLOB:
    case MYSQL_TYPE.LONG_BLOB:
    case MYSQL_TYPE.BLOB:
      return bin ? 'binary' : 'text';
    case MYSQL_TYPE.VAR_STRING:
    case MYSQL_TYPE.VARCHAR:
      return bin ? 'binary' : 'string';
    case MYSQL_TYPE.STRING:
      if ((flags & FIELD_FLAG.ENUM) !== 0) return 'enum';
      if ((flags & FIELD_FLAG.SET) !== 0) return 'set';
      return bin ? 'binary' : 'string';
    default:
      return 'unknown';
  }
}

/**
 * Result-set column metadata. `orgTable`/`orgName` are the *source* table and
 * column (empty for expressions), which is what decides editability (PLAN §6).
 */
export function columnMetaForField(field: FieldPacket): ColumnMeta {
  const flags = fieldFlags(field);
  return {
    name: field.name,
    typeName: typeNameForField(field),
    base: baseTypeForField(field),
    nullable: (flags & FIELD_FLAG.NOT_NULL) === 0,
    table: field.orgTable || undefined,
    schema: field.schema || field.db || undefined,
    isKey: (flags & FIELD_FLAG.PRI_KEY) !== 0,
  };
}

export function columnMetaForFields(fields: FieldPacket[]): ColumnMeta[] {
  return fields.map(columnMetaForField);
}

// ---------------------------------------------------------------------------
// Value encoding (driver value + field → wire Cell)
// ---------------------------------------------------------------------------

/** BIT(n) arrives as raw bytes; render the exact bit string, big-endian. */
export function bufferToBitString(buf: Uint8Array, declaredBits?: number): string {
  let bits = '';
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
  const want = declaredBits && declaredBits > 0 && declaredBits <= bits.length ? declaredBits : undefined;
  return want === undefined ? bits.replace(/^0+(?=.)/, '') : bits.slice(bits.length - want);
}

function toHex(buf: Uint8Array): string {
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

/** MariaDB's native UUID type arrives as 16 raw bytes. */
function formatUuid(buf: Uint8Array): string {
  const h = toHex(buf);
  if (h.length !== 32) return h;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `Date` should never reach us (dateStrings is on), but be lossless if it does. */
function formatDate(d: Date, withTime: boolean): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const date = `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (!withTime) return date;
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function encodeCell(value: unknown, field: FieldPacket): Cell {
  if (value === null || value === undefined) return null;

  const t = fieldType(field);

  if (field.extendedTypeName === 'uuid') {
    return tag('uuid', value instanceof Uint8Array ? formatUuid(value) : String(value));
  }
  if (field.extendedFormat === 'json') {
    return tag('json', typeof value === 'string' ? value : JSON.stringify(value));
  }

  if (value instanceof Uint8Array) {
    if (t === MYSQL_TYPE.BIT) return tag('bit', bufferToBitString(value, field.columnLength));
    if (t === MYSQL_TYPE.GEOMETRY) return tag('geo', toHex(value), 'wkb');
    return bytesCell(value);
  }

  if (typeof value === 'bigint') return tag('bigint', value.toString());

  if (value instanceof Date) {
    if (t === MYSQL_TYPE.DATE || t === MYSQL_TYPE.NEWDATE) return tag('date', formatDate(value, false));
    return tag('timestamp', formatDate(value, true));
  }

  switch (t) {
    case MYSQL_TYPE.LONGLONG:
      // bigNumberStrings keeps these exact; never hand the UI a rounded number.
      return tag('bigint', String(value));
    case MYSQL_TYPE.DECIMAL:
    case MYSQL_TYPE.NEWDECIMAL:
      return tag('decimal', String(value));
    case MYSQL_TYPE.DATE:
    case MYSQL_TYPE.NEWDATE:
      return tag('date', String(value));
    case MYSQL_TYPE.DATETIME:
    case MYSQL_TYPE.TIMESTAMP:
      // MySQL stores no zone; TIMESTAMP is converted to the session tz by the
      // server, so the plain string is the honest value.
      return tag('timestamp', String(value));
    case MYSQL_TYPE.TIME:
      // TIME is a signed interval (-838:59:59 … 838:59:59), not a clock time.
      return tag('time', String(value));
    case MYSQL_TYPE.JSON:
      return tag('json', typeof value === 'string' ? value : JSON.stringify(value));
    case MYSQL_TYPE.BIT:
      return tag('bit', String(value));
    default:
      break;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Float32Array || value instanceof Float64Array) {
    return tag('array', JSON.stringify(Array.from(value)), 'float');
  }
  if (Array.isArray(value)) return tag('array', JSON.stringify(value));

  if (t === MYSQL_TYPE.GEOMETRY) return tag('geo', JSON.stringify(value));

  return tag('unsupported', String(value), typeNameForField(field));
}

/** Rows arrive as arrays because every query sets `rowsAsArray` (duplicate column names). */
export function encodeRow(row: unknown[], fields: FieldPacket[]): Row {
  const out: Row = new Array(fields.length);
  for (let i = 0; i < fields.length; i++) out[i] = encodeCell(row[i], fields[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Wire Cell → driver parameter (grid edits, filters — PLAN §6/§9: everything
// the user did not type is parameterized)
// ---------------------------------------------------------------------------

export function cellToParam(cell: Cell): unknown {
  if (cell === null) return null;
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return cell;
  switch (cell.$t) {
    case 'bytes':
      return Buffer.from(cell.v, 'base64');
    case 'bit': {
      // Bit string → bytes, so the server sees the same value it sent us.
      const bits = cell.v.replace(/[^01]/g, '');
      const padded = bits.padStart(Math.ceil(bits.length / 8) * 8, '0');
      const bytes = Buffer.alloc(padded.length / 8);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(padded.slice(i * 8, i * 8 + 8), 2);
      }
      return bytes;
    }
    default:
      // bigint / decimal / date / time / timestamp / json / uuid / geo: the
      // lossless string is exactly what MySQL parses back.
      return cell.v;
  }
}

// ---------------------------------------------------------------------------
// information_schema type text → canonical TypeDescriptor (PLAN §4)
// ---------------------------------------------------------------------------

const BASE_BY_DATA_TYPE: Record<string, BaseType> = {
  tinyint: 'integer',
  smallint: 'integer',
  mediumint: 'integer',
  int: 'integer',
  integer: 'integer',
  year: 'integer',
  bigint: 'bigint',
  decimal: 'decimal',
  numeric: 'decimal',
  fixed: 'decimal',
  float: 'float',
  double: 'float',
  'double precision': 'float',
  real: 'float',
  bit: 'bit',
  char: 'string',
  varchar: 'string',
  binary: 'binary',
  varbinary: 'binary',
  tinytext: 'text',
  text: 'text',
  mediumtext: 'text',
  longtext: 'text',
  tinyblob: 'binary',
  blob: 'binary',
  mediumblob: 'binary',
  longblob: 'binary',
  enum: 'enum',
  set: 'set',
  date: 'date',
  datetime: 'timestamp',
  timestamp: 'timestamp',
  time: 'time',
  json: 'json',
  uuid: 'uuid',
  inet4: 'network',
  inet6: 'network',
  vector: 'array',
  geometry: 'geometry',
  point: 'geometry',
  linestring: 'geometry',
  polygon: 'geometry',
  multipoint: 'geometry',
  multilinestring: 'geometry',
  multipolygon: 'geometry',
  geometrycollection: 'geometry',
  geomcollection: 'geometry',
};

/** `enum('a','b''c')` → ['a', "b'c"]. Handles doubled quotes and backslashes. */
export function parseEnumValues(columnType: string): string[] {
  const open = columnType.indexOf('(');
  const close = columnType.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const body = columnType.slice(open + 1, close);
  const values: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (!inQuote) {
      if (ch === "'") inQuote = true;
      continue;
    }
    if (ch === '\\' && i + 1 < body.length) {
      const next = body[i + 1];
      cur += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      i++;
      continue;
    }
    if (ch === "'") {
      if (body[i + 1] === "'") {
        cur += "'";
        i++;
        continue;
      }
      values.push(cur);
      cur = '';
      inQuote = false;
      continue;
    }
    cur += ch;
  }
  return values;
}

export interface IsColumnTypeInput {
  dataType: string;
  /** COLUMN_TYPE, e.g. `int(10) unsigned`, `enum('a','b')`, `decimal(10,2)`. */
  columnType: string;
  charMaxLength?: number | null;
  numericPrecision?: number | null;
  numericScale?: number | null;
  datetimePrecision?: number | null;
}

export function mysqlTypeDescriptor(input: IsColumnTypeInput): TypeDescriptor {
  const dataType = (input.dataType || '').toLowerCase();
  const columnType = input.columnType || dataType;
  const lower = columnType.toLowerCase();
  const base = BASE_BY_DATA_TYPE[dataType] ?? 'unknown';

  const desc: TypeDescriptor = { raw: columnType, base };

  if (lower.includes('unsigned')) desc.unsigned = true;
  if (base === 'enum' || base === 'set') desc.values = parseEnumValues(columnType);

  if (input.charMaxLength !== null && input.charMaxLength !== undefined) {
    desc.length = Number(input.charMaxLength);
  }
  if (input.numericPrecision !== null && input.numericPrecision !== undefined) {
    desc.precision = Number(input.numericPrecision);
  }
  if (input.numericScale !== null && input.numericScale !== undefined) {
    desc.scale = Number(input.numericScale);
  }
  if (
    (base === 'timestamp' || base === 'time') &&
    input.datetimePrecision !== null &&
    input.datetimePrecision !== undefined
  ) {
    desc.precision = Number(input.datetimePrecision);
  }
  if (desc.length === undefined && base === 'bit') {
    const m = /\((\d+)\)/.exec(columnType);
    if (m) desc.length = Number(m[1]);
  }
  // TIMESTAMP is the only MySQL type with timezone semantics: it is stored as
  // UTC and converted to the session time zone on the way out.
  if (dataType === 'timestamp') desc.withTimezone = true;

  return desc;
}

/** MariaDB has no JSON type: it is LONGTEXT plus a `json_valid()` CHECK (PLAN §4). */
export function isMariaJsonCheck(expression: string): string | null {
  const m = /^\s*json_valid\s*\(\s*`([^`]+)`\s*\)\s*$/i.exec(expression);
  return m ? m[1] : null;
}
