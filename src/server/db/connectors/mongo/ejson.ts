/**
 * BSON ⇄ wire-format conversion for MongoDB (PLAN §6 "Type fidelity").
 *
 * PLAN §6 says: *"For Mongo, serialize with Extended JSON (`bson`'s `EJSON`) so
 * ObjectId/Decimal128/Date survive the trip."* This module is that rule made
 * concrete, in both directions:
 *
 *   BSON  ──cellFromBson──▶  Cell   (grid / doc viewer)
 *   Cell  ──bsonFromCell──▶  BSON   (edits, filters, ids)
 *
 * The round trip must be LOSSLESS, which drives three decisions:
 *
 *  1. A plain JSON scalar is only ever used when re-encoding it reproduces the
 *     *same* BSON type. A BSON `Double` holding `5.0` therefore does NOT become
 *     the JSON number `5` — the driver would write that back as an `Int32`. It
 *     becomes a tagged cell instead. Non-integral doubles are safe as numbers,
 *     because the driver re-encodes those as doubles.
 *  2. Every tagged cell carries a *human* lossless text in `v` (hex for
 *     ObjectId, `12.34` for Decimal128, ISO-8601 for Date) rather than raw
 *     Extended JSON, so `cellToDisplay()` in wire.ts renders something a person
 *     can read. `of` carries the BSON type alias (`objectId`, `decimal`,
 *     `binData`, …), which is what the decoder discriminates on and what the UI
 *     shows as the type label.
 *  3. Nested documents and arrays keep their canonical (`relaxed: false`)
 *     Extended JSON text in `v`, which the document viewer expands and which
 *     `EJSON.parse` turns back into exactly the same BSON.
 *
 * Type detection uses the `_bsontype` discriminator rather than `instanceof`,
 * because the driver bundles its own copy of `bson`: two copies of `ObjectId`
 * fail `instanceof` but agree on `_bsontype`, and the serializer itself
 * switches on that string.
 *
 * Server-only module: no React, no Next imports (PLAN §11).
 */

import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  Decimal128,
  Double,
  EJSON,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  type Document,
} from 'bson';

import type { ColumnMeta } from '../../../../lib/results';
import {
  base64ToBytes,
  bytesCell,
  isTagged,
  tag,
  type BaseType,
  type Cell,
  type Row,
  type TaggedCell,
} from '../../../../lib/wire';
import { DbError } from '../../types';

// ---------------------------------------------------------------------------
// BSON type aliases (the names `$type` uses, and what we put in `of`)
// ---------------------------------------------------------------------------

export type BsonTypeAlias =
  | 'double'
  | 'string'
  | 'object'
  | 'array'
  | 'binData'
  | 'uuid'
  | 'undefined'
  | 'objectId'
  | 'bool'
  | 'date'
  | 'null'
  | 'regex'
  | 'dbPointer'
  | 'javascript'
  | 'javascriptWithScope'
  | 'symbol'
  | 'int'
  | 'timestamp'
  | 'long'
  | 'decimal'
  | 'minKey'
  | 'maxKey'
  | 'dbRef'
  | 'missing';

/** Read the BSON discriminator without `instanceof` (see the module header). */
function bsonTypeOf(value: object): string | undefined {
  const t = (value as { _bsontype?: unknown })._bsontype;
  return typeof t === 'string' ? t : undefined;
}

function isDate(value: object): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function isNativeRegExp(value: object): value is RegExp {
  return Object.prototype.toString.call(value) === '[object RegExp]';
}

/** The `$type` alias for a value, used for `of`, ColumnMeta.typeName and the tree. */
export function bsonTypeName(value: unknown): BsonTypeAlias {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'boolean':
      return 'bool';
    case 'string':
      return 'string';
    case 'bigint':
      return 'long';
    case 'number':
      return Number.isSafeInteger(value) && inInt32Range(value) && !Object.is(value, -0) ? 'int' : 'double';
    case 'function':
      return 'javascript';
    default:
      break;
  }
  const obj = value as object;
  if (Array.isArray(obj)) return 'array';
  if (isDate(obj)) return 'date';
  if (isNativeRegExp(obj)) return 'regex';

  switch (bsonTypeOf(obj)) {
    case 'ObjectId':
      return 'objectId';
    case 'Decimal128':
      return 'decimal';
    case 'Long':
      return 'long';
    case 'Int32':
      return 'int';
    case 'Double':
      return 'double';
    case 'Timestamp':
      return 'timestamp';
    case 'Binary':
      return (obj as Binary).sub_type === Binary.SUBTYPE_UUID ? 'uuid' : 'binData';
    case 'BSONRegExp':
      return 'regex';
    case 'Code':
      return (obj as Code).scope ? 'javascriptWithScope' : 'javascript';
    case 'BSONSymbol':
      return 'symbol';
    case 'DBRef':
      return 'dbRef';
    case 'MinKey':
      return 'minKey';
    case 'MaxKey':
      return 'maxKey';
    default:
      return 'object';
  }
}

/** Normalized family for ColumnMeta.base — the grid renders from this (PLAN §4). */
export function baseTypeForBson(alias: BsonTypeAlias): BaseType {
  switch (alias) {
    case 'objectId':
      return 'objectid';
    case 'decimal':
      return 'decimal';
    case 'long':
      return 'bigint';
    case 'int':
      return 'integer';
    case 'double':
      return 'float';
    case 'bool':
      return 'boolean';
    case 'date':
    case 'timestamp':
      return 'timestamp';
    case 'binData':
      return 'binary';
    case 'uuid':
      return 'uuid';
    case 'object':
    case 'dbRef':
      return 'document';
    case 'array':
      return 'array';
    case 'string':
    case 'symbol':
    case 'regex':
      return 'string';
    case 'javascript':
    case 'javascriptWithScope':
      return 'text';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Extended JSON text
// ---------------------------------------------------------------------------

export interface EjsonTextOpts {
  /** Relaxed mode is for display/raw dumps; canonical (the default) is lossless. */
  relaxed?: boolean;
  /** Indent width; omitted means compact, which is what grid cells want. */
  indent?: number;
}

export function ejsonText(value: unknown, opts: EjsonTextOpts = {}): string {
  return EJSON.stringify(value, { relaxed: opts.relaxed ?? false }, opts.indent);
}

/** Parse Extended JSON text into BSON. Canonical by default, so `$oid` etc. survive. */
export function ejsonParse(text: string, relaxed = false): unknown {
  try {
    return EJSON.parse(text, { relaxed });
  } catch (err) {
    throw new DbError(`Invalid Extended JSON: ${(err as Error).message}`, 'BAD_EJSON');
  }
}

// ---------------------------------------------------------------------------
// BSON → Cell
// ---------------------------------------------------------------------------

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function inInt32Range(n: number): boolean {
  return n >= INT32_MIN && n <= INT32_MAX;
}

/**
 * True when the driver would re-encode this JS number as an Int32 — which is
 * exactly when a plain JSON number is NOT a faithful carrier for a Double.
 */
function reEncodesAsInt32(n: number): boolean {
  return Number.isSafeInteger(n) && inInt32Range(n) && !Object.is(n, -0);
}

function doubleText(n: number): string {
  if (Object.is(n, -0)) return '-0';
  return String(n); // 'NaN' | 'Infinity' | '-Infinity' | '1.5' … all survive Number()
}

/**
 * A field that is *absent* from this document, which Mongo treats differently
 * from a field explicitly set to `null`. The grid needs both, and `Cell` has no
 * third empty state, so absence gets an `unsupported` tag whose `of` makes
 * `cellToDisplay()` render `<missing>`.
 */
export function missingCell(): TaggedCell {
  return tag('unsupported', '', 'missing');
}

export function isMissingCell(cell: Cell): boolean {
  return isTagged(cell) && cell.$t === 'unsupported' && cell.of === 'missing';
}

/** Format 16 raw bytes as a canonical dashed UUID. */
function uuidText(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function dateText(d: Date): string {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return '@NaN';
  try {
    return d.toISOString();
  } catch {
    // Outside the ISO range; keep the epoch so the decode is still exact.
    return `@${ms}`;
  }
}

/** One BSON value → one wire Cell. */
export function cellFromBson(value: unknown): Cell {
  if (value === null) return null;
  if (value === undefined) return tag('unsupported', 'undefined', 'undefined');

  switch (typeof value) {
    case 'boolean':
      return value;
    case 'string':
      return value;
    case 'bigint':
      // useBigInt64 turns int64s into bigints; JSON cannot carry those.
      return tag('bigint', value.toString(), 'long');
    case 'number':
      // A promoted JS number: only NaN/±Infinity need rescuing from JSON.
      return Number.isFinite(value) ? value : tag('decimal', doubleText(value), 'double');
    case 'function':
      return tag('json', String(value), 'javascript');
    default:
      break;
  }

  const obj = value as object;
  if (Array.isArray(obj)) return tag('array', ejsonText(obj), 'array');
  if (isDate(obj)) return tag('timestamp', dateText(obj), 'date');
  if (isNativeRegExp(obj)) return tag('regex', `/${obj.source}/${obj.flags}`, 'regex');

  switch (bsonTypeOf(obj)) {
    case 'ObjectId':
      return tag('objectid', (obj as ObjectId).toHexString(), 'objectId');

    case 'Int32':
      // Always inside the int32 range, so the driver re-encodes it as Int32.
      return (obj as { value: number }).value;

    case 'Double': {
      const n = (obj as { value: number }).value;
      return Number.isFinite(n) && !reEncodesAsInt32(n) ? n : tag('decimal', doubleText(n), 'double');
    }

    case 'Long':
      return tag('bigint', (obj as Long).toString(), 'long');

    case 'Decimal128':
      return tag('decimal128', (obj as Decimal128).toString(), 'decimal');

    case 'Timestamp': {
      // The replication timestamp, NOT a datetime: it is a (seconds, counter)
      // pair and both halves have to survive.
      const ts = obj as Timestamp;
      return tag('timestamp', `${ts.t},${ts.i}`, 'timestamp');
    }

    case 'Binary': {
      const bin = obj as Binary;
      const bytes = bin.value();
      if (bin.sub_type === Binary.SUBTYPE_UUID) return tag('uuid', uuidText(bytes), 'uuid');
      const cell = bytesCell(bytes);
      return bin.sub_type === Binary.SUBTYPE_DEFAULT ? cell : tag('bytes', cell.v, `binData:${bin.sub_type}`);
    }

    case 'BSONRegExp': {
      const re = obj as BSONRegExp;
      return tag('regex', `/${re.pattern}/${re.options}`, 'regex');
    }

    case 'Code': {
      const code = obj as Code;
      // Scoped code needs its scope document too, so it keeps full EJSON.
      if (code.scope) return tag('json', ejsonText(code), 'javascriptWithScope');
      return tag('json', code.code, 'javascript');
    }

    case 'BSONSymbol':
      return tag('json', (obj as BSONSymbol).value, 'symbol');

    case 'DBRef':
      return tag('document', ejsonText(obj), 'dbRef');

    case 'MinKey':
      return tag('json', 'MinKey', 'minKey');

    case 'MaxKey':
      return tag('json', 'MaxKey', 'maxKey');

    default:
      // A plain sub-document: canonical EJSON so the viewer can expand it and
      // the decode below is exact.
      return tag('document', ejsonText(obj), 'object');
  }
}

// ---------------------------------------------------------------------------
// Cell → BSON
// ---------------------------------------------------------------------------

const REGEX_CELL = /^\/([\s\S]*)\/([a-z]*)$/;

/** One wire Cell → the BSON value it came from. Inverse of {@link cellFromBson}. */
export function bsonFromCell(cell: Cell): unknown {
  if (cell === null) return null;
  if (typeof cell !== 'object') return cell; // string | number | boolean pass straight through

  const { $t, v, of } = cell;

  switch (of) {
    case 'missing':
      return undefined; // callers drop the key entirely
    case 'undefined':
      return undefined;
    case 'minKey':
      return new MinKey();
    case 'maxKey':
      return new MaxKey();
    case 'symbol':
      return new BSONSymbol(v);
    case 'javascript':
      return new Code(v);
    case 'javascriptWithScope':
      return ejsonParse(v);
    case 'double':
      return new Double(Number(v));
    case 'long':
      return Long.fromString(v);
    case 'timestamp': {
      const [t, i] = v.split(',');
      return new Timestamp({ t: Number(t) || 0, i: Number(i) || 0 });
    }
    case 'date':
      return decodeDate(v);
    case 'uuid':
      return Binary.createFromHexString(v.replace(/-/g, ''), Binary.SUBTYPE_UUID);
    case 'dbRef':
    case 'object':
    case 'array':
      return ejsonParse(v);
    default:
      break;
  }

  if (of && of.startsWith('binData:')) {
    return new Binary(base64ToBytes(v), Number(of.slice('binData:'.length)) || 0);
  }

  // No `of`, or an `of` we do not own: fall back on the tag itself.
  switch ($t) {
    case 'objectid':
      return new ObjectId(v);
    case 'decimal128':
    case 'decimal':
      return Decimal128.fromString(v);
    case 'bigint':
      return Long.fromString(v);
    case 'bytes':
      return new Binary(base64ToBytes(v), Binary.SUBTYPE_DEFAULT);
    case 'uuid':
      return Binary.createFromHexString(v.replace(/-/g, ''), Binary.SUBTYPE_UUID);
    case 'timestamp':
    case 'timestamptz':
    case 'date':
      return decodeDate(v);
    case 'regex': {
      const m = REGEX_CELL.exec(v);
      return m ? new BSONRegExp(m[1], m[2]) : new BSONRegExp(v, '');
    }
    case 'json':
    case 'document':
    case 'array':
      return ejsonParse(v);
    default:
      return v;
  }
}

function decodeDate(v: string): Date {
  if (v.startsWith('@')) return new Date(Number(v.slice(1)));
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new DbError(`Not a date: ${v}`, 'BAD_VALUE');
  return new Date(ms);
}

// ---------------------------------------------------------------------------
// Loose input → BSON
// ---------------------------------------------------------------------------

/**
 * Extended JSON tokens we are willing to decode. Restricting to this set is
 * what keeps a *query operator* like `{ $gt: 5 }` from being mistaken for a
 * type token.
 */
const EJSON_TOKENS = new Set([
  '$oid',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$date',
  '$timestamp',
  '$regularExpression',
  '$code',
  '$symbol',
  '$minKey',
  '$maxKey',
  '$undefined',
  '$dbPointer',
  '$ref',
]);

function isEjsonToken(value: object): boolean {
  for (const key of Object.keys(value)) {
    if (EJSON_TOKENS.has(key)) return true;
  }
  return false;
}

/**
 * Normalize whatever the HTTP layer handed us into real BSON. Accepts, at any
 * depth: wire `Cell`s from the grid, Extended JSON tokens, plain JSON, and BSON
 * values that are already correct. This is the single entry point for filters,
 * documents, pipelines and ids so an edit made in the grid round-trips into the
 * same BSON it was read from.
 */
export function toBsonValue(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;

  const obj = input as object;
  if (bsonTypeOf(obj) !== undefined || isDate(obj) || isNativeRegExp(obj)) return obj;
  if (Array.isArray(obj)) return obj.map(toBsonValue);
  if (isTagged(obj as Cell)) return bsonFromCell(obj as TaggedCell);
  if (isEjsonToken(obj)) return EJSON.deserialize(obj as Document, { relaxed: false });

  const out: Document = {};
  for (const [key, value] of Object.entries(obj)) {
    const converted = toBsonValue(value);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
}

/** A filter / document, accepting either an object or Extended JSON text. */
export function toBsonDocument(input: unknown, label = 'document'): Document {
  if (input === null || input === undefined) return {};
  if (typeof input === 'string') {
    const text = input.trim();
    if (text === '') return {};
    const parsed = ejsonParse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DbError(`The ${label} must be a JSON object, got: ${text.slice(0, 80)}`, 'BAD_DOCUMENT');
    }
    return parsed as Document;
  }
  const value = toBsonValue(input);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DbError(`The ${label} must be a JSON object.`, 'BAD_DOCUMENT');
  }
  return value as Document;
}

/** An aggregation pipeline, accepting either an array or Extended JSON text. */
export function toBsonPipeline(input: unknown): Document[] {
  const value = typeof input === 'string' ? ejsonParse(input.trim() || '[]') : toBsonValue(input);
  if (!Array.isArray(value)) throw new DbError('The pipeline must be a JSON array of stages.', 'BAD_PIPELINE');
  return value.map((stage, i) => {
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new DbError(`Pipeline stage ${i + 1} must be a JSON object.`, 'BAD_PIPELINE');
    }
    return stage as Document;
  });
}

/**
 * A number out of anything BSON might hand back. With `promoteValues: false`
 * every server counter arrives as an Int32/Double/Long wrapper, so command
 * results and explain output must be read through this rather than `Number()`.
 */
export function numberOf(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof value !== 'object') return undefined;

  const type = bsonTypeOf(value);
  if (type === 'Int32' || type === 'Double') return numberOf((value as { value: number }).value);
  if (type === 'Long' || type === 'Decimal128') return numberOf(String(value));
  if (isDate(value)) return value.getTime();
  return undefined;
}

// ---------------------------------------------------------------------------
// Documents ⇄ grid rows (PLAN §6 "Big results" / the Mongo grid)
// ---------------------------------------------------------------------------

export interface FlatPage {
  columns: ColumnMeta[];
  rows: Row[];
}

export interface FlattenTarget {
  database?: string;
  collection?: string;
}

/**
 * Flatten a page of documents into grid columns.
 *
 * Mongo has no schema, so the columns are the *union of top-level keys across
 * this page*, in a stable order: `_id` first (it is the key the grid edits on),
 * then first-seen order. Nested values stay whole inside `document` / `array`
 * cells carrying their Extended JSON, which is what the document viewer
 * expands — we deliberately do not explode `a.b.c` into columns, because that
 * would make a heterogeneous collection unreadable and un-editable.
 */
export function flattenDocuments(docs: Document[], target: FlattenTarget = {}): FlatPage {
  const names: string[] = [];
  const seen = new Set<string>();
  // `_id` leads even when a document lists it later.
  for (const doc of docs) {
    if (doc && Object.prototype.hasOwnProperty.call(doc, '_id')) {
      names.push('_id');
      seen.add('_id');
      break;
    }
  }
  for (const doc of docs) {
    if (!doc) continue;
    for (const key of Object.keys(doc)) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }

  const types = new Map<string, Set<BsonTypeAlias>>(
    names.map((n): [string, Set<BsonTypeAlias>] => [n, new Set<BsonTypeAlias>()]),
  );
  const nullable = new Set<string>();

  const rows: Row[] = docs.map((doc) => {
    const row: Row = new Array(names.length);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!doc || !Object.prototype.hasOwnProperty.call(doc, name)) {
        row[i] = missingCell();
        nullable.add(name);
        continue;
      }
      const value = doc[name];
      row[i] = cellFromBson(value);
      const alias = bsonTypeName(value);
      if (alias === 'null' || alias === 'undefined') nullable.add(name);
      else types.get(name)?.add(alias);
    }
    return row;
  });

  const columns: ColumnMeta[] = names.map((name) => {
    const observed = [...(types.get(name) ?? [])];
    const meta: ColumnMeta = {
      name,
      typeName: observed.length === 0 ? 'null' : observed.join(' | '),
      base: observed.length === 1 ? baseTypeForBson(observed[0]) : 'unknown',
      nullable: nullable.has(name),
      // A single collection genuinely holds different types in the same field,
      // exactly like SQLite's dynamic typing (PLAN §6) — the grid renders per
      // cell, not per column.
      dynamicType: observed.length > 1,
    };
    if (target.collection) meta.table = target.collection;
    if (target.database) meta.schema = target.database;
    if (name === '_id') meta.isKey = true;
    return meta;
  });

  return { columns, rows };
}

/**
 * Rebuild a document from an edited grid row. Cells marked `<missing>` are
 * dropped rather than written as `null`, because "field absent" and "field is
 * null" are different documents to Mongo and to every query written against it.
 */
export function documentFromRow(columns: readonly string[], row: Row): Document {
  const doc: Document = {};
  const width = Math.min(columns.length, row.length);
  for (let i = 0; i < width; i++) {
    const cell = row[i];
    if (isMissingCell(cell)) continue;
    const value = bsonFromCell(cell);
    if (value === undefined) continue;
    doc[columns[i]] = value;
  }
  return doc;
}
