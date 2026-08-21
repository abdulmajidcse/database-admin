/**
 * Cell → SQL literal, and the value to bind alongside it (PLAN §6).
 *
 * Split out of `changeset.ts` so it can load in the browser. The grid's
 * "copy as INSERT" and the object tree's "generate SQL" both need literal text
 * (docs/roadmap.md M10), and pulling them in through `changeset.ts` dragged
 * `node:buffer` into the client bundle and broke `next build`.
 *
 * There is still exactly one decoder. What changed is where the driver's
 * `Buffer` is applied: bytes come out of here as a `Uint8Array`, and
 * `changeset.ts` wraps them at the server boundary, which is the only place
 * that talks to pg, mysql2 and better-sqlite3.
 */

import type { EngineKind } from '../../../lib/schema-model';
import type { Cell } from '../../../lib/wire';
import { base64ToBytes } from '../../../lib/wire';
import type { ParamStyle } from './filters';
import type { QuoteFns } from './quote';

/** Hex without Buffer, so this module stays isomorphic. */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Postgres numbers its placeholders; everyone else uses `?`. */
export function paramStyleFor(engine: EngineKind): ParamStyle {
  return engine === 'postgres' ? 'dollar' : 'qmark';
}

export class UnwritableCellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnwritableCellError';
  }
}

export interface DecodedCell {
  /** SQL literal text for this value. */
  sql: string;
  /** Value to bind. Never a JS number for bigint/decimal — always the string. */
  param: unknown;
}

export const NUMERIC_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/** ANSI fallback used when no engine-specific quoter was supplied. */
function ansiLiteral(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

function literalText(
  value: string | number | boolean | null,
  quote: QuoteFns | undefined,
): string {
  if (value === null) return 'NULL';
  if (quote) return quote.literal(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  return ansiLiteral(value);
}

/**
 * `bytea` uses the hex input format, which contains a backslash and therefore
 * has to go through the literal quoter so the `standard_conforming_strings`
 * question is answered in exactly one place (see quote.ts). Every other engine
 * takes the ANSI `X'…'` blob literal.
 */
function bytesLiteral(bytes: Uint8Array, engine: EngineKind | undefined, quote?: QuoteFns): string {
  const hex = toHex(bytes);
  if (engine === 'postgres') return quote ? quote.literal(`\\x${hex}`) : `'\\x${hex}'`;
  return `X'${hex}'`;
}

/** Postgres array output syntax, for the preview only. */
function pgArrayText(items: unknown[]): string {
  const parts = items.map((item) => {
    if (item === null || item === undefined) return 'NULL';
    if (Array.isArray(item)) return pgArrayText(item);
    const text =
      typeof item === 'object' && item !== null && '$t' in (item as Record<string, unknown>)
        ? String((item as { v: string }).v)
        : String(item);
    return `"${text.split('\\').join('\\\\').split('"').join('\\"')}"`;
  });
  return `{${parts.join(',')}}`;
}

function decodeCell(cell: Cell, engine: EngineKind | undefined, quote?: QuoteFns): DecodedCell {
  // `typeof` rather than `=== undefined` because `Cell` has no undefined member;
  // the guard exists for values that reached us from untyped JSON.
  if (cell === null || typeof cell === 'undefined') return { sql: 'NULL', param: null };

  if (typeof cell === 'boolean') {
    // better-sqlite3 refuses to bind a JS boolean (it binds numbers, strings,
    // bigints, buffers and null only), so SQLite gets 1/0 — the same thing it
    // stores anyway, since it has no boolean type.
    return { sql: literalText(cell, quote), param: engine === 'sqlite' ? (cell ? 1 : 0) : cell };
  }

  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) {
      throw new UnwritableCellError(`${String(cell)} has no portable SQL representation`);
    }
    return { sql: String(cell), param: cell };
  }

  if (typeof cell === 'string') return { sql: literalText(cell, quote), param: cell };

  switch (cell.$t) {
    case 'unsupported':
      // The read path could not represent this value losslessly, so writing it
      // back would corrupt it. Refuse rather than guess (§6 type fidelity).
      throw new UnwritableCellError(
        `a value of type "${cell.of ?? 'unknown'}" was not decoded losslessly and cannot be written back`,
      );

    case 'bytes': {
      // A Uint8Array here, not a Buffer: this module has to load in the
      // browser. changeset.ts wraps it for the drivers at the server boundary.
      const bytes = base64ToBytes(cell.v);
      return { sql: bytesLiteral(bytes, engine, quote), param: bytes };
    }

    case 'bigint':
    case 'decimal':
    case 'decimal128': {
      // NEVER Number(cell.v): that is exactly the precision loss the wire
      // format exists to prevent (§6). The lossless string is bound as-is and
      // every engine applies the target column's type to it.
      const text = cell.v.trim();
      return { sql: NUMERIC_TEXT.test(text) ? text : literalText(cell.v, quote), param: cell.v };
    }

    case 'array': {
      // `v` is JSON text (see the connectors' array encoding). node-postgres
      // builds a correct `{…}` literal from a real JS array, including nesting
      // and embedded quotes; other engines have no array type, so the text form
      // is the only sensible parameter.
      if (engine === 'postgres') {
        let items: unknown[] | null = null;
        try {
          const parsed: unknown = JSON.parse(cell.v);
          if (Array.isArray(parsed)) items = parsed;
        } catch {
          items = null;
        }
        if (items) {
          return {
            sql: literalText(pgArrayText(items), quote),
            param: items.map((item) => decodeCell(item as Cell, engine, quote).param),
          };
        }
      }
      return { sql: literalText(cell.v, quote), param: cell.v };
    }

    default:
      // date / time / timestamp / timestamptz / interval / json / uuid / bit /
      // geo / objectid / regex / document: the lossless text is bound and the
      // engine coerces it using the target column's input function. An untyped
      // literal does the same thing in the rendered form, so no cast is needed
      // — and an explicit one would be wrong as often as it was right (jsonb vs
      // json, timestamptz vs timestamp).
      return { sql: literalText(cell.v, quote), param: cell.v };
  }
}
/**
 * Public entry point (PLAN §6). Pass the engine's quoter to get engine-exact
 * literal text; without it the literals are plain ANSI, which is enough for
 * logging but not for a preview pane.
 */
export function decodeCellForSql(cell: Cell, quote?: QuoteFns): DecodedCell {
  return decodeCell(cell, quote?.engine, quote);
}

export { decodeCell };
