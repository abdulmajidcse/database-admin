/**
 * Parameter binding (docs/roadmap.md M10).
 *
 * Turns `… WHERE a = :id` plus `{ id: 7 }` into the statement the driver
 * actually wants — `$1` for Postgres, `?` for MySQL and SQLite — and the
 * ordered array to bind alongside it.
 *
 * The value never becomes SQL. That is the entire point, and it is why this
 * rewrites by *offset* using `findPlaceholders` rather than by regular
 * expression: the scanner has already skipped string literals, comments,
 * identifier quotes and dollar-quoted bodies, so a `:id` that is data stays
 * data, and a value containing `:b OR 1=1 --` is bound as characters.
 *
 * Connectors already accept `RunOpts.params` and every SQL connector honours
 * it (see `results.ts`), so nothing below this layer had to change.
 */

import type { EngineKind } from '../../../lib/schema-model';
import type { Cell } from '../../../lib/wire';
import { paramStyleFor } from './literal';
import { findPlaceholders, type SqlDialect } from './lexer';

export class BindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindError';
  }
}

export interface BoundStatement {
  sql: string;
  params: unknown[];
}

/**
 * Bind `values` into `sql`.
 *
 * Named placeholders are rewritten to the engine's own style. A statement that
 * already uses that style is passed through with `positional` as its params, so
 * someone who wrote `$1` by hand is not second-guessed.
 *
 * Mixing the two kinds is refused: their order against a single params array is
 * ambiguous, and resolving it the wrong way binds values to the wrong columns —
 * which no error would surface, because the statement still runs.
 */
export function bindStatement(
  sql: string,
  dialect: SqlDialect,
  engine: EngineKind,
  values: Record<string, Cell>,
  positional: Cell[] = [],
): BoundStatement {
  const found = findPlaceholders(sql, dialect);
  if (found.length === 0) return { sql, params: [] };

  const named = found.filter((p) => p.style === 'named');
  const rest = found.filter((p) => p.style !== 'named');

  if (named.length > 0 && rest.length > 0) {
    throw new BindError(
      'This statement mixes named (:name) and positional (? or $1) placeholders. ' +
        'Use one style so the order is unambiguous.',
    );
  }

  // Already positional: the caller supplies the array itself.
  if (named.length === 0) {
    // Nothing was supplied, so nothing is being parameterized here. Pass the
    // statement through exactly as written rather than refusing it — binding is
    // opt-in, and a `?` the user did not mean as a placeholder is the driver's
    // business, which is how it behaved before binding existed.
    if (positional.length === 0) return { sql, params: [] };
    // $n can repeat a number, so distinct ordinals is the count either way.
    const wanted = new Set(rest.map((p) => p.ordinal)).size;
    if (positional.length !== wanted) {
      throw new BindError(
        `This statement has ${wanted} parameter(s) but ${positional.length} value(s) were supplied.`,
      );
    }
    return { sql, params: positional };
  }

  const style = paramStyleFor(engine);
  const params: unknown[] = [];
  // Postgres placeholders can refer back, so a repeated name is bound once and
  // reused. `?` cannot, so the value is pushed again for each occurrence.
  const slotOf = new Map<string, number>();

  let out = '';
  let cursor = 0;

  for (const p of named) {
    const name = p.name as string;
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      throw new BindError(`No value was given for the parameter "${name}".`);
    }
    const value = values[name];

    let text: string;
    if (style === 'dollar') {
      let slot = slotOf.get(name);
      if (slot === undefined) {
        params.push(value);
        slot = params.length;
        slotOf.set(name, slot);
      }
      text = `$${slot}`;
    } else {
      params.push(value);
      text = '?';
    }

    out += sql.slice(cursor, p.start) + text;
    cursor = p.end;
  }
  out += sql.slice(cursor);

  return { sql: out, params };
}

/** Every distinct named parameter in a statement, in first-appearance order. */
export function parameterNames(sql: string, dialect: SqlDialect): string[] {
  const seen: string[] = [];
  for (const p of findPlaceholders(sql, dialect)) {
    if (p.style === 'named' && p.name && !seen.includes(p.name)) seen.push(p.name);
  }
  return seen;
}
