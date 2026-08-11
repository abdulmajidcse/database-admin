/**
 * CSV sniffing, preview and streaming read (PLAN §7.4 "CSV import wizard":
 * sniff delimiter, encoding and BOM; detect header row; preview 50 rows;
 * per-column mapping to target columns with type coercion and an explicit date
 * format; NULL-literal and trim settings).
 *
 * Three jobs, one file:
 *   1. `sniff()`  — guess the dialect from a head sample, cheaply and honestly.
 *   2. `previewCsv()` — the wizard's first screen: headers + the first N rows.
 *   3. `readCsvRows()` — the import itself: a backpressured stream of already
 *      coerced `Row` batches, never materializing the file (PLAN §7.4 pipeline).
 *
 * Coercion produces the §6 wire format, not driver values: a BIGINT stays a
 * lossless string in a tagged cell and only the writer decides how to bind it.
 * That is what keeps "CSV → MySQL" and "CSV → Postgres" from each inventing
 * their own truncation rules.
 *
 * Server-side only: no React, no Next (PLAN §11).
 */

import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import type { Options as CsvParseOptions } from 'csv-parse';

import type { BaseType, Cell, Row } from '../../../lib/wire';
import { bytesCell, tag } from '../../../lib/wire';
import type { ColumnMapping } from '../../../lib/api-types';

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

/**
 * Encodings we decode ourselves. UTF-16BE has no Node encoding name, so it is
 * byte-swapped into UTF-16LE on the way in (see `decodeStream`).
 */
export type CsvEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'latin1';

export interface CsvDialect {
  /** One character. Tab is '\t'. */
  delimiter: string;
  /** Field quote character; '"' unless the file clearly uses something else. */
  quote: string;
  /** Escape character inside quotes. Equal to `quote` for the doubling form. */
  escape: string;
  encoding: CsvEncoding;
  /** True when the file starts with a byte-order mark. */
  bom: boolean;
  /** Bytes to skip at the head of the file; 0 when there is no BOM. */
  bomBytes: number;
  /** Whether row 1 holds column names. */
  hasHeader: boolean;
  /** Line comment character, or null. Rare in CSV, common in hand-made exports. */
  comment: string | null;
  /** File-wide NULL literal; a column mapping may override it. */
  nullLiteral: string;
  /** Trim surrounding whitespace off unquoted fields. */
  trim: boolean;
  /** Tolerate a stray quote inside an unquoted field instead of failing. */
  relaxQuotes: boolean;
  /** 0..1 confidence in the delimiter guess — shown in the wizard, never load-bearing. */
  confidence: number;
}

/** Everything the sniffer needs to see; 256 KiB covers any realistic header block. */
export const SNIFF_BYTES = 256 * 1024;

/** PLAN §7.4: "preview 50 rows". */
export const PREVIEW_ROWS = 50;

/** Ordered by likelihood; the last is the ASCII unit separator some exports use. */
const DELIMITER_CANDIDATES = [',', ';', '\t', '|', ':', '\u001f'];
const QUOTE_CANDIDATES = ['"', "'"];

export function defaultDialect(): CsvDialect {
  return {
    delimiter: ',',
    quote: '"',
    escape: '"',
    encoding: 'utf8',
    bom: false,
    bomBytes: 0,
    hasHeader: true,
    comment: null,
    nullLiteral: '',
    trim: false,
    relaxQuotes: false,
    confidence: 0,
  };
}

// ---------------------------------------------------------------------------
// Encoding / BOM
// ---------------------------------------------------------------------------

interface EncodingGuess {
  encoding: CsvEncoding;
  bom: boolean;
  bomBytes: number;
}

/**
 * BOM first, heuristics second. A UTF-16 file read as UTF-8 turns every second
 * character into a NUL and the whole import silently becomes garbage, so this
 * check runs before anything else touches the bytes.
 */
export function detectEncoding(sample: Buffer): EncodingGuess {
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return { encoding: 'utf8', bom: true, bomBytes: 3 };
  }
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return { encoding: 'utf16le', bom: true, bomBytes: 2 };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return { encoding: 'utf16be', bom: true, bomBytes: 2 };
  }

  // No BOM: NUL bytes at alternating offsets are the giveaway for UTF-16, and
  // no text file in a single-byte encoding contains NUL at all.
  const scan = sample.subarray(0, Math.min(sample.length, 4096));
  let nulEven = 0;
  let nulOdd = 0;
  for (let i = 0; i < scan.length; i++) {
    if (scan[i] === 0) {
      if (i % 2 === 0) nulEven++;
      else nulOdd++;
    }
  }
  if (nulOdd > scan.length / 8 && nulOdd > nulEven * 4) {
    return { encoding: 'utf16le', bom: false, bomBytes: 0 };
  }
  if (nulEven > scan.length / 8 && nulEven > nulOdd * 4) {
    return { encoding: 'utf16be', bom: false, bomBytes: 0 };
  }

  // Validate as UTF-8, ignoring a multi-byte sequence cut off by the sample
  // boundary — that is a truncation artefact, not a decoding failure.
  const trimmed = sample.subarray(0, Math.max(0, sample.length - 4));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(trimmed);
    return { encoding: 'utf8', bom: false, bomBytes: 0 };
  } catch {
    // Latin-1 is the lossless fallback: every byte maps to a code point, so the
    // user can still see the data and pick a better encoding in the wizard.
    return { encoding: 'latin1', bom: false, bomBytes: 0 };
  }
}

function swapPairs(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length - (buf.length % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
}

function decodeBuffer(buf: Buffer, encoding: CsvEncoding): string {
  if (encoding === 'utf16be') return swapPairs(buf).toString('utf16le');
  return buf.toString(encoding);
}

/**
 * Byte stream → string stream. csv-parse can decode by itself, but doing it
 * here keeps UTF-16BE (which Node cannot name) and odd chunk boundaries in one
 * place; `StringDecoder` holds back a split multi-byte character.
 */
function decodeStream(encoding: CsvEncoding): Transform {
  const decoder = new StringDecoder(encoding === 'utf16be' ? 'utf16le' : encoding);
  let odd: Buffer | null = null;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      let buf = chunk;
      if (encoding === 'utf16be') {
        if (odd) {
          buf = Buffer.concat([odd, buf]);
          odd = null;
        }
        if (buf.length % 2 === 1) {
          odd = Buffer.from(buf.subarray(buf.length - 1));
          buf = buf.subarray(0, buf.length - 1);
        }
        buf = swapPairs(buf);
      }
      cb(null, decoder.write(buf));
    },
    flush(cb) {
      cb(null, decoder.end());
    },
  });
}

// ---------------------------------------------------------------------------
// A tiny CSV scanner, used only by the sniffer
// ---------------------------------------------------------------------------

/**
 * Parses at most `maxRecords` records under a *candidate* dialect. The sniffer
 * needs to try several dialects on the same sample, and spinning up csv-parse
 * (plus its error handling) for each one is both slower and noisier than this.
 * The last record is potentially truncated by the sample boundary; callers drop it.
 */
function scanRecords(
  text: string,
  delimiter: string,
  quote: string,
  escape: string,
  maxRecords: number,
): string[][] {
  const out: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  let i = 0;

  const endField = (): void => {
    record.push(field);
    field = '';
    started = false;
  };
  const endRecord = (): void => {
    endField();
    out.push(record);
    record = [];
  };

  while (i < text.length && out.length < maxRecords) {
    const c = text.charAt(i);
    if (quoted) {
      if (escape !== quote && c === escape && i + 1 < text.length) {
        field += text.charAt(i + 1);
        i += 2;
        continue;
      }
      if (c === quote) {
        if (text.charAt(i + 1) === quote) {
          field += quote;
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === quote && !started) {
      quoted = true;
      started = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      endField();
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text.charAt(i + 1) === '\n') i++;
      i++;
      endRecord();
      continue;
    }
    field += c;
    started = true;
    i++;
  }
  if (field !== '' || record.length > 0) {
    endField();
    out.push(record);
  }
  return out;
}

// ---------------------------------------------------------------------------
// sniff()
// ---------------------------------------------------------------------------

interface DialectScore {
  delimiter: string;
  quote: string;
  escape: string;
  score: number;
  fields: number;
}

/** Records whose field count equals the mode, over all records. */
function agreement(records: string[][]): { mode: number; ratio: number } {
  if (records.length === 0) return { mode: 0, ratio: 0 };
  const counts = new Map<number, number>();
  for (const r of records) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
  let mode = 0;
  let best = 0;
  for (const [len, n] of counts) {
    if (n > best || (n === best && len > mode)) {
      mode = len;
      best = n;
    }
  }
  return { mode, ratio: best / records.length };
}

function scoreDialect(text: string, delimiter: string, quote: string, escape: string): DialectScore {
  // 64 records is plenty to see a stable shape and cheap on a 256 KiB sample.
  const all = scanRecords(text, delimiter, quote, escape, 64);
  const records = all.length > 1 ? all.slice(0, -1) : all; // last one may be cut off
  const usable = records.filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ''));
  const { mode, ratio } = agreement(usable);
  if (mode < 2 || usable.length === 0) return { delimiter, quote, escape, score: 0, fields: mode };
  // Consistency dominates; column count only breaks ties, capped so that a
  // pathological "every character is a delimiter" guess cannot win.
  const score = ratio * 1000 + Math.min(mode, 30);
  return { delimiter, quote, escape, score, fields: mode };
}

/**
 * Guess a dialect from the head of a file (PLAN §7.4). Everything it returns is
 * a *default the user can override* in the wizard — the sniffer never gets a
 * veto over an explicit choice.
 */
export function sniff(sample: Buffer): CsvDialect {
  const dialect = defaultDialect();
  const enc = detectEncoding(sample);
  dialect.encoding = enc.encoding;
  dialect.bom = enc.bom;
  dialect.bomBytes = enc.bomBytes;

  const text = decodeBuffer(sample.subarray(enc.bomBytes), enc.encoding);
  if (text.trim() === '') return dialect;

  // `\` as an escape only exists if the file never doubles its quotes; MySQL's
  // own CSV export writes `\"` where RFC 4180 writes `""`.
  const backslashEscapes = /\\"/.test(text) && !/""/.test(text);

  let best: DialectScore | null = null;
  for (const quote of QUOTE_CANDIDATES) {
    const escape = backslashEscapes ? '\\' : quote;
    for (let i = 0; i < DELIMITER_CANDIDATES.length; i++) {
      const candidate = scoreDialect(text, DELIMITER_CANDIDATES[i], quote, escape);
      // Earlier candidates win ties: a file that parses equally well on ',' and
      // ':' is a comma file.
      if (!best || candidate.score > best.score) best = candidate;
    }
  }

  if (best && best.score > 0) {
    dialect.delimiter = best.delimiter;
    dialect.quote = best.quote;
    dialect.escape = best.escape;
    dialect.confidence = Math.min(1, best.score / 1030);
  } else {
    // Single-column file: any delimiter is as good as another.
    dialect.confidence = 0;
  }

  if (/^\s*#/m.test(text) && !text.includes(`${dialect.delimiter}#`)) dialect.comment = '#';

  const records = trimTruncated(scanRecords(text, dialect.delimiter, dialect.quote, dialect.escape, 32));
  dialect.hasHeader = looksLikeHeader(records);
  // `\N` is the MySQL/Postgres convention and cannot occur as real data
  // unquoted, so honouring it by default saves the common dump-to-CSV case.
  if (records.some((r) => r.some((v) => v === '\\N'))) dialect.nullLiteral = '\\N';
  return dialect;
}

/** Read the head of a file and sniff it. */
export async function sniffFile(path: string, bytes = SNIFF_BYTES): Promise<CsvDialect> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return sniff(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function trimTruncated(records: string[][]): string[][] {
  const usable = records.filter((r) => !(r.length === 1 && r[0] === ''));
  return usable.length > 1 ? usable.slice(0, -1) : usable;
}

// ---------------------------------------------------------------------------
// Header detection & type inference
// ---------------------------------------------------------------------------

const RE_INTEGER = /^[+-]?\d+$/;
const RE_DECIMAL = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;
const RE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
const RE_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const RE_HEX = /^(?:0x)?(?:[0-9a-fA-F]{2})+$/;
const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', 'off', '0']);

const SAFE_INT_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** The narrowest wire type a single text value could be. */
export function inferValueType(value: string): BaseType {
  const v = value.trim();
  if (v === '') return 'unknown';
  if (RE_INTEGER.test(v)) {
    const abs = v.startsWith('-') || v.startsWith('+') ? v.slice(1) : v;
    // A leading zero is an identifier (zip code, phone), not a number.
    if (abs.length > 1 && abs.startsWith('0')) return 'string';
    try {
      const n = BigInt(v);
      return n > SAFE_INT_MAX || n < -SAFE_INT_MAX ? 'bigint' : 'integer';
    } catch {
      return 'string';
    }
  }
  if (RE_DECIMAL.test(v)) return 'decimal';
  const lower = v.toLowerCase();
  if (lower === 'true' || lower === 'false') return 'boolean';
  if (RE_UUID.test(v)) return 'uuid';
  if (RE_TIMESTAMP.test(v)) return 'timestamp';
  if (RE_DATE.test(v)) return 'date';
  if (RE_TIME.test(v)) return 'time';
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try {
      JSON.parse(v);
      return 'json';
    } catch {
      return 'string';
    }
  }
  return 'string';
}

/** Least upper bound of two inferred types. */
function mergeType(a: BaseType, b: BaseType): BaseType {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  if (a === b) return a;
  const numeric = new Set<BaseType>(['integer', 'bigint', 'decimal']);
  if (numeric.has(a) && numeric.has(b)) {
    if (a === 'decimal' || b === 'decimal') return 'decimal';
    return 'bigint';
  }
  if ((a === 'date' || a === 'timestamp') && (b === 'date' || b === 'timestamp')) return 'timestamp';
  return 'string';
}

/**
 * A per-column target type for the mapping screen. Values matching the file's
 * NULL literal are ignored, so one NULL does not force a whole column to text.
 */
export function inferColumnTypes(rows: string[][], nullLiteral = ''): BaseType[] {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const types: BaseType[] = new Array<BaseType>(width).fill('unknown');
  for (const row of rows) {
    for (let c = 0; c < width; c++) {
      const raw = row[c];
      if (raw === undefined) continue;
      if (raw === nullLiteral || raw.trim() === '') continue;
      types[c] = mergeType(types[c], inferValueType(raw));
    }
  }
  // A column we never saw a value for is text: the least destructive choice.
  return types.map((t) => (t === 'unknown' ? 'string' : t));
}

function unique(values: string[]): boolean {
  return new Set(values.map((v) => v.trim().toLowerCase())).size === values.length;
}

/**
 * Is row 1 a header? The reliable signal is a *type break*: a text row sitting
 * on top of columns that are otherwise numbers or dates. Where every column is
 * text there is no such signal, so we fall back to the shape of the names
 * (non-empty, unique, not numeric) — which is what a human does too.
 */
export function looksLikeHeader(records: string[][]): boolean {
  if (records.length === 0) return true;
  const head = records[0];
  if (head.length === 0) return true;
  if (head.some((v) => v.trim() === '')) return false;
  if (!unique(head)) return false;
  if (head.some((v) => inferValueType(v) !== 'string')) return false;
  if (records.length === 1) return true;

  const body = records.slice(1);
  const bodyTypes = inferColumnTypes(body);
  // Any column whose data is not text while its first row is text: header.
  if (bodyTypes.some((t) => t !== 'string')) return true;
  // All-text file: names that look like names, and no repeat of row 1 below.
  const headKey = head.join('\u0000');
  return !body.some((r) => r.join('\u0000') === headKey);
}

/** Column names for a header-less file, matching what the grid will show. */
export function syntheticHeaders(width: number): string[] {
  return Array.from({ length: width }, (_, i) => `column_${i + 1}`);
}

/** The mapping the wizard starts from: source column i → target column of the same name. */
export function defaultMapping(headers: string[], types: BaseType[]): ColumnMapping[] {
  return headers.map((name, i) => ({
    sourceIndex: i,
    sourceName: name,
    targetColumn: name,
    targetType: types[i] ?? 'string',
    trim: false,
  }));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function parserOptions(dialect: CsvDialect, extra: CsvParseOptions = {}): CsvParseOptions {
  return {
    delimiter: dialect.delimiter,
    quote: dialect.quote,
    escape: dialect.escape,
    comment: dialect.comment,
    trim: dialect.trim,
    relax_quotes: dialect.relaxQuotes,
    // A short or long row is a data problem to report per row, not a reason to
    // abandon a 10 GB import (PLAN §7.4 "continue-on-error").
    relax_column_count: true,
    skip_empty_lines: true,
    // The BOM is skipped by byte offset when the stream is opened.
    bom: false,
    // Guard against a wrong delimiter turning the whole file into one field,
    // while still allowing genuinely large text columns.
    max_record_size: 64 * 1024 * 1024,
    ...extra,
  };
}

interface OpenedCsv {
  file: ReturnType<typeof createReadStream>;
  parser: Readable;
}

function openCsv(path: string, dialect: CsvDialect, extra: CsvParseOptions = {}): OpenedCsv {
  // Skipping the BOM by byte offset rather than by parser option keeps the
  // UTF-16 byte-swap path (see decodeStream) honest.
  const file = createReadStream(path, { start: dialect.bomBytes, highWaterMark: 1 << 20 });
  const parser = file.pipe(decodeStream(dialect.encoding)).pipe(parse(parserOptions(dialect, extra)));
  // A parser failure must tear the file read down too, or the fd leaks.
  parser.on('error', () => file.destroy());
  return { file, parser };
}

/**
 * The wizard's preview (PLAN §7.4: "preview 50 rows"). Reads only as far as it
 * has to — the stream is destroyed as soon as enough records have arrived.
 */
export async function previewCsv(
  path: string,
  dialect: CsvDialect,
  n = PREVIEW_ROWS,
): Promise<{ headers: string[]; rows: string[][] }> {
  const want = dialect.hasHeader ? n + 1 : n;
  const { file, parser } = openCsv(path, dialect, { to: Math.max(1, want) });

  const records: string[][] = [];
  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      records.push(record);
      if (records.length >= want) break; // `for await` destroys the parser on break
    }
  } finally {
    // Destroying the parser does not close the file behind it, and a preview
    // that leaks an fd per click is a slow-motion outage.
    parser.destroy();
    file.destroy();
  }

  const width = records.reduce((max, r) => Math.max(max, r.length), 0);
  const headers =
    dialect.hasHeader && records.length > 0
      ? padTo(records[0], width).map((h, i) => (h.trim() === '' ? `column_${i + 1}` : h.trim()))
      : syntheticHeaders(width);
  const rows = (dialect.hasHeader ? records.slice(1) : records).map((r) => padTo(r, width));
  return { headers, rows };
}

function padTo(row: string[], width: number): string[] {
  if (row.length === width) return row;
  const out = row.slice(0, width);
  while (out.length < width) out.push('');
  return out;
}

export interface ReadCsvOptions {
  /** Rows per yielded batch. The writer decides what it does with them. */
  batchSize?: number;
  /** Cancels the read; the underlying file stream is destroyed (PLAN §7.3). */
  signal?: AbortSignal;
  /** Stop after this many data rows — used by the dry run's sampling mode. */
  limit?: number;
  /**
   * When set, a row that fails coercion is reported and skipped instead of
   * aborting the import (PLAN §7.4 "continue-on-error with a collected error
   * report"). Without it, the first bad row throws.
   */
  onError?: (err: CsvRowError) => void;
  /** Progress for the job drawer: rows parsed and bytes consumed from the file. */
  onProgress?: (p: { rows: number; bytes: number }) => void;
}

/** A value that could not be coerced, with everything needed to fix it. */
export class CsvRowError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
    readonly columnName: string,
    readonly value: string,
  ) {
    super(message);
    this.name = 'CsvRowError';
  }
}

/**
 * Stream a CSV as coerced wire rows (PLAN §7.4). Yields batches so writers can
 * do one COPY/LOAD/bulkWrite per batch instead of one per row; backpressure is
 * the consumer simply not asking for the next batch.
 */
export async function* readCsvRows(
  path: string,
  dialect: CsvDialect,
  mapping: ColumnMapping[],
  opts: ReadCsvOptions = {},
): AsyncIterable<Row[]> {
  const batchSize = Math.max(1, opts.batchSize ?? 1000);
  const active = mapping.filter((m) => m.targetColumn !== null && m.targetColumn !== '');
  if (active.length === 0) throw new Error('No source column is mapped to a target column.');

  let batch: Row[] = [];
  let rows = 0;
  let line = dialect.hasHeader ? 1 : 0;

  const { file, parser } = openCsv(path, dialect, {
    // Skipping the header here rather than in our loop keeps csv-parse's own
    // line numbers aligned with the file, which the error report quotes.
    from_line: dialect.hasHeader ? 2 : 1,
    // Continue-on-error has to survive a *malformed record* too — an unclosed
    // quote three million rows in — not just a value that will not coerce.
    skip_records_with_error: !!opts.onError,
    on_skip: (err) => {
      opts.onError?.(
        new CsvRowError(err?.message ?? 'Malformed CSV record', line + 1, 0, '', err?.message ?? ''),
      );
      return undefined;
    },
  });

  const abort = (): void => {
    parser.destroy();
    file.destroy();
  };
  opts.signal?.addEventListener('abort', abort, { once: true });

  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      if (opts.signal?.aborted) break;
      line++;
      let row: Row;
      try {
        row = coerceRecord(record, active, dialect, line);
      } catch (err) {
        if (!(err instanceof CsvRowError) || !opts.onError) throw err;
        opts.onError(err);
        continue;
      }
      batch.push(row);
      rows++;
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
        opts.onProgress?.({ rows, bytes: file.bytesRead });
      }
      if (opts.limit !== undefined && rows >= opts.limit) break;
    }
    if (batch.length > 0) yield batch;
    opts.onProgress?.({ rows, bytes: file.bytesRead });
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    parser.destroy();
    file.destroy();
  }
}

/** One parsed record → one wire row, in target-column order. */
export function coerceRecord(
  record: string[],
  mapping: ColumnMapping[],
  dialect: CsvDialect,
  line: number,
): Row {
  const row: Row = [];
  for (const m of mapping) {
    const raw = record[m.sourceIndex];
    if (raw === undefined) {
      // A short row: missing trailing fields become NULL rather than failing the
      // row, which is what every other CSV importer does with a ragged file.
      row.push(null);
      continue;
    }
    row.push(coerceValue(raw, m, dialect, line));
  }
  return row;
}

// ---------------------------------------------------------------------------
// Coercion (PLAN §7.4: "type coercion and an explicit date format; NULL-literal
// and trim settings")
// ---------------------------------------------------------------------------

export function coerceValue(raw: string, m: ColumnMapping, dialect: CsvDialect, line = 0): Cell {
  const trim = m.trim ?? dialect.trim;
  const text = trim ? raw.trim() : raw;
  const nullLiteral = m.nullLiteral ?? dialect.nullLiteral;
  if (text === nullLiteral) return null;
  // An unquoted empty field is NULL everywhere except when the user has said a
  // different token means NULL — then it is a genuine empty string.
  if (text === '' && nullLiteral === '') return null;

  const type = (m.targetType ?? 'string') as BaseType;
  const name = m.targetColumn ?? m.sourceName;
  const fail = (why: string): never => {
    throw new CsvRowError(
      `Column "${name}": ${why} (value: ${JSON.stringify(text.slice(0, 120))})`,
      line,
      m.sourceIndex,
      name,
      text,
    );
  };

  switch (type) {
    case 'boolean': {
      const lower = text.trim().toLowerCase();
      if (TRUE_WORDS.has(lower)) return true;
      if (FALSE_WORDS.has(lower)) return false;
      return fail('is not a boolean');
    }
    case 'integer':
    case 'bigint': {
      const v = text.trim();
      if (!RE_INTEGER.test(v)) return fail('is not an integer');
      const n = BigInt(v);
      // §6 wire format: anything outside the safe range travels as text so the
      // JSON round trip cannot round it.
      if (n > SAFE_INT_MAX || n < -SAFE_INT_MAX) return tag('bigint', n.toString());
      return Number(n);
    }
    case 'decimal':
    case 'money': {
      const v = text.trim();
      if (!RE_DECIMAL.test(v)) return fail('is not a number');
      // Never parsed as a float: NUMERIC(38,10) does not survive a double.
      return tag('decimal', v);
    }
    case 'float': {
      const v = text.trim();
      if (!RE_DECIMAL.test(v)) return fail('is not a number');
      return Number(v);
    }
    case 'date':
      return tag('date', formatTemporal(text, m.dateFormat, 'date', fail));
    case 'time':
      return tag('time', formatTemporal(text, m.dateFormat, 'time', fail));
    case 'timestamp': {
      const v = formatTemporal(text, m.dateFormat, 'timestamp', fail);
      return tag(v.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(v) ? 'timestamptz' : 'timestamp', v);
    }
    case 'json': {
      try {
        JSON.parse(text);
      } catch {
        return fail('is not valid JSON');
      }
      return tag('json', text);
    }
    case 'uuid': {
      const v = text.trim();
      if (!RE_UUID.test(v)) return fail('is not a UUID');
      return tag('uuid', v);
    }
    case 'binary': {
      const v = text.trim();
      // Hex first: it is unambiguous, and a base64 decode of hex text would
      // silently succeed and write the wrong bytes (PLAN §7.4 binary policy).
      if (RE_HEX.test(v)) {
        const hex = v.startsWith('0x') ? v.slice(2) : v;
        return bytesCell(Uint8Array.from(Buffer.from(hex, 'hex')));
      }
      const decoded = Buffer.from(v, 'base64');
      if (decoded.length === 0 && v.length > 0) return fail('is not hex or base64');
      return bytesCell(Uint8Array.from(decoded));
    }
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Dates: an explicit format beats guessing (PLAN §7.4)
// ---------------------------------------------------------------------------

interface TemporalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  fraction: string;
  offset: string | null;
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Format tokens, longest first so `YYYY` is never read as `YY` + `YY`. */
const TOKENS: { token: string; pattern: string; key: keyof TemporalParts | 'ampm' | 'month_name' }[] = [
  { token: 'YYYY', pattern: '(\\d{4})', key: 'year' },
  { token: 'YY', pattern: '(\\d{2})', key: 'year' },
  { token: 'MMMM', pattern: '([A-Za-z]+)', key: 'month_name' },
  { token: 'MMM', pattern: '([A-Za-z]{3})', key: 'month_name' },
  { token: 'MM', pattern: '(\\d{2})', key: 'month' },
  { token: 'M', pattern: '(\\d{1,2})', key: 'month' },
  { token: 'DD', pattern: '(\\d{2})', key: 'day' },
  { token: 'D', pattern: '(\\d{1,2})', key: 'day' },
  { token: 'HH', pattern: '(\\d{1,2})', key: 'hour' },
  { token: 'hh', pattern: '(\\d{1,2})', key: 'hour' },
  { token: 'mm', pattern: '(\\d{1,2})', key: 'minute' },
  { token: 'ss', pattern: '(\\d{1,2})', key: 'second' },
  { token: 'SSSSSS', pattern: '(\\d{1,6})', key: 'fraction' },
  { token: 'SSS', pattern: '(\\d{1,3})', key: 'fraction' },
  { token: 'S', pattern: '(\\d{1,9})', key: 'fraction' },
  { token: 'ZZ', pattern: '(Z|[+-]\\d{2}:?\\d{2})', key: 'offset' },
  { token: 'Z', pattern: '(Z|[+-]\\d{2}:?\\d{2})', key: 'offset' },
  { token: 'A', pattern: '([AaPp][Mm])', key: 'ampm' },
  { token: 'a', pattern: '([AaPp][Mm])', key: 'ampm' },
];

interface CompiledFormat {
  re: RegExp;
  keys: (keyof TemporalParts | 'ampm' | 'month_name')[];
}

const formatCache = new Map<string, CompiledFormat>();

/**
 * Compile a user-supplied date format into a regex. Deliberately small: the
 * wizard offers a format field precisely so we never have to guess between
 * `03/04/2024` as March 4th and April 3rd.
 */
export function compileDateFormat(format: string): CompiledFormat {
  const cached = formatCache.get(format);
  if (cached) return cached;

  let re = '^';
  const keys: CompiledFormat['keys'] = [];
  let i = 0;
  outer: while (i < format.length) {
    if (format.charAt(i) === '\\' && i + 1 < format.length) {
      re += escapeRegex(format.charAt(i + 1));
      i += 2;
      continue;
    }
    for (const t of TOKENS) {
      if (format.startsWith(t.token, i)) {
        re += t.pattern;
        keys.push(t.key);
        i += t.token.length;
        continue outer;
      }
    }
    re += escapeRegex(format.charAt(i));
    i++;
  }
  re += '$';
  const compiled: CompiledFormat = { re: new RegExp(re), keys };
  formatCache.set(format, compiled);
  return compiled;
}

function escapeRegex(c: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(c) ? `\\${c}` : c;
}

function emptyParts(): TemporalParts {
  return { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, fraction: '', offset: null };
}

function parseWithFormat(value: string, format: string): TemporalParts | null {
  const { re, keys } = compileDateFormat(format);
  const m = re.exec(value.trim());
  if (!m) return null;
  const parts = emptyParts();
  let ampm: string | null = null;
  for (let i = 0; i < keys.length; i++) {
    const raw = m[i + 1] ?? '';
    switch (keys[i]) {
      case 'year':
        // A two-digit year follows the POSIX pivot: 69–99 → 1900s, 00–68 → 2000s.
        parts.year = raw.length === 2 ? (Number(raw) >= 69 ? 1900 + Number(raw) : 2000 + Number(raw)) : Number(raw);
        break;
      case 'month':
        parts.month = Number(raw);
        break;
      case 'month_name': {
        const idx = MONTH_NAMES.findIndex((n) => n.startsWith(raw.toLowerCase()));
        if (idx < 0) return null;
        parts.month = idx + 1;
        break;
      }
      case 'day':
        parts.day = Number(raw);
        break;
      case 'hour':
        parts.hour = Number(raw);
        break;
      case 'minute':
        parts.minute = Number(raw);
        break;
      case 'second':
        parts.second = Number(raw);
        break;
      case 'fraction':
        parts.fraction = raw;
        break;
      case 'offset':
        parts.offset = normalizeOffset(raw);
        break;
      case 'ampm':
        ampm = raw.toLowerCase();
        break;
    }
  }
  if (ampm) {
    if (ampm.startsWith('p') && parts.hour < 12) parts.hour += 12;
    if (ampm.startsWith('a') && parts.hour === 12) parts.hour = 0;
  }
  return validParts(parts) ? parts : null;
}

function normalizeOffset(raw: string): string {
  if (raw === 'Z' || raw === 'z') return 'Z';
  const sign = raw.charAt(0);
  const digits = raw.slice(1).replace(':', '');
  return `${sign}${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

function validParts(p: TemporalParts): boolean {
  if (p.month < 1 || p.month > 12) return false;
  if (p.day < 1 || p.day > 31) return false;
  if (p.hour > 23 || p.minute > 59 || p.second > 60) return false;
  // Reject a real impossibility like 2024-02-31 by round-tripping through UTC.
  const probe = new Date(Date.UTC(p.year, p.month - 1, p.day));
  return probe.getUTCMonth() === p.month - 1 && probe.getUTCDate() === p.day;
}

/** ISO 8601 and the SQL `YYYY-MM-DD HH:MM:SS` spelling — nothing ambiguous. */
function parseIso(value: string): TemporalParts | null {
  const v = value.trim();
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (m) {
    const parts = emptyParts();
    parts.year = Number(m[1]);
    parts.month = Number(m[2]);
    parts.day = Number(m[3]);
    parts.hour = Number(m[4] ?? 0);
    parts.minute = Number(m[5] ?? 0);
    parts.second = Number(m[6] ?? 0);
    parts.fraction = m[7] ?? '';
    parts.offset = m[8] ? normalizeOffset(m[8]) : null;
    return validParts(parts) ? parts : null;
  }
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(v);
  if (t) {
    const parts = emptyParts();
    parts.hour = Number(t[1]);
    parts.minute = Number(t[2]);
    parts.second = Number(t[3] ?? 0);
    parts.fraction = t[4] ?? '';
    return validParts(parts) ? parts : null;
  }
  return null;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Canonical text for a temporal value. Always ISO-ish, always the same shape,
 * because every writer downstream sends it as text and lets the engine parse
 * it — which is the only formulation all four SQL engines agree on.
 */
function formatTemporal(
  text: string,
  format: string | undefined,
  kind: 'date' | 'time' | 'timestamp',
  fail: (why: string) => never,
): string {
  const parts = format ? parseWithFormat(text, format) : parseIso(text);
  if (!parts) {
    return fail(
      format
        ? `does not match the date format "${format}"`
        : 'is not an ISO date/time — set an explicit date format for this column',
    );
  }
  const frac = parts.fraction ? `.${parts.fraction}` : '';
  switch (kind) {
    case 'date':
      return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
    case 'time':
      return `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}${frac}`;
    case 'timestamp':
      return (
        `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)} ` +
        `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}${frac}` +
        (parts.offset ?? '')
      );
  }
}
