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

  // When a source fails the export loop destroys that entry's stream, and an
  // 'error' event with no listener is an uncaught exception — one bad table in a
  // fifty-table download took the whole server process down instead of
  // truncating that one response.
  //
  // BOTH emitters need covering. archiver re-emits an entry's error on itself,
  // but only once it has dequeued that entry and attached its own listener; an
  // entry destroyed while still queued emits with nothing listening at all. The
  // queue then never fires the append callback either, so a `finalize()` waiting
  // on 'end' hangs for ever — hence the race below rather than a bare await.
  let failure: Error | null = null;
  let signalFailure: (err: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    signalFailure = (err: Error) => {
      failure ??= err;
      reject(err);
    };
  });
  // The race may settle on the success side, leaving this rejection unclaimed;
  // handling it here keeps that from surfacing as an unhandled rejection.
  failed.catch(() => undefined);
  archive.on('error', signalFailure);

  archive.pipe(out);

  return {
    entry(name: string): PassThrough {
      const stream = new PassThrough();
      // Attached before `append`, so an entry destroyed while still queued is
      // still heard.
      stream.on('error', signalFailure);
      archive.append(stream, { name });
      return stream;
    },

    async finalize(): Promise<void> {
      if (failure) throw failure;
      // `finalize()` resolves once the last entry is queued, not once the bytes
      // have left — waiting on 'end' too is what makes `bytesWritten()` final and
      // stops the HTTP response closing mid-central-directory. Raced against the
      // failure so a dead entry surfaces as a rejection rather than a hang.
      const ended = new Promise<void>((resolve) => {
        archive.on('end', () => resolve());
      });
      await Promise.race([
        (async () => {
          await archive.finalize();
          await ended;
        })(),
        failed,
      ]);
    },

    bytesWritten(): number {
      return archive.pointer();
    },
  };
}
