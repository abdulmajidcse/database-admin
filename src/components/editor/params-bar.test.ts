/**
 * Unit tests for bind-parameter input parsing (docs/roadmap.md M10).
 *
 * The bug worth a regression test: an integer beyond 2^53 must not be rounded
 * through a JS double. A rounded key does not error — it addresses a different
 * row, so `DELETE … WHERE id = :id` deletes the wrong one and reports success.
 */

import { describe, expect, it } from 'vitest';

import { parseParamInput } from './params-bar';

describe('parseParamInput', () => {
  it('keeps an integer too large for a double as lossless text', () => {
    expect(parseParamInput('9007199254740993')).toEqual({ $t: 'bigint', v: '9007199254740993' });
  });

  it('returns a plain number when it fits', () => {
    expect(parseParamInput('42')).toBe(42);
    expect(parseParamInput('-7')).toBe(-7);
  });

  it('keeps a decimal that would not survive the round trip', () => {
    expect(parseParamInput('0.1234567890123456789')).toEqual({
      $t: 'decimal',
      v: '0.1234567890123456789',
    });
  });

  it('returns a float when it round-trips exactly', () => {
    expect(parseParamInput('1.5')).toBe(1.5);
  });

  it('leaves non-numeric text alone', () => {
    expect(parseParamInput('abc')).toBe('abc');
    expect(parseParamInput('2024-01-01')).toBe('2024-01-01');
  });

  it('keeps an empty box as an empty string, not a number', () => {
    expect(parseParamInput('')).toBe('');
  });
});
