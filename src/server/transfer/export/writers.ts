/**
 * Streaming export writers — the §7.1 formats, plugged into the §7.4 pipeline.
 *
 * Every writer is a Duplex whose *writable* side is in object mode and accepts
 * `Row[]` chunks exactly as `SqlConnector.stream()` yields them, and whose
 * *readable* side emits bytes. That shape is what lets `pipeline()` carry real
 * backpressure from the file/socket all the way back to the database cursor
 * (§7.4) — a writer never accumulates rows, only the text of the chunk it was
 * handed.
 *
 * Two policies are explicit rather than implied, because both are classic
 * silent-corruption sources called out in §7.4/§6:
 *   - binary encoding in text formats (base64 or hex), and
 *   - NULL versus empty string, which must remain distinguishable in every
 *     format that has a way to express the difference.
 *
 * Server-side only: no React, no Next (§11).
 */

import { Duplex, PassThrough, Transform } from 'node:stream';
import { stringify as stringifyCsv } from 'csv-stringify/sync';
import type { Options as CsvOptions } from 'csv-stringify';
import ExcelJS from 'exceljs';
import type { ColumnMeta } from '../../../lib/results';
import { cellToText, type Cell, type Row } from '../../../lib/wire';

// ---------------------------------------------------------------------------
// Formats and policy
// ---------------------------------------------------------------------------

/** Formats produced by this module. `sql` lives in ./sql-writer (§7.1). */
export type TextExportFormat = 'csv' | 'tsv' | 'json' | 'ndjson' | 'markdown' | 'html';
export type ExportFormat = TextExportFormat | 'xlsx' | 'sql';

export type BinaryEncoding = 'base64' | 'hex';

export interface ValuePolicy {
  /** How `bytes` cells are rendered in text formats (§7.4). */
  binary: BinaryEncoding;
  /**
   * Text written for SQL NULL, or `null` to use the format's native NULL —
   * an unquoted empty CSV field, a JSON `null`, an empty spreadsheet cell.
   * With the native form, empty *strings* are still quoted/marked, so the two
   * never collapse into each other.
   */
  nullText: string | null;
  /** CSV/TSV: always quote empty strings so `""` cannot be read back as NULL. */
  quoteEmptyStrings: boolean;
  /** Override the words used for booleans in text formats (e.g. `1`/`0`). */
  booleanText: { true: string; false: string } | null;
  /** JSON/NDJSON: embed `$t:'json'` payloads as real JSON instead of a string. */
  jsonInline: boolean;
  /**
   * JSON/NDJSON: keep the full wire envelope (`{"$t":"bytes","v":"…"}`) so an
   * import can restore the exact type. Off by default — readable output wins
   * for the everyday case, and the tag is only lossless if both ends agree.
   */
  taggedEnvelope: boolean;
  /**
   * Emit bigint/decimal as bare JSON numbers. Off by default: JSON numbers are
   * IEEE doubles in every consumer we cannot control, which is precisely the
   * precision loss the wire format exists to avoid (§6).
   */
  rawNumbers: boolean;
  /** Prefix `=+-@` with a quote in CSV. Off by default — it *mutates values*. */
  escapeFormulas: boolean;
}

/** Digits a JSON/SQL numeric token may consist of, for the `rawNumbers` path. */
const NUMERIC_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const BASE_POLICY: ValuePolicy = {
  binary: 'base64',
  nullText: null,
  quoteEmptyStrings: true,
  booleanText: null,
  jsonInline: true,
  taggedEnvelope: false,
  rawNumbers: false,
  escapeFormulas: false,
};

/**
 * Per-format defaults. Markdown and HTML have no native NULL, so they get a
 * visible literal instead of an empty cell — otherwise a NULL and an empty
 * string render identically and the reader cannot tell which they are looking at.
 */
export function defaultPolicyFor(format: ExportFormat): ValuePolicy {
  switch (format) {
    case 'markdown':
    case 'html':
      return { ...BASE_POLICY, nullText: 'NULL' };
    default:
      return { ...BASE_POLICY };
  }
}

export function resolvePolicy(format: ExportFormat, overrides?: Partial<ValuePolicy>): ValuePolicy {
  return { ...defaultPolicyFor(format), ...(overrides ?? {}) };
}

// ---------------------------------------------------------------------------
// Value rendering
// ---------------------------------------------------------------------------

/**
 * The text for one cell, or `null` when the cell is SQL NULL and the policy
 * asks for the format's native NULL. Delegates to the wire format's
 * `cellToText`, which owns the lossless representation of every tagged cell.
 */
export function renderText(cell: Cell, policy: ValuePolicy): string | null {
  if (cell === null) return policy.nullText;
  if (typeof cell === 'boolean' && policy.booleanText) {
    return cell ? policy.booleanText.true : policy.booleanText.false;
  }
  // cellToText only returns null for a null cell, handled above.
  return cellToText(cell, policy.binary) ?? '';
}

/** One cell as a JSON *fragment* (not a value): lets bigints stay unquoted. */
export function renderJsonValue(cell: Cell, policy: ValuePolicy): string {
  if (cell === null) return policy.nullText === null ? 'null' : JSON.stringify(policy.nullText);
  if (typeof cell === 'boolean') {
    return policy.booleanText
      ? JSON.stringify(policy.booleanText[cell ? 'true' : 'false'])
      : cell
        ? 'true'
        : 'false';
  }
  if (typeof cell === 'number') {
    // NaN/Infinity have no JSON spelling; keep them as text rather than emit
    // invalid JSON that every parser downstream rejects.
    return Number.isFinite(cell) ? String(cell) : JSON.stringify(String(cell));
  }
  if (typeof cell === 'string') return JSON.stringify(cell);

  if (policy.taggedEnvelope) return JSON.stringify(cell);

  switch (cell.$t) {
    case 'json':
      if (!policy.jsonInline) return JSON.stringify(cell.v);
      try {
        JSON.parse(cell.v); // validate before splicing raw text into the document
        return cell.v;
      } catch {
        return JSON.stringify(cell.v);
      }
    case 'bytes':
      return JSON.stringify(cellToText(cell, policy.binary) ?? '');
    case 'bigint':
    case 'decimal':
    case 'decimal128':
      return policy.rawNumbers && NUMERIC_TOKEN.test(cell.v) ? cell.v : JSON.stringify(cell.v);
    default:
      return JSON.stringify(cell.v);
  }
}

// ---------------------------------------------------------------------------
// Writer plumbing
// ---------------------------------------------------------------------------

export interface WriterOptions {
  /** Column order; rows are positional and must match it. */
  columns: ColumnMeta[];
  policy?: Partial<ValuePolicy>;
  /** Emit a header row (CSV/TSV/XLSX) — Markdown and HTML always have one. */
  header?: boolean;
  /** Sheet name / HTML title / Markdown heading. */
  title?: string;
  /** CSV only; TSV forces a tab. */
  delimiter?: string;
  recordDelimiter?: '\n' | '\r\n';
  /** Prepend a UTF-8 BOM so Excel opens the CSV as UTF-8. */
  bom?: boolean;
  /** JSON array: one record per line instead of one long line. */
  pretty?: boolean;
  /**
   * XLSX only: do not open a worksheet in the constructor. A multi-table export
   * calls `startSheet()` itself once it knows the first source's columns.
   */
  deferSheet?: boolean;
  readableHighWaterMark?: number;
}

/**
 * Base for the text writers: object-mode in (`Row[]`), bytes out. The preamble
 * is emitted lazily so that a zero-row export still produces a valid file
 * (headers, `[]`, a closed `<table>`) instead of an empty one.
 */
abstract class RowWriter extends Transform {
  protected readonly columns: ColumnMeta[];
  protected readonly policy: ValuePolicy;
  private opened = false;

  constructor(format: ExportFormat, protected readonly options: WriterOptions) {
    super({
      writableObjectMode: true,
      readableObjectMode: false,
      // Small writable HWM: chunks are whole row batches, so a couple in flight
      // is all the buffering we ever want (§7.4 "memory stays flat").
      writableHighWaterMark: 2,
      readableHighWaterMark: options.readableHighWaterMark ?? 1 << 20,
    });
    this.columns = options.columns;
    this.policy = resolvePolicy(format, options.policy);
  }

  protected open(): string {
    if (this.opened) return '';
    this.opened = true;
    return this.preamble();
  }

  override _transform(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (!Array.isArray(chunk)) {
      cb(new TypeError('export writers expect Row[] chunks'));
      return;
    }
    try {
      const text = this.renderChunk(chunk as Row[]);
      if (text.length > 0) this.push(text);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: (e?: Error | null) => void): void {
    try {
      const text = this.open() + this.postamble();
      if (text.length > 0) this.push(text);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  protected abstract preamble(): string;
  protected abstract renderChunk(rows: Row[]): string;
  protected postamble(): string {
    return '';
  }

  /** Positional read that tolerates a short row (missing tail => NULL). */
  protected cellAt(row: Row, index: number): Cell {
    const c = row[index];
    return c === undefined ? null : c;
  }
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

class DelimitedWriter extends RowWriter {
  private readonly csv: CsvOptions;

  constructor(format: 'csv' | 'tsv', options: WriterOptions) {
    super(format, options);
    this.csv = {
      delimiter: format === 'tsv' ? '\t' : (options.delimiter ?? ','),
      record_delimiter: options.recordDelimiter ?? '\n',
      escape_formulas: this.policy.escapeFormulas,
      // NULL vs empty string (§7.4): a NULL cell reaches csv-stringify as
      // `null` and is written as an unquoted empty field, while a real empty
      // string asks for quoting per-field, so it is written as `""`. Setting the
      // global `quoted_empty` instead would quote *both* and destroy the
      // distinction, which is why the per-field cast is used here.
      cast: {
        string: (value: string) =>
          value === '' && this.policy.quoteEmptyStrings ? { value: '', quoted_empty: true } : value,
      },
      // We render the header ourselves as an ordinary record.
      header: false,
    };
  }

  protected preamble(): string {
    const bom = this.options.bom ? '\uFEFF' : '';
    if (this.options.header === false) return bom;
    return bom + stringifyCsv([this.columns.map((c) => c.name)], this.csv);
  }

  protected renderChunk(rows: Row[]): string {
    const head = this.open();
    if (rows.length === 0) return head;
    const records = rows.map((row) =>
      this.columns.map((_c, i) => renderText(this.cellAt(row, i), this.policy)),
    );
    return head + stringifyCsv(records, this.csv);
  }
}

// ---------------------------------------------------------------------------
// JSON array / NDJSON
// ---------------------------------------------------------------------------

class JsonWriter extends RowWriter {
  private readonly names: string[];
  private readonly array: boolean;
  private written = 0;

  constructor(format: 'json' | 'ndjson', options: WriterOptions) {
    super(format, options);
    this.array = format === 'json';
    this.names = this.columns.map((c) => JSON.stringify(c.name));
  }

  private object(row: Row): string {
    const gap = this.options.pretty ? ' ' : '';
    let out = '{';
    for (let i = 0; i < this.names.length; i++) {
      if (i > 0) out += ',' + gap;
      out += this.names[i] + ':' + gap + renderJsonValue(this.cellAt(row, i), this.policy);
    }
    return out + '}';
  }

  protected preamble(): string {
    return this.array ? '[' : '';
  }

  protected renderChunk(rows: Row[]): string {
    let out = this.open();
    for (const row of rows) {
      if (this.array) {
        out += this.written === 0 ? '' : ',';
        out += this.options.pretty ? '\n  ' : '';
      }
      out += this.object(row);
      if (!this.array) out += '\n';
      this.written++;
    }
    return out;
  }

  protected postamble(): string {
    if (!this.array) return '';
    const tail = this.options.pretty && this.written > 0 ? '\n' : '';
    return tail + ']\n';
  }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function escapeMarkdown(text: string): string {
  // A pipe would split the cell and a newline would end the row; both are
  // structural in GFM tables, so they are the only two we must rewrite.
  return text.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
}

class MarkdownWriter extends RowWriter {
  protected preamble(): string {
    const title = this.options.title ? `## ${this.options.title}\n\n` : '';
    const head = `| ${this.columns.map((c) => escapeMarkdown(c.name)).join(' | ')} |\n`;
    const rule = `|${this.columns.map(() => ' --- ').join('|')}|\n`;
    return title + head + rule;
  }

  protected renderChunk(rows: Row[]): string {
    let out = this.open();
    for (const row of rows) {
      const cells = this.columns.map((_c, i) =>
        escapeMarkdown(renderText(this.cellAt(row, i), this.policy) ?? ''),
      );
      out += `| ${cells.join(' | ')} |\n`;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

const NUMERIC_BASES = new Set(['integer', 'bigint', 'decimal', 'float', 'money']);

class HtmlWriter extends RowWriter {
  protected preamble(): string {
    const title = escapeHtml(this.options.title ?? 'Export');
    const head = this.columns
      .map((c) => `<th${NUMERIC_BASES.has(c.base) ? ' class="num"' : ''}>${escapeHtml(c.name)}</th>`)
      .join('');
    return (
      '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      `<title>${title}</title>\n<style>\n` +
      'body{font:13px/1.5 ui-sans-serif,system-ui,sans-serif;margin:1.5rem;color:#111}\n' +
      'table{border-collapse:collapse;width:100%}\n' +
      'th,td{border:1px solid #d4d4d8;padding:.25rem .5rem;text-align:left;vertical-align:top;' +
      'white-space:pre-wrap;font-variant-numeric:tabular-nums}\n' +
      'th{background:#f4f4f5;position:sticky;top:0}\n' +
      'td.num,th.num{text-align:right}\n' +
      'td.null{color:#a1a1aa;font-style:italic}\n' +
      '@media (prefers-color-scheme:dark){body{background:#18181b;color:#e4e4e7}' +
      'th{background:#27272a}th,td{border-color:#3f3f46}td.null{color:#71717a}}\n' +
      `</style>\n</head>\n<body>\n<h1>${title}</h1>\n<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n`
    );
  }

  protected renderChunk(rows: Row[]): string {
    let out = this.open();
    for (const row of rows) {
      out += '<tr>';
      for (let i = 0; i < this.columns.length; i++) {
        const cell = this.cellAt(row, i);
        const text = renderText(cell, this.policy);
        const classes: string[] = [];
        if (NUMERIC_BASES.has(this.columns[i].base)) classes.push('num');
        // A NULL is marked structurally, so it never reads as an empty string.
        if (cell === null) classes.push('null');
        const attr = classes.length ? ` class="${classes.join(' ')}"` : '';
        out += `<td${attr}>${escapeHtml(text ?? '')}</td>`;
      }
      out += '</tr>\n';
    }
    return out;
  }

  protected postamble(): string {
    return '</tbody>\n</table>\n</body>\n</html>\n';
  }
}

// ---------------------------------------------------------------------------
// XLSX (streaming)
// ---------------------------------------------------------------------------

type WorkbookWriter = InstanceType<typeof ExcelJS.stream.xlsx.WorkbookWriter>;
type StreamingWorksheet = ReturnType<WorkbookWriter['addWorksheet']>;

/** Excel forbids these in a sheet name and caps it at 31 characters. */
export function sanitizeSheetName(name: string, fallback = 'Sheet1'): string {
  const cleaned = name.replace(/[\\/*?:[\]]/g, '_').trim().slice(0, 31);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * XLSX via exceljs' `WorkbookWriter`, which serializes each row into the zip as
 * it arrives — a large export never builds the whole workbook in memory. It is
 * not a Transform, so this Duplex adapts it: rows in on the writable side, the
 * archiver's bytes out on the readable side, with the intermediate PassThrough
 * paused whenever the readable side is full so backpressure still reaches the
 * database cursor.
 */
export class XlsxWriter extends Duplex {
  private readonly bytes = new PassThrough();
  private readonly workbook: WorkbookWriter;
  private readonly policy: ValuePolicy;
  private readonly header: boolean;
  private sheet: StreamingWorksheet | null = null;
  private columns: ColumnMeta[];
  private finalized = false;

  constructor(options: WriterOptions) {
    super({ writableObjectMode: true, readableObjectMode: false, writableHighWaterMark: 2 });
    this.policy = resolvePolicy('xlsx', options.policy);
    this.header = options.header !== false;
    this.columns = options.columns;

    this.bytes.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) this.bytes.pause();
    });
    this.bytes.on('end', () => {
      this.push(null);
    });
    this.bytes.on('error', (err: Error) => this.destroy(err));

    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: this.bytes,
      // Shared strings and styles both mean holding state for the whole
      // workbook, which defeats the point of streaming.
      useSharedStrings: false,
      useStyles: false,
    });
    if (!options.deferSheet) this.startSheet(options.title ?? 'Sheet1', options.columns);
  }

  /**
   * Begin a new worksheet — how a multi-table export becomes one workbook with
   * one sheet per table (§7.1 "schema/database" scope). Commits the previous
   * sheet, which flushes it into the archive.
   */
  startSheet(name: string, columns: ColumnMeta[]): void {
    this.sheet?.commit();
    this.columns = columns;
    this.sheet = this.workbook.addWorksheet(sanitizeSheetName(name));
    if (this.header) this.sheet.addRow(columns.map((c) => c.name)).commit();
  }

  private value(cell: Cell): string | number | boolean | null {
    if (cell === null) return this.policy.nullText;
    if (typeof cell === 'number' || typeof cell === 'boolean' || typeof cell === 'string') {
      return typeof cell === 'boolean' && this.policy.booleanText
        ? this.policy.booleanText[cell ? 'true' : 'false']
        : cell;
    }
    if (cell.$t === 'bytes') return cellToText(cell, this.policy.binary) ?? '';
    if (cell.$t === 'bigint' || cell.$t === 'decimal' || cell.$t === 'decimal128') {
      // Excel stores numbers as IEEE doubles, so only values that survive the
      // round trip exactly become numeric cells; the rest stay text (§6).
      if (this.policy.rawNumbers && NUMERIC_TOKEN.test(cell.v)) {
        const n = Number(cell.v);
        if (Number.isFinite(n) && String(n) === cell.v) return n;
      }
      return cell.v;
    }
    return cell.v;
  }

  override _read(): void {
    this.bytes.resume();
  }

  override _write(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (!Array.isArray(chunk)) {
      cb(new TypeError('XlsxWriter expects Row[] chunks'));
      return;
    }
    try {
      const sheet = this.sheet;
      if (!sheet) throw new Error('XlsxWriter: no worksheet is open');
      for (const row of chunk as Row[]) {
        sheet.addRow(this.columns.map((_c, i) => this.value(row[i] === undefined ? null : row[i]))).commit();
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _final(cb: (e?: Error | null) => void): void {
    this.finalized = true;
    // workbook.commit() commits any open worksheet, finalizes the zip and ends
    // the archiver's output, which ends `bytes` and so ends our readable side.
    this.workbook.commit().then(
      () => cb(),
      (err: Error) => cb(err),
    );
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    if (!this.finalized) this.bytes.destroy();
    cb(err);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * A writer for one of the §7.1 formats. `sql` is deliberately absent: it needs
 * engine quoting and a table model, so it lives in ./sql-writer.
 */
export function createWriter(format: TextExportFormat | 'xlsx', options: WriterOptions): Duplex {
  switch (format) {
    case 'csv':
    case 'tsv':
      return new DelimitedWriter(format, options);
    case 'json':
    case 'ndjson':
      return new JsonWriter(format, options);
    case 'markdown':
      return new MarkdownWriter(format, options);
    case 'html':
      return new HtmlWriter(format, options);
    case 'xlsx':
      return new XlsxWriter(options);
    default: {
      const never: never = format;
      throw new Error(`Unknown export format: ${String(never)}`);
    }
  }
}

const EXTENSIONS: Record<ExportFormat, string> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  ndjson: 'ndjson',
  markdown: 'md',
  html: 'html',
  xlsx: 'xlsx',
  sql: 'sql',
};

export function fileExtension(format: ExportFormat, compress: 'none' | 'gzip' = 'none'): string {
  return compress === 'gzip' ? `${EXTENSIONS[format]}.gz` : EXTENSIONS[format];
}

export function contentTypeFor(format: ExportFormat, compress: 'none' | 'gzip' = 'none'): string {
  if (compress === 'gzip') return 'application/gzip';
  switch (format) {
    case 'csv':
      return 'text/csv; charset=utf-8';
    case 'tsv':
      return 'text/tab-separated-values; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'ndjson':
      return 'application/x-ndjson; charset=utf-8';
    case 'markdown':
      return 'text/markdown; charset=utf-8';
    case 'html':
      return 'text/html; charset=utf-8';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'sql':
      return 'application/sql; charset=utf-8';
  }
}

/** XLSX cannot be written twice into one file, so it never shares a sink. */
export function writerIsBinary(format: ExportFormat): boolean {
  return format === 'xlsx';
}
