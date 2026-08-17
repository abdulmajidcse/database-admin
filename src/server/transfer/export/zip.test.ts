/**
 * The ZIP archive sink (PLAN §7.1 "Schema / database" export as CSV).
 *
 * A whole-database CSV export is one file per table, and the only way to hand a
 * browser many files over one HTTP response is an archive. These tests read the
 * bytes back with an independent unzip implementation rather than asserting on
 * the writer's own bookkeeping — a zip that only this module can read would pass
 * a structural test and still be useless to the person who downloaded it.
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import { createZipArchive } from './zip';

/** Collect a stream into one buffer. */
function collect(stream: PassThrough): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Write `entries` through a fresh archive and return the finished zip bytes. */
async function buildZip(entries: [string, string][]): Promise<Buffer> {
  const out = new PassThrough();
  const done = collect(out);
  const archive = await createZipArchive(out);
  for (const [name, body] of entries) {
    const entry = archive.entry(name);
    entry.end(body);
    await new Promise((r) => entry.on('close', r));
  }
  await archive.finalize();
  return done;
}

describe('createZipArchive', () => {
  it('produces an archive a standard unzip can read', async () => {
    const zip = await buildZip([['users.csv', 'id,email\n1,a@x.com\n']]);

    const read = await JSZip.loadAsync(zip);
    expect(Object.keys(read.files)).toEqual(['users.csv']);
    expect(await read.file('users.csv')!.async('string')).toBe('id,email\n1,a@x.com\n');
  });

  it('keeps several tables as separate entries', async () => {
    const zip = await buildZip([
      ['users.csv', 'id,email\n1,a@x.com\n'],
      ['orders.csv', 'id,total\n10,9.99\n'],
      ['products.csv', 'sku,name\nA1,Widget\n'],
    ]);

    const read = await JSZip.loadAsync(zip);
    expect(Object.keys(read.files).sort()).toEqual(['orders.csv', 'products.csv', 'users.csv']);
    // Each entry keeps its own header — the whole point of not concatenating.
    expect(await read.file('orders.csv')!.async('string')).toBe('id,total\n10,9.99\n');
    expect(await read.file('users.csv')!.async('string')).toBe('id,email\n1,a@x.com\n');
  });

  it('round-trips content large enough to span deflate blocks', async () => {
    // A single small entry can pass by accident; a multi-chunk body exercises
    // the streaming path a real table export actually takes.
    const body = Array.from({ length: 5000 }, (_, i) => `${i},row-${i}`).join('\n');
    const zip = await buildZip([['big.csv', body]]);

    const read = await JSZip.loadAsync(zip);
    expect(await read.file('big.csv')!.async('string')).toBe(body);
  });

  it('reports the bytes it wrote', async () => {
    const out = new PassThrough();
    const done = collect(out);
    const archive = await createZipArchive(out);
    const entry = archive.entry('a.csv');
    entry.end('hello');
    await new Promise((r) => entry.on('close', r));
    await archive.finalize();

    const bytes = (await done).length;
    expect(archive.bytesWritten()).toBe(bytes);
    expect(bytes).toBeGreaterThan(0);
  });
});
