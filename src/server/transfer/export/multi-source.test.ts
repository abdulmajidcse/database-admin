/**
 * Multi-source exports (PLAN §7.1 "Schema / database" and "Server" scopes).
 *
 * A database-scope export fans out into one source per table (see
 * app/api/export/build.ts), so every format has to answer the same question:
 * what does *one* artifact holding fifty tables look like? SQL concatenates into
 * one script and XLSX opens one sheet per table, but CSV physically cannot —
 * one file carries one header and one column shape. These tests pin down which
 * combinations are coherent and which must be refused rather than silently
 * written.
 */

import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import type { ColumnMeta } from '../../../lib/results';
import type { Connector } from '../../db/types';
import { runExport, type ExportFormat, type ExportSourceSpec } from './index';

/** A connector with no transaction capability, so no snapshot is attempted. */
function fakeConnector(kind = 'postgres'): Connector {
  return { kind, capabilities: new Set<string>() } as unknown as Connector;
}

function columns(names: string[]): ColumnMeta[] {
  return names.map((name) => ({ name, typeName: 'text', base: 'text' as const }));
}

/** A source that needs no database — the `rows` spec exists for exactly this. */
function table(label: string, cols: string[], rows: unknown[][]): ExportSourceSpec {
  return {
    kind: 'rows',
    label,
    columns: columns(cols),
    rows: (async function* () {
      yield rows as never;
    })(),
  } as ExportSourceSpec;
}

function users(): ExportSourceSpec {
  return table('users', ['id', 'email'], [[1, 'a@x.com']]);
}
function orders(): ExportSourceSpec {
  return table('orders', ['id', 'total'], [[10, '9.99']]);
}

/** Run an export into an in-memory stream and return what was written. */
async function exportToString(format: ExportFormat, sources: ExportSourceSpec[]): Promise<string> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  await runExport({
    connector: fakeConnector(),
    format,
    sources,
    destination: { kind: 'stream', stream: sink, end: true },
    consistentSnapshot: false,
    content: 'data',
  });
  return Buffer.concat(chunks).toString('utf8');
}

describe('multi-source exports into a single file', () => {
  it('refuses a CSV export of several tables', async () => {
    await expect(exportToString('csv', [users(), orders()])).rejects.toThrow(
      /CSV export covers one table/i,
    );
  });

  it('refuses a TSV export of several tables', async () => {
    await expect(exportToString('tsv', [users(), orders()])).rejects.toThrow(
      /TSV export covers one table/i,
    );
  });

  it('names the alternatives that do hold several tables', async () => {
    // The message is the whole value of the guard: a refusal that does not say
    // what to do instead just moves the dead end.
    await expect(exportToString('csv', [users(), orders()])).rejects.toThrow(/SQL|XLSX|archive/i);
  });

  it('still exports a single table as CSV', async () => {
    const out = await exportToString('csv', [users()]);
    expect(out).toContain('id,email');
    expect(out).toContain('a@x.com');
  });

  it('still concatenates several tables into one SQL script', async () => {
    const out = await exportToString('sql', [users(), orders()]);
    expect(out).toContain('INSERT INTO "users"');
    expect(out).toContain('INSERT INTO "orders"');
  });
});

describe('multi-source exports into a zip archive', () => {
  function collect(stream: PassThrough): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  it('puts one CSV per table into a single downloadable file', async () => {
    const sink = new PassThrough();
    const done = collect(sink);
    const result = await runExport({
      connector: fakeConnector(),
      format: 'csv',
      sources: [users(), orders()],
      destination: { kind: 'archive', stream: sink },
      consistentSnapshot: false,
      content: 'data',
    });

    const zip = await JSZip.loadAsync(await done);
    expect(Object.keys(zip.files).sort()).toEqual(['orders.csv', 'users.csv']);
    // Each entry keeps its own header: the defect the concatenated file had.
    expect(await zip.file('users.csv')!.async('string')).toBe('id,email\n1,a@x.com\n');
    expect(await zip.file('orders.csv')!.async('string')).toBe('id,total\n10,9.99\n');
    expect(result.tablesDone).toBe(2);
  });

  it('reports the archive size, not the sum of the entries', async () => {
    const sink = new PassThrough();
    const done = collect(sink);
    const result = await runExport({
      connector: fakeConnector(),
      format: 'csv',
      sources: [users(), orders()],
      destination: { kind: 'archive', stream: sink },
      consistentSnapshot: false,
      content: 'data',
    });

    expect(result.bytesOut).toBe((await done).length);
  });
});

describe('multi-source exports into a directory', () => {
  it('writes one CSV per table', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dbadmin-export-'));
    const result = await runExport({
      connector: fakeConnector(),
      format: 'csv',
      sources: [users(), orders()],
      destination: { kind: 'directory', path: dir, root: dir },
      consistentSnapshot: false,
      content: 'data',
    });

    const written = (await readdir(dir)).sort();
    expect(written).toEqual(['orders.csv', 'users.csv']);
    expect(result.tablesDone).toBe(2);

    const usersCsv = await readFile(path.join(dir, 'users.csv'), 'utf8');
    expect(usersCsv).toContain('id,email');
    expect(usersCsv).not.toContain('total');
  });
});
