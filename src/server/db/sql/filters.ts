/**
 * ColumnFilter[] -> a parameterized WHERE clause (PLAN §6 "grid + filter bar",
 * §9 "parameterize everything the user didn't type").
 *
 * The user types *values*; we build the *structure*. Values therefore never
 * reach the SQL text — they come back as `params` for the driver to bind — and
 * column names go through `quoteIdent`, the §9 chokepoint. There is no code
 * path here that concatenates a user string into SQL.
 *
 * `sql` INCLUDES the leading `WHERE` keyword, and is the empty string when
 * there is nothing to filter, so call sites are simply:
 *
 *     const w = buildWhere(filters, engine, 'dollar');
 *     `SELECT * FROM ${qualified} ${w.sql} ORDER BY ...`
 */

import type { ColumnFilter } from '../types';
import type { EngineKind } from '../../../lib/schema-model';
import { quoteIdent, quoteLiteral } from './quote';

/** `?` for mysql2/better-sqlite3, `$1...$n` for pg. */
export type ParamStyle = 'qmark' | 'dollar';

export interface WhereClause {
  /** `WHERE ...`, or '' when no filter applies. */
  sql: string;
  params: unknown[];
}

export interface ConditionList {
  /** Individual predicates, already parameterized, to be joined with AND. */
  conditions: string[];
  params: unknown[];
}

/**
 * The escape character used in every generated LIKE. It is also MySQL's and
 * Postgres' default, but it is always stated explicitly so a pattern means the
 * same thing on all three engines.
 */
const LIKE_ESCAPE = '\\';

/**
 * Escape the LIKE metacharacters in a literal substring, so a value containing
 * `%` or `_` matches itself instead of matching everything. The escape
 * character is escaped first, or a `\` in the data would eat the next char.
 */
export function escapeLikePattern(value: string, escapeChar: string = LIKE_ESCAPE): string {
  return value
    .split(escapeChar)
    .join(escapeChar + escapeChar)
    .split('%')
    .join(escapeChar + '%')
    .split('_')
    .join(escapeChar + '_');
}

type ComparisonOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';

const COMPARISON: Record<ComparisonOp, string> = {
  eq: '=',
  ne: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/** Accumulates bound values and hands back the placeholder for each one. */
class ParamBag {
  readonly values: unknown[] = [];
  constructor(
    private readonly style: ParamStyle,
    private readonly startIndex: number,
  ) {}

  next(value: unknown): string {
    this.values.push(value);
    return this.style === 'dollar' ? `$${this.startIndex + this.values.length - 1}` : '?';
  }
}

function requireValue(f: ColumnFilter, which: 'value' | 'value2'): string {
  const v = f[which];
  if (v === undefined || v === null) {
    // Silently dropping a filter would show the user MORE rows than they asked
    // for, which is the dangerous direction — fail loudly instead.
    throw new Error(`Filter on "${f.column}" with operator "${f.op}" is missing ${which}`);
  }
  return v;
}

/**
 * Build the individual predicates. Exposed separately so a connector can AND in
 * the raw `where` text from `TableReadRequest` without re-parsing our output.
 *
 * `startIndex` is the number of the first `$n` placeholder, for callers that
 * already bound parameters earlier in the statement.
 */
export function buildConditions(
  filters: ColumnFilter[],
  engine: EngineKind,
  paramStyle: ParamStyle,
  startIndex = 1,
): ConditionList {
  const bag = new ParamBag(paramStyle, startIndex);
  const conditions: string[] = [];

  for (const f of filters) {
    const col = quoteIdent(f.column, engine);

    switch (f.op) {
      case 'eq':
      case 'ne':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
        conditions.push(`${col} ${COMPARISON[f.op]} ${bag.next(requireValue(f, 'value'))}`);
        break;

      case 'isNull':
        conditions.push(`${col} IS NULL`);
        break;

      case 'isNotNull':
        conditions.push(`${col} IS NOT NULL`);
        break;

      case 'between': {
        const lo = requireValue(f, 'value');
        const hi = requireValue(f, 'value2');
        conditions.push(`${col} BETWEEN ${bag.next(lo)} AND ${bag.next(hi)}`);
        break;
      }

      case 'in': {
        const values = f.values ?? (f.value === undefined ? [] : [f.value]);
        if (values.length === 0) {
          // `IN ()` is a syntax error everywhere, and an empty set genuinely
          // matches nothing — the safe direction for a filter.
          conditions.push('1 = 0');
          break;
        }
        const holes = values.map((v) => bag.next(v)).join(', ');
        conditions.push(`${col} IN (${holes})`);
        break;
      }

      case 'contains':
      case 'startsWith':
      case 'endsWith': {
        const raw = escapeLikePattern(requireValue(f, 'value'));
        const pattern =
          f.op === 'contains' ? `%${raw}%` : f.op === 'startsWith' ? `${raw}%` : `%${raw}`;
        // Case sensitivity follows the column collation (MySQL is usually
        // case-insensitive, Postgres is not); plain LIKE keeps the filter bar
        // consistent with how the engine compares text everywhere else.
        conditions.push(
          `${col} LIKE ${bag.next(pattern)} ESCAPE ${quoteLiteral(LIKE_ESCAPE, engine)}`,
        );
        break;
      }

      default: {
        // Exhaustiveness: adding a FilterOperator without handling it here is a
        // compile error, not a silently ignored filter.
        const unsupported: never = f.op;
        throw new Error(`Unsupported filter operator: ${String(unsupported)}`);
      }
    }
  }

  return { conditions, params: bag.values };
}

/**
 * The full clause, `WHERE` keyword included, or '' when `filters` is empty.
 * Predicates are ANDed, matching the grid's filter bar where each column
 * narrows the result further.
 */
export function buildWhere(
  filters: ColumnFilter[],
  engine: EngineKind,
  paramStyle: ParamStyle,
  startIndex = 1,
): WhereClause {
  const { conditions, params } = buildConditions(filters, engine, paramStyle, startIndex);
  return {
    sql: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`,
    params,
  };
}
