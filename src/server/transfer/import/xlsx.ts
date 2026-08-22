/**
 * XLSX import (docs/roadmap.md M12).
 *
 * Export has written xlsx since M7; import read everything except it, which is
 * the format people are most likely to be handed. This is the missing reader,
 * shaped to the same two seams the CSV and JSON readers plug into — a preview
 * that yields headers plus sample rows, and a batched row stream.
 *
 * Streamed through exceljs' `WorkbookReader` rather than loaded whole. A
 * spreadsheet someone exported from a warehouse is routinely hundreds of MB,
 * and `Workbook.xlsx.readFile` materialises every cell before yielding one row.
 *
 * Cell values are converted, not stringified. What a sheet stores and what a
 * database column wants differ in ways that lose data if you go through
 * `String(value)`: a date becomes a locale string, a formula becomes its
 * source text, and a blank cell becomes "undefined".
 */

import ExcelJS from 'exceljs';

import type { ColumnMapping } from '../../../lib/api-types';
import type { Cell, Row } from '../../../lib/wire';

export interface XlsxPreview {
  headers: string[];
  /** Sample rows as text, for the mapping wizard's grid. */
  rows: string[][];
}

export interface ReadXlsxOptions {
  batchSize: number;
  signal?: AbortSignal;
  onProgress?: (p: { rows: number; bytes: number }) => void;
}

/**
 * One cell as a value the import pipeline can bind.
 *
 * exceljs hands back JS types plus a few shapes of its own (formula results,
 * rich text, hyperlinks, errors). Each is unwrapped to the thing a column
 * actually wants rather than passed through `String()`.
 */
function cellValue(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    // ISO, not a locale string: every engine parses it and it sorts correctly.
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    // A formula cell carries both its source and its last computed result. The
    // result is the data; the formula is how the sheet got there.
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
    if ('richText' in v && Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    }
    if ('text' in v && typeof v.text === 'string') return v.text;
    // An error cell (#REF!, #DIV/0!) has no value worth importing.
    if ('error' in v) return null;
  }
  return String(value);
}

/**
 * Excel's epoch is 1899-12-30 (the 1900 leap-year bug is why it is not the
 * 31st), and a date is stored as days since then.
 */
function fromSerial(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString();
}

/**
 * One cell, consulting its type as well as its value.
 *
 * The streaming reader does not resolve dates the way the buffered one does: a
 * date arrives as the raw serial number with a date number-format on the style.
 * Reading only `.value` yields 46024.127…, which lands in the column as a
 * meaningless float, so the cell's declared type and format decide.
 */
function cellFrom(cell: ExcelJS.Cell): Cell {
  if (cell.type === ExcelJS.ValueType.Date) {
    const v = cell.value;
    if (v instanceof Date) return v.toISOString();
  }
  const numFmt = (cell.style?.numFmt ?? '').toLowerCase();
  const looksLikeDate = /[dmy]/.test(numFmt) && /(yy|dd|mm|hh)/.test(numFmt);
  if (looksLikeDate && typeof cell.value === 'number') return fromSerial(cell.value);
  return cellValue(cell.value);
}

/** A row's cells as a dense array, since exceljs skips empty trailing cells. */
function denseRow(row: ExcelJS.Row, width: number): Cell[] {
  const out: Cell[] = new Array<Cell>(width).fill(null);
  for (let c = 1; c <= width; c++) {
    out[c - 1] = cellFrom(row.getCell(c));
  }
  return out;
}

function asText(cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'object') return typeof cell.v === 'string' ? cell.v : '';
  return String(cell);
}

async function openSheet(file: string): Promise<AsyncIterable<ExcelJS.Row> & { close: () => void }> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    entries: 'emit',
    sharedStrings: 'cache',
    // Styles are not parsed by default, and without them every date cell
    // arrives as a bare serial number with no number-format to identify it —
    // 46024.127… lands in a timestamp column as a meaningless float.
    styles: 'cache',
    worksheets: 'emit',
  });
  const iterator = (async function* () {
    // The first worksheet the reader yields. WorksheetReader exposes no id, and
    // a single-table export writes one sheet, so first is the right one.
    for await (const worksheet of reader) {
      for await (const row of worksheet) yield row as ExcelJS.Row;
      return;
    }
  })();
  return Object.assign(iterator, { close: () => undefined });
}

/**
 * Headers and the first `limit` data rows, for the mapping wizard.
 *
 * The first row is taken as the header. That matches the CSV reader's default
 * and what every spreadsheet export writes; a sheet without one is handled by
 * the wizard letting the user remap, exactly as it does for CSV.
 */
export async function previewXlsx(file: string, limit: number): Promise<XlsxPreview> {
  const sheet = await openSheet(file);
  let headers: string[] = [];
  const rows: string[][] = [];
  let width = 0;

  for await (const row of sheet) {
    if (headers.length === 0) {
      width = row.cellCount;
      headers = denseRow(row, width).map((c, i) => {
        const text = asText(c).trim();
        // A blank header would leave the column unaddressable in the mapping UI.
        return text === '' ? `column_${i + 1}` : text;
      });
      continue;
    }
    rows.push(denseRow(row, width).map(asText));
    if (rows.length >= limit) break;
  }

  return { headers, rows };
}

/**
 * Data rows in batches, with the mapping applied — columns whose
 * `targetColumn` is null are dropped, matching the CSV reader.
 */
export async function* readXlsxRows(
  file: string,
  mapping: ColumnMapping[],
  opts: ReadXlsxOptions,
): AsyncIterable<Row[]> {
  const wanted = mapping.filter((m) => m.targetColumn !== null);
  const width = mapping.length;
  const sheet = await openSheet(file);

  let batch: Row[] = [];
  let seen = 0;
  let first = true;

  for await (const row of sheet) {
    if (first) {
      first = false; // header
      continue;
    }
    if (opts.signal?.aborted) return;

    const cells = denseRow(row, width || row.cellCount);
    batch.push(wanted.map((m) => cells[m.sourceIndex] ?? null));
    seen += 1;

    if (batch.length >= opts.batchSize) {
      yield batch;
      batch = [];
      // Bytes are not knowable mid-sheet without decompressing ahead, and rows
      // are what the jobs drawer shows for this source anyway.
      opts.onProgress?.({ rows: seen, bytes: 0 });
    }
  }

  if (batch.length > 0) {
    yield batch;
    opts.onProgress?.({ rows: seen, bytes: 0 });
  }
}
