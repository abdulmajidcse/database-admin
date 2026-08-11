/**
 * pg-copy-streams ships no type declarations.
 *
 * This is the whole surface we use: COPY … FROM STDIN is the Postgres import
 * fast path (PLAN §7.4), and COPY … TO STDOUT backs the streaming export.
 */
declare module 'pg-copy-streams' {
  import type { Readable, Writable } from 'node:stream';

  /** COPY … FROM STDIN — pipe rows in. */
  export function from(sql: string, options?: unknown): Writable;

  /** COPY … TO STDOUT — stream rows out. */
  export function to(sql: string, options?: unknown): Readable;

  const _default: { from: typeof from; to: typeof to };
  export default _default;
}
