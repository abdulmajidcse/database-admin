/**
 * Run a `.sql` script (PLAN §7.1 "Restore a dump; run a `.sql` script", §12 M7
 * "SQL dump runner … that lexer plus progress").
 *
 * The whole point is that a dump does not fit in memory: a 40 GB mysqldump is a
 * normal thing to be handed. So the file is streamed, statements are split
 * incrementally with the shared lexer from `db/sql/lexer` (which already knows
 * about `DELIMITER`, dollar-quoting, comments and bang comments), executed one
 * at a time, and progress is reported by byte offset.
 *
 * Two details make the incremental split correct:
 *
 *  - Statement boundaries are *prefix-stable*: the lexer is a single forward
 *    pass, so appending more text can only extend the final chunk. Every
 *    statement except the last one in a buffer is therefore final, and the last
 *    one is carried over to the next round.
 *  - `DELIMITER` is client-side state that a fresh `splitStatements()` call does
 *    not know about. The delimiter in force for the carried-over statement is
 *    read back off the parse result and re-established by prefixing a synthetic
 *    `DELIMITER x` line, whose length is subtracted from every offset.
 *
 * Plain `pg_dump` output additionally embeds `COPY … FROM stdin;` blocks whose
 * data lines are *not* SQL; they are fed to the executor's `copyIn` when it has
 * one and skipped with a reported error when it does not — anything else would
 * try to run tab-separated data as statements (PLAN §7.5).
 *
 * Server-side only: no React, no Next (PLAN §11).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';

import { splitStatements } from '../../db/sql/lexer';
import type { SqlDialect, SqlStatement } from '../../db/sql/lexer';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface ScriptExecutor {
  readonly dialect: SqlDialect;
  /** Run one statement. Results are discarded: a dump produces none worth keeping. */
  exec(sql: string): Promise<void>;
  /**
   * Feed a `COPY … FROM stdin` data block. Postgres only; when absent, such
   * blocks are skipped and reported rather than mis-executed.
   */
  copyIn?(sql: string, data: AsyncIterable<string>): Promise<void>;
}

export interface RunScriptOptions {
  /** Keep going past a failing statement and collect it (PLAN §7.4). */
  continueOnError?: boolean;
  signal?: AbortSignal;
  encoding?: BufferEncoding;
  /** Stop collecting (not counting) errors past this many. */
  maxErrors?: number;
  /**
   * A statement has to be materialized to be executed, so an unterminated one
   * would otherwise grow until the process dies. 256 MiB is far past any real
   * extended-insert and small enough to fail loudly instead of swapping.
   */
  maxStatementBytes?: number;
  /** Parse and count without executing anything (PLAN §7.4 "dry run"). */
  dryRun?: boolean;
  onProgress?: (p: ScriptProgress) => void;
  log?: (line: string) => void;
}

export interface ScriptProgress {
  bytesDone: number;
  bytesTotal: number;
  statements: number;
  failed: number;
}

export interface ScriptError {
  /** 1-based statement index within the script. */
  index: number;
  /** 1-based line the statement starts on. */
  line: number;
  byteOffset: number;
  /** The statement, truncated — the report has to stay readable. */
  statement: string;
  message: string;
  code?: string;
}

export interface ScriptResult {
  statements: number;
  executed: number;
  failed: number;
  /** psql meta-commands and unsupported COPY blocks. */
  skipped: number;
  bytesTotal: number;
  durationMs: number;
  errors: ScriptError[];
}

const DEFAULT_MAX_STATEMENT_BYTES = 256 * 1024 * 1024;
const READ_CHUNK = 1 << 20;
/** Parse only once a reasonable amount of text has arrived. */
const MIN_PARSE_CHARS = 64 * 1024;

/** Thrown when `signal` aborts; the job manager maps it to status `cancelled`. */
export class ScriptCancelled extends Error {
  constructor() {
    super('Script run cancelled');
    this.name = 'ScriptCancelled';
  }
}

// ---------------------------------------------------------------------------
// Incremental splitting
// ---------------------------------------------------------------------------

interface ParsedStatement {
  text: string;
  /** 1-based line within the current buffer. */
  line: number;
  /** Offset of the statement's first character in the buffer. */
  start: number;
  /** Offset just past this statement's terminator — where a data block starts. */
  afterTerminator: number;
}

interface DrainResult {
  statements: ParsedStatement[];
  /** How much of the buffer is fully consumed by `statements`. */
  cut: number;
  /** The delimiter in force for whatever follows `cut`. */
  delimiter: string;
}

function afterTerminatorOf(buffer: string, stmt: SqlStatement): number {
  const idx = buffer.indexOf(stmt.delimiter, stmt.end);
  return idx < 0 ? stmt.end : idx + stmt.delimiter.length;
}

/**
 * Split what we have. Everything but the final statement is complete; at EOF
 * the final one is complete too.
 */
function drain(buffer: string, delimiter: string, dialect: SqlDialect, atEof: boolean): DrainResult {
  // Re-establish a non-default DELIMITER for this parse (see the file header).
  const prefix = dialect === 'mysql' && delimiter !== ';' ? `DELIMITER ${delimiter}\n` : '';
  const parsed = splitStatements(prefix + buffer, dialect);
  const shift = prefix.length;
  const prefixLines = prefix ? 1 : 0;

  if (parsed.length === 0) return { statements: [], cut: atEof ? buffer.length : 0, delimiter };

  const take = atEof ? parsed : parsed.slice(0, -1);
  const last = parsed[parsed.length - 1];
  const cut = atEof ? buffer.length : last.start - shift;
  // The lexer reports which terminator each statement ended under, so the
  // delimiter for the carried-over text needs no separate bookkeeping.
  const nextDelimiter = atEof ? delimiter : last.delimiter;

  const statements = take.map((s) => ({
    text: s.text,
    line: s.line - prefixLines,
    start: s.start - shift,
    afterTerminator: afterTerminatorOf(buffer, {
      ...s,
      start: s.start - shift,
      end: s.end - shift,
    }),
  }));
  return { statements, cut, delimiter: nextDelimiter };
}

const RE_COPY_STDIN = /^\s*COPY\b[\s\S]*\bFROM\s+STDIN\b/i;
const COPY_TERMINATOR = '\\.';

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}

// ---------------------------------------------------------------------------
// runSqlScript
// ---------------------------------------------------------------------------

/**
 * Execute a SQL script file against `executor`, sequentially, with progress by
 * byte offset. `.gz` scripts are decompressed on the fly, because that is how
 * our own export writes them (PLAN §7.1 "optional gzip streaming compression").
 */
export async function runSqlScript(
  path: string,
  executor: ScriptExecutor,
  opts: RunScriptOptions = {},
): Promise<ScriptResult> {
  const startedAt = Date.now();
  const compressed = /\.(gz|gzip)$/i.test(path);
  const bytesTotal = (await stat(path)).size;
  const encoding: BufferEncoding = opts.encoding ?? 'utf8';
  const maxStatementBytes = opts.maxStatementBytes ?? DEFAULT_MAX_STATEMENT_BYTES;
  const maxErrors = opts.maxErrors ?? 1000;

  const file = createReadStream(path, { highWaterMark: READ_CHUNK });
  const source: Readable = compressed ? file.pipe(createGunzip()) : file;
  const iterator = source[Symbol.asyncIterator]();
  const decoder = new StringDecoder(encoding);

  const errors: ScriptError[] = [];
  let pending = '';
  let delimiter = ';';
  let line = 1;
  let consumedBytes = 0;
  let statements = 0;
  let executed = 0;
  let failed = 0;
  let skipped = 0;
  let eof = false;
  let lastEmit = 0;

  const emit = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    opts.onProgress?.({
      // A compressed script can only report progress in compressed bytes;
      // an uncompressed one reports exactly how far the executor has got.
      bytesDone: compressed ? file.bytesRead : consumedBytes,
      bytesTotal,
      statements,
      failed,
    });
  };

  const checkAbort = (): void => {
    if (opts.signal?.aborted) throw new ScriptCancelled();
  };

  /** Pull one chunk. Returns false at end of input. */
  const fill = async (): Promise<boolean> => {
    const next = await iterator.next();
    if (next.done) {
      pending += decoder.end();
      eof = true;
      return false;
    }
    pending += decoder.write(next.value as Buffer);
    return true;
  };

  /** Drop `n` characters off the head of the buffer, keeping the counters true. */
  const consume = (n: number): void => {
    if (n <= 0) return;
    const text = pending.slice(0, n);
    line += countNewlines(text);
    consumedBytes += Buffer.byteLength(text, encoding);
    pending = pending.slice(n);
  };

  const record = (index: number, at: number, offset: number, text: string, err: unknown): void => {
    failed++;
    if (errors.length >= maxErrors) return;
    errors.push({
      index,
      line: at,
      byteOffset: offset,
      statement: truncate(text, 300),
      message: err instanceof Error ? err.message : String(err),
      code: typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : undefined,
    });
  };

  /**
   * Consume a `COPY … FROM stdin` data block, feeding it to the executor when
   * it can take one. Either way the block must leave the SQL buffer, or its
   * tab-separated rows would be parsed as statements.
   */
  const consumeCopyBlock = async (sql: string, feed: boolean): Promise<void> => {
    let finished = false;

    /** One data line including its newline, or null at the block terminator. */
    const nextLine = async (): Promise<string | null> => {
      for (;;) {
        checkAbort();
        const nl = pending.indexOf('\n');
        if (nl < 0) {
          if (eof) {
            finished = true;
            if (pending.length === 0) return null;
            // Unterminated block: hand over what is left rather than lose it.
            const tail = pending;
            consume(pending.length);
            return tail;
          }
          await fill();
          continue;
        }
        const raw = pending.slice(0, nl);
        const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (text === COPY_TERMINATOR) {
          consume(nl + 1);
          finished = true;
          return null;
        }
        const chunk = pending.slice(0, nl + 1);
        consume(nl + 1);
        return chunk;
      }
    };

    if (feed && executor.copyIn) {
      await executor.copyIn(
        sql,
        (async function* (): AsyncIterable<string> {
          for (;;) {
            const l = await nextLine();
            if (l === null) return;
            yield l;
          }
        })(),
      );
    }
    // Whether the executor consumed the block, part of it, or none of it, the
    // rest must leave the buffer or it would be parsed as SQL.
    while (!finished) {
      if ((await nextLine()) === null) break;
    }
  };

  try {
    // A BOM in a dump would become part of the first statement.
    while (!eof && pending.length === 0) await fill();
    if (pending.charCodeAt(0) === 0xfeff) pending = pending.slice(1);

    // Re-splitting the buffer on every 1 MiB chunk is O(n²) when one statement
    // spans many chunks, so the parse point backs off while no boundary is found
    // and resets as soon as one is.
    let parseAt = MIN_PARSE_CHARS;

    for (;;) {
      checkAbort();
      if (!eof && pending.length < parseAt) {
        await fill();
        continue;
      }
      const parsed = drain(pending, delimiter, executor.dialect, eof);

      if (parsed.statements.length === 0) {
        if (eof) break;
        if (Buffer.byteLength(pending, encoding) > maxStatementBytes) {
          throw new Error(
            `A single statement exceeded ${maxStatementBytes} bytes without a terminator — ` +
              `is the delimiter right, or is this file actually SQL?`,
          );
        }
        parseAt = Math.max(parseAt, pending.length) * 2;
        await fill();
        continue;
      }
      parseAt = MIN_PARSE_CHARS;

      let copyAt: { sql: string; offset: number } | null = null;
      for (const stmt of parsed.statements) {
        checkAbort();
        statements++;

        // psql meta-commands (`\connect`, `\encoding`) are client-side; there is
        // nothing to send and pretending otherwise fails on every line.
        if (stmt.text.startsWith('\\')) {
          skipped++;
          opts.log?.(`Skipped psql command at line ${line + stmt.line - 1}: ${truncate(stmt.text, 80)}`);
          continue;
        }

        if (RE_COPY_STDIN.test(stmt.text)) {
          copyAt = { sql: stmt.text, offset: stmt.afterTerminator };
          break;
        }

        if (opts.dryRun) {
          executed++;
          continue;
        }

        try {
          await executor.exec(stmt.text);
          executed++;
        } catch (err) {
          record(
            statements,
            line + stmt.line - 1,
            consumedBytes + Buffer.byteLength(pending.slice(0, stmt.start), encoding),
            stmt.text,
            err,
          );
          if (!opts.continueOnError) throw err;
        }
        emit(false);
      }

      if (copyAt) {
        // Re-sync the buffer to just past the COPY statement, then eat its data.
        consume(copyAt.offset);
        if (pending.startsWith('\n')) consume(1);
        else if (pending.startsWith('\r\n')) consume(2);

        const canFeed = !opts.dryRun && typeof executor.copyIn === 'function';
        if (!canFeed && !opts.dryRun) {
          skipped++;
          record(
            statements,
            line,
            consumedBytes,
            copyAt.sql,
            new Error(
              'This connection cannot restore a plain-format COPY block; re-export with INSERT statements or use the native pg_restore path (PLAN §7.5).',
            ),
          );
          if (!opts.continueOnError) throw new Error('COPY … FROM stdin is not supported by this executor');
        }
        try {
          await consumeCopyBlock(copyAt.sql, canFeed);
          if (canFeed) executed++;
        } catch (err) {
          record(statements, line, consumedBytes, copyAt.sql, err);
          if (!opts.continueOnError) throw err;
        }
        emit(false);
        continue;
      }

      consume(parsed.cut);
      delimiter = parsed.delimiter;
      emit(false);
      if (eof && pending.trim() === '') break;
    }
  } finally {
    source.destroy();
    file.destroy();
    emit(true);
  }

  return {
    statements,
    executed,
    failed,
    skipped,
    bytesTotal,
    durationMs: Date.now() - startedAt,
    errors,
  };
}

/**
 * The same incremental split, exposed without an executor: used by the preview
 * pane (how many statements is this file?) and by the tests.
 */
export async function* streamScriptStatements(
  path: string,
  dialect: SqlDialect,
  opts: { encoding?: BufferEncoding; signal?: AbortSignal } = {},
): AsyncIterable<{ text: string; line: number }> {
  const compressed = /\.(gz|gzip)$/i.test(path);
  const file = createReadStream(path, { highWaterMark: READ_CHUNK });
  const source: Readable = compressed ? file.pipe(createGunzip()) : file;
  const decoder = new StringDecoder(opts.encoding ?? 'utf8');
  const iterator = source[Symbol.asyncIterator]();

  let pending = '';
  let delimiter = ';';
  let line = 1;
  let eof = false;

  try {
    for (;;) {
      if (opts.signal?.aborted) throw new ScriptCancelled();
      if (!eof && pending.length < MIN_PARSE_CHARS) {
        const next = await iterator.next();
        if (next.done) {
          pending += decoder.end();
          eof = true;
        } else {
          pending += decoder.write(next.value as Buffer);
          continue;
        }
      }
      const parsed = drain(pending, delimiter, dialect, eof);
      if (parsed.statements.length === 0) {
        if (eof) break;
        const next = await iterator.next();
        if (next.done) {
          pending += decoder.end();
          eof = true;
        } else {
          pending += decoder.write(next.value as Buffer);
        }
        continue;
      }
      for (const stmt of parsed.statements) yield { text: stmt.text, line: line + stmt.line - 1 };
      const consumed = pending.slice(0, parsed.cut);
      line += countNewlines(consumed);
      pending = pending.slice(parsed.cut);
      delimiter = parsed.delimiter;
      if (eof && pending.trim() === '') break;
    }
  } finally {
    source.destroy();
    file.destroy();
  }
}
