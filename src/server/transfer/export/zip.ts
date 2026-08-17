/**
 * A ZIP archive sink for multi-table exports (PLAN §7.1 "Schema / database").
 *
 * A whole-database CSV export is one file per table — one header, one column
 * shape each — and an HTTP download is one response, so the only way to deliver
 * fifty CSVs is to wrap them. The directory destination writes them to disk; this
 * writes the same set into a single stream the browser saves as one file.
 *
 * Why `archiver` rather than a hand-rolled writer: ZIP stores sizes and offsets
 * as 32-bit fields, and a database export is exactly the workload that outgrows
 * them. compress-commons switches to ZIP64 on its own once an entry's offset or
 * the central directory passes 4 GB, or once there are more than 65535 entries
 * (`zip-archive-output-stream.js` `_hasZip64`). A hand-rolled writer would keep
 * writing 32-bit fields and produce an archive that unzips to silent garbage —
 * the same class of quiet corruption the concatenated-CSV guard exists to stop.
 *
 * Server-side only: no React, no Next (§11).
 */

import { PassThrough, type Writable } from 'node:stream';
import type archiverNs from 'archiver';

export interface ZipArchive {
  /**
   * Open an entry and return the stream its bytes go to. Entries are consumed in
   * the order they are opened, so close one before opening the next — which is
   * what the per-source export loop does anyway.
   */
  entry(name: string): PassThrough;
  /** Write the central directory and end the underlying stream. */
  finalize(): Promise<void>;
  /** Bytes written to the destination so far, for §7.3 job progress. */
  bytesWritten(): number;
}

export interface ZipOptions {
  /** zlib level 0-9. 6 is the usual trade-off; 0 stores without deflating. */
  level?: number;
}

/**
 * Loaded through a dynamic import, not a static one — and archiver is *also*
 * listed in `serverExternalPackages` (next.config.mjs). Both are load-bearing,
 * verified by removing each in turn: a static import fails even with the config
 * entry, and this dynamic import fails without it, because webpack still bundles
 * a literal specifier as an async chunk. Either way the symptom is the same and
 * gives nothing to debug from — the Next build worker dies with a bare SIGKILL
 * during "Creating an optimized production build".
 */
export async function createZipArchive(out: Writable, options: ZipOptions = {}): Promise<ZipArchive> {
  const archiver = ((await import('archiver')) as unknown as { default: typeof archiverNs }).default;
  const archive = archiver('zip', { zlib: { level: options.level ?? 6 } });
  archive.pipe(out);

  return {
    entry(name: string): PassThrough {
      const stream = new PassThrough();
      archive.append(stream, { name });
      return stream;
    },

    async finalize(): Promise<void> {
      // `finalize()` resolves once the last entry is queued, not once the bytes
      // have left — waiting on 'end' too is what makes `bytesWritten()` final and
      // stops the HTTP response closing mid-central-directory.
      const ended = new Promise<void>((resolve, reject) => {
        archive.on('end', () => resolve());
        archive.on('error', reject);
      });
      await archive.finalize();
      await ended;
    },

    bytesWritten(): number {
      return archive.pointer();
    },
  };
}
