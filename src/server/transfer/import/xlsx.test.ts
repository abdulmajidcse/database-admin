/**
 * Unit tests for the XLSX reader (docs/roadmap.md M12).
 *
 * Fixtures are written with the same exceljs the export side uses, so these are
 * genuine round trips rather than assertions about a hand-built file.
 *
 * The failures worth catching are the lossy ones. A spreadsheet stores numbers
 * as doubles, so an ID beyond 2^53 that was typed as text must stay text; a
 * date arrives as a Date object and must not become a locale-formatted string;
 * and a blank cell is a real absence, not the string "undefined".
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { previewXlsx, readXlsxRows } from './xlsx';

let dir: string;
let simple: string;
let typed: string;

async function write(file: string, rows: unknown[][]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(file);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'xlsx-test-'));
  simple = path.join(dir, 'simple.xlsx');
  typed = path.join(dir, 'typed.xlsx');

  await write(simple, [
    ['id', 'name', 'note'],
    [1, 'alice', 'first'],
    [2, 'bob', null],
  ]);

  await write(typed, [
    ['n', 'big', 'when', 'flag', 'blank'],
    [42, '9007199254740993', new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), true, null],
  ]);
}, 30_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('previewXlsx', () => {
  it('reads the header row and the rows beneath it', async () => {
    const p = await previewXlsx(simple, 10);
    expect(p.headers).toEqual(['id', 'name', 'note']);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toEqual(['1', 'alice', 'first']);
  });

  it('stops at the requested row count', async () => {
    const p = await previewXlsx(simple, 1);
    expect(p.rows).toHaveLength(1);
  });

  it('names unnamed columns rather than leaving holes', async () => {
    const f = path.join(dir, 'gap.xlsx');
    await write(f, [['a', null, 'c'], [1, 2, 3]]);
    const p = await previewXlsx(f, 5);
    expect(p.headers).toHaveLength(3);
    expect(p.headers[1]).not.toBe('');
  });
});

describe('readXlsxRows', () => {
  const mapping = (names: string[]) =>
    names.map((n, i) => ({ sourceIndex: i, sourceName: n, targetColumn: n }));

  async function collect(file: string, names: string[]) {
    const out: unknown[][] = [];
    for await (const batch of readXlsxRows(file, mapping(names), { batchSize: 100 })) {
      out.push(...batch);
    }
    return out;
  }

  it('yields the data rows, not the header', async () => {
    const rows = await collect(simple, ['id', 'name', 'note']);
    expect(rows).toHaveLength(2);
    expect(rows[0][1]).toBe('alice');
  });

  it('reads a blank cell as NULL, not as an empty string or "undefined"', async () => {
    const rows = await collect(simple, ['id', 'name', 'note']);
    expect(rows[1][2]).toBeNull();
  });

  it('keeps an oversized integer written as text losslessly', async () => {
    // A spreadsheet number is a double; 9007199254740993 cannot survive one, so
    // it is stored as text and must come back as those digits.
    const rows = await collect(typed, ['n', 'big', 'when', 'flag', 'blank']);
    expect(rows[0][1]).toBe('9007199254740993');
  });

  it('renders a date cell as an ISO timestamp rather than a locale string', async () => {
    const rows = await collect(typed, ['n', 'big', 'when', 'flag', 'blank']);
    expect(String(rows[0][2])).toMatch(/^2026-01-02T03:04:05/);
  });

  it('keeps a number a number and a boolean a boolean', async () => {
    const rows = await collect(typed, ['n', 'big', 'when', 'flag', 'blank']);
    expect(rows[0][0]).toBe(42);
    expect(rows[0][3]).toBe(true);
  });

  it('drops a column whose mapping targets nothing', async () => {
    const m = [
      { sourceIndex: 0, sourceName: 'id', targetColumn: 'id' },
      { sourceIndex: 1, sourceName: 'name', targetColumn: null },
      { sourceIndex: 2, sourceName: 'note', targetColumn: 'note' },
    ];
    const out: unknown[][] = [];
    for await (const batch of readXlsxRows(simple, m, { batchSize: 100 })) out.push(...batch);
    expect(out[0]).toHaveLength(2);
    expect(out[0][1]).toBe('first');
  });

  it('honours the batch size', async () => {
    const batches: number[] = [];
    for await (const batch of readXlsxRows(simple, mapping(['id', 'name', 'note']), { batchSize: 1 })) {
      batches.push(batch.length);
    }
    expect(batches).toEqual([1, 1]);
  });
});
