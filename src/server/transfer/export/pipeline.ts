/**
 * The built-in streaming export pipeline (PLAN §7.4).
 *
 *     source        → transform      → writer        → [compress] → sink
 *     cursor/stream   type-encoding    CSV/JSON/SQL     gzip         file | HTTP response
 *
 * Every stage is a real Node stream and the whole chain runs through
 * `stream/promises.pipeline()`, so backpressure is genuine end to end: a slow
 * disk or a slow HTTP client pauses the writer, which pauses the row source,
 * which stops pulling from the database cursor. Memory stays flat regardless of
 * table size, and a result set is NEVER buffered.
 *
 * The sink is deliberately separable from the pump: a multi-table dump opens one
 * sink and pumps several sources through it (§7.5 wants one coherent file), so
 * the intermediate pipelines run with `{ end: false }` and only `close()` ends
 * the chain.
 *
 * Server-side only: no React, no Next (§11).
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable, Transform, type Duplex, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { CONFIG, resolveWithin } from '../../config';
import type { Row } from '../../../lib/wire';


/**
 * `pipeline()`'s array overload takes a fixed tuple shape, so TS resolves the
 * variadic form and rejects the trailing options object. Naming the array form
 * keeps `{ end }` / `{ signal }` working — both are load-bearing here: `end:false`
 * keeps one dump file open across several sources (§7.5).
 */
type PipelineArrayFn = (
  streams: readonly (Readable | Duplex | Writable)[],
  options?: { end?: boolean; signal?: AbortSignal },
) => Promise<void>;
const pipelineArray = pipeline as unknown as PipelineArrayFn;

export type CompressionKind = 'none' | 'gzip';

export type SinkSpec =
  /**
   * A file under an allowed root. The path is user-supplied, so it is confined
   * with `resolveWithin` before anything is opened (§7.2).
   */
  | { kind: 'file'; path: string; root?: string; overwrite?: boolean }
  /** An already-open Writable — an HTTP response, a socket, a test buffer. */
  | { kind: 'stream'; stream: Writable; end?: boolean };

export interface SinkOptions {
  compress?: CompressionKind;
  /** zlib level 0-9; 6 is the default trade-off. */
  gzipLevel?: number;
  /**
   * Keep a half-written file when the export fails. Off by default: a truncated
   * dump that looks complete is worse than no dump at all.
   */
  keepPartial?: boolean;
}

export interface SinkHandle {
  /** Head of the sink chain. Writer output is piped here. */
  readonly head: Writable;
  /** Absolute path, for file sinks. */
  readonly path?: string;
  /** Bytes actually written to the destination (post-compression). */
  bytesWritten(): number;
  /** Flush everything and close the destination. */
  close(): Promise<void>;
  /** Tear down and (unless keepPartial) delete the partial file. */
  abort(err?: unknown): Promise<void>;
}

/** Counts bytes as they pass; this is the `bytesOut` a job reports (§7.3). */
class ByteCounter extends Transform {
  bytes = 0;
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void): void {
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

/** Counts rows in `Row[]` chunks without touching them. */
class RowCounter extends Transform {
  rows = 0;
  constructor(private readonly onRows?: (rows: number) => void) {
    super({ objectMode: true, highWaterMark: 2 });
  }
  override _transform(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null, d?: unknown) => void): void {
    if (Array.isArray(chunk)) {
      this.rows += chunk.length;
      this.onRows?.(this.rows);
    }
    cb(null, chunk);
  }
}

/** Confine a user-supplied export path to the allowed root (§7.2). */
export function resolveExportPath(relative: string, root: string = CONFIG.exportRoot): string {
  return resolveWithin(root, relative);
}

/**
 * Build the [gzip →] counter → destination chain and hand back its head. The
 * chain's own pipeline runs for the lifetime of the export.
 */
export async function openSink(spec: SinkSpec, options: SinkOptions = {}): Promise<SinkHandle> {
  const compress = options.compress ?? 'none';
  const head = new PassThrough();
  const counter = new ByteCounter();
  const stages: (Duplex | Writable)[] = [head];
  if (compress === 'gzip') stages.push(createGzip({ level: options.gzipLevel ?? 6 }));
  stages.push(counter);

  let filePath: string | undefined;
  let destination: Writable;
  let endDestination = true;

  if (spec.kind === 'file') {
    filePath = resolveExportPath(spec.path, spec.root);
    await mkdir(path.dirname(filePath), { recursive: true });
    // 'wx' refuses to clobber an existing export when overwrite is off.
    destination = createWriteStream(filePath, { flags: spec.overwrite === false ? 'wx' : 'w' });
  } else {
    destination = spec.stream;
    endDestination = spec.end !== false;
  }
  stages.push(destination);

  const done = pipelineArray(stages, { end: endDestination });
  // The rejection is surfaced by close()/abort(); this only stops Node from
  // reporting it as unhandled in the window before that happens.
  done.catch(() => undefined);

  let settled = false;

  const removePartial = async (): Promise<void> => {
    if (!filePath || options.keepPartial) return;
    await rm(filePath, { force: true }).catch(() => undefined);
  };

  return {
    head,
    path: filePath,
    bytesWritten: () => counter.bytes,
    async close(): Promise<void> {
      if (settled) return;
      settled = true;
      head.end();
      try {
        await done;
      } catch (err) {
        await removePartial();
        throw err;
      }
    },
    async abort(err?: unknown): Promise<void> {
      if (settled) return;
      settled = true;
      head.destroy(err instanceof Error ? err : undefined);
      await done.catch(() => undefined);
      await removePartial();
    },
  };
}

export interface PumpOptions {
  /** Row batches, exactly as `SqlConnector.stream()` yields them. */
  source: AsyncIterable<Row[]> | Readable;
  /** A writer from ./writers or ./sql-writer: `Row[]` in, bytes out. */
  writer: Duplex;
  sink: SinkHandle;
  signal?: AbortSignal;
  /**
   * False when one writer serves several sources (an XLSX workbook with a sheet
   * per table). The caller must have called `attachWriter` first and must call
   * `finishWriter` when the last source is done.
   */
  endWriter?: boolean;
  /** Called as rows accumulate, for job progress (§7.3). */
  onRows?: (rows: number) => void;
}

/**
 * Connect a long-lived writer to the sink. Used only with `endWriter: false`;
 * the returned promise settles when the writer ends.
 */
export function attachWriter(writer: Duplex, sink: SinkHandle): Promise<void> {
  const p = pipeline([writer, sink.head], { end: false });
  p.catch(() => undefined);
  return p;
}

/** End a writer attached with `attachWriter` and wait for it to drain. */
export async function finishWriter(writer: Duplex, attached: Promise<void>): Promise<void> {
  writer.end();
  await attached;
}

/**
 * Run one source through the writer into the sink. Returns the number of rows
 * that passed through. Never buffers: the only thing held at a time is the
 * current `Row[]` batch.
 */
export async function pumpRows(options: PumpOptions): Promise<number> {
  const readable =
    options.source instanceof Readable
      ? options.source
      : Readable.from(options.source, { objectMode: true });
  const counter = new RowCounter(options.onRows);

  // `end: false` keeps the destination open for the next table (§7.5: one dump
  // file, several sources). Intermediate stages are still ended normally, so a
  // per-source writer flushes its footer before the next one starts.
  const stages: (Readable | Duplex | Writable)[] =
    options.endWriter === false
      ? [readable, counter, options.writer]
      : [readable, counter, options.writer, options.sink.head];

  await pipelineArray(stages, { end: false, signal: options.signal });
  return counter.rows;
}

export interface RunPipelineOptions extends SinkOptions {
  source: AsyncIterable<Row[]> | Readable;
  writer: Duplex;
  sink: SinkSpec;
  signal?: AbortSignal;
  onProgress?: (p: { rows: number; bytes: number }) => void;
  /** Minimum gap between progress callbacks. */
  progressIntervalMs?: number;
}

export interface PipelineResult {
  rows: number;
  bytes: number;
  path?: string;
}

/**
 * The single-source convenience form: open sink, pump, close. Multi-table
 * exports use `openSink` + repeated `pumpRows` instead so every table lands in
 * the same file.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  const sink = await openSink(options.sink, {
    compress: options.compress,
    gzipLevel: options.gzipLevel,
    keepPartial: options.keepPartial,
  });

  const interval = options.progressIntervalMs ?? 250;
  let lastEmit = 0;
  const emit = (rows: number, force = false): void => {
    if (!options.onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < interval) return;
    lastEmit = now;
    options.onProgress({ rows, bytes: sink.bytesWritten() });
  };

  try {
    const rows = await pumpRows({
      source: options.source,
      writer: options.writer,
      sink,
      signal: options.signal,
      onRows: (n) => emit(n),
    });
    await sink.close();
    emit(rows, true);
    return { rows, bytes: sink.bytesWritten(), path: sink.path };
  } catch (err) {
    await sink.abort(err);
    throw err;
  }
}
