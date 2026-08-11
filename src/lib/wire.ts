/**
 * The wire format (PLAN §6 "Type fidelity").
 *
 * Drivers lose data by default: BIGINT overflows JS numbers, NUMERIC loses
 * precision, dates get timezone-mangled, BLOBs become garbage. Every connector
 * therefore encodes non-trivial values into a tagged envelope carrying the
 * *lossless string* representation, and the UI decodes for display only.
 *
 * This module is shared by client and server and must stay free of any Node or
 * React imports.
 */

/** Normalized type families. Engine types map onto these; `raw` keeps the original. */
export type BaseType =
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'float'
  | 'string'
  | 'text'
  | 'binary'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'interval'
  | 'json'
  | 'uuid'
  | 'enum'
  | 'set'
  | 'array'
  | 'geometry'
  | 'network'
  | 'xml'
  | 'bit'
  | 'money'
  | 'objectid'
  | 'document'
  | 'unknown';

/** Tags for values that cannot survive as a plain JSON scalar. */
export type CellTag =
  | 'bigint'
  | 'decimal'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'timestamptz'
  | 'interval'
  | 'bytes'
  | 'json'
  | 'array'
  | 'geo'
  | 'uuid'
  | 'bit'
  | 'objectid'
  | 'decimal128'
  | 'regex'
  | 'document'
  | 'unsupported';

export interface TaggedCell {
  $t: CellTag;
  /** Lossless textual representation. Binary uses base64. */
  v: string;
  /** Optional element type for arrays, or subtype hints. */
  of?: string;
}

export type Cell = null | string | number | boolean | TaggedCell;

export type Row = Cell[];

export function isTagged(c: Cell): c is TaggedCell {
  return typeof c === 'object' && c !== null && '$t' in c;
}

export function tag($t: CellTag, v: string, of?: string): TaggedCell {
  return of === undefined ? { $t, v } : { $t, v, of };
}

/** Base64 without relying on Buffer, so this stays isomorphic. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesCell(bytes: Uint8Array): TaggedCell {
  return { $t: 'bytes', v: bytesToBase64(bytes) };
}

/**
 * Human-readable rendering for the grid. Never used for export or for building
 * SQL — those consume the lossless `v` directly.
 */
export function cellToDisplay(c: Cell): string {
  if (c === null) return 'NULL';
  if (typeof c === 'boolean') return c ? 'true' : 'false';
  if (typeof c === 'number') return String(c);
  if (typeof c === 'string') return c;
  switch (c.$t) {
    case 'bytes': {
      const bytes = base64ToBytes(c.v);
      const preview = Array.from(bytes.subarray(0, 8))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      return `[${bytes.length} bytes] ${preview}${bytes.length > 8 ? ' …' : ''}`;
    }
    case 'unsupported':
      return `<${c.of ?? 'unsupported'}>`;
    default:
      return c.v;
  }
}

/** The raw text used when exporting to a text format or copying a cell. */
export function cellToText(c: Cell, binaryEncoding: 'base64' | 'hex' = 'base64'): string | null {
  if (c === null) return null;
  if (typeof c === 'string') return c;
  if (typeof c === 'number' || typeof c === 'boolean') return String(c);
  if (c.$t === 'bytes') {
    if (binaryEncoding === 'base64') return c.v;
    const bytes = base64ToBytes(c.v);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return c.v;
}

export function isNullCell(c: Cell): boolean {
  return c === null;
}
