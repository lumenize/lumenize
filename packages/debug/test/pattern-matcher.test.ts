import { describe, it, expect } from 'vitest';
import { parseDebugFilter, shouldLog, createMatcher } from '../src/pattern-matcher';
import type { DebugLevel } from '../src/types';

describe('parseDebugFilter', () => {
  it('handles empty/undefined filter', () => {
    expect(parseDebugFilter('')).toEqual([]);
    expect(parseDebugFilter(undefined)).toEqual([]);
  });

  it('parses single namespace', () => {
    const patterns = parseDebugFilter('proxy-fetch');
    expect(patterns).toEqual([
      { pattern: 'proxy-fetch', level: undefined, exclude: false }
    ]);
  });

  it('parses namespace with level', () => {
    const patterns = parseDebugFilter('proxy-fetch:warn');
    expect(patterns).toEqual([
      { pattern: 'proxy-fetch', level: 'warn', exclude: false }
    ]);
  });

  it('parses exclusion', () => {
    const patterns = parseDebugFilter('-proxy-fetch.verbose');
    expect(patterns).toEqual([
      { pattern: 'proxy-fetch.verbose', level: undefined, exclude: true }
    ]);
  });

  it('parses multiple patterns (comma)', () => {
    const patterns = parseDebugFilter('proxy-fetch,rpc');
    expect(patterns).toHaveLength(2);
    expect(patterns[0].pattern).toBe('proxy-fetch');
    expect(patterns[1].pattern).toBe('rpc');
  });

  it('parses wildcard', () => {
    const patterns = parseDebugFilter('*');
    expect(patterns).toEqual([
      { pattern: '*', level: undefined, exclude: false }
    ]);
  });

  it('handles whitespace', () => {
    const patterns = parseDebugFilter('proxy-fetch, rpc');
    expect(patterns).toHaveLength(2);
  });
});

describe('shouldLog', () => {
  it('returns false for empty filter', () => {
    expect(shouldLog('proxy-fetch', 'debug', [])).toBe(false);
  });

  it('matches exact namespace', () => {
    const filter = parseDebugFilter('proxy-fetch');
    expect(shouldLog('proxy-fetch', 'debug', filter)).toBe(true);
  });

  it('matches child namespace', () => {
    const filter = parseDebugFilter('proxy-fetch');
    expect(shouldLog('proxy-fetch.serialization', 'debug', filter)).toBe(true);
  });

  it('does not match unrelated namespace', () => {
    const filter = parseDebugFilter('proxy-fetch');
    expect(shouldLog('rpc', 'debug', filter)).toBe(false);
  });

  it('matches wildcard', () => {
    const filter = parseDebugFilter('*');
    expect(shouldLog('anything', 'debug', filter)).toBe(true);
    expect(shouldLog('anything.nested', 'debug', filter)).toBe(true);
  });

  it('respects exclusions', () => {
    const filter = parseDebugFilter('proxy-fetch,-proxy-fetch.verbose');
    expect(shouldLog('proxy-fetch', 'debug', filter)).toBe(true);
    expect(shouldLog('proxy-fetch.serialization', 'debug', filter)).toBe(true);
    expect(shouldLog('proxy-fetch.verbose', 'debug', filter)).toBe(false);
  });

  it('filters by level (warn only)', () => {
    const filter = parseDebugFilter('proxy-fetch:warn');
    expect(shouldLog('proxy-fetch', 'debug', filter)).toBe(false);
    expect(shouldLog('proxy-fetch', 'info', filter)).toBe(false);
    expect(shouldLog('proxy-fetch', 'warn', filter)).toBe(true);
  });

  it('filters by level (info and warn)', () => {
    const filter = parseDebugFilter('proxy-fetch:info');
    expect(shouldLog('proxy-fetch', 'debug', filter)).toBe(false);
    expect(shouldLog('proxy-fetch', 'info', filter)).toBe(true);
    expect(shouldLog('proxy-fetch', 'warn', filter)).toBe(true);
  });

  it('filters by level (all)', () => {
    const filter = parseDebugFilter('proxy-fetch:debug');
    expect(shouldLog('proxy-fetch', 'debug', filter)).toBe(true);
    expect(shouldLog('proxy-fetch', 'info', filter)).toBe(true);
    expect(shouldLog('proxy-fetch', 'warn', filter)).toBe(true);
  });

  it('no level filter enables all', () => {
    const filter = parseDebugFilter('proxy-fetch');
    expect(shouldLog('proxy-fetch', 'debug', filter)).toBe(true);
    expect(shouldLog('proxy-fetch', 'info', filter)).toBe(true);
    expect(shouldLog('proxy-fetch', 'warn', filter)).toBe(true);
  });

  it('handles explicit wildcard pattern', () => {
    const filter = parseDebugFilter('proxy-fetch.*');
    expect(shouldLog('proxy-fetch', 'debug', filter)).toBe(true);
    expect(shouldLog('proxy-fetch.serialization', 'debug', filter)).toBe(true);
  });
});

describe('createMatcher', () => {
  it('creates a working matcher', () => {
    const matcher = createMatcher('proxy-fetch:warn');
    expect(matcher('proxy-fetch', 'debug')).toBe(false);
    expect(matcher('proxy-fetch', 'warn')).toBe(true);
  });

  it('handles undefined filter', () => {
    const matcher = createMatcher(undefined);
    expect(matcher('anything', 'debug')).toBe(false);
  });

  it('handles wildcard', () => {
    const matcher = createMatcher('*');
    expect(matcher('anything', 'debug')).toBe(true);
  });
});

