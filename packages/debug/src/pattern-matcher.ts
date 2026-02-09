import type { DebugLevel } from './types';

/**
 * Parsed filter pattern
 */
interface ParsedPattern {
  /** The namespace pattern (without level) */
  pattern: string;
  /** The minimum level for this pattern (undefined = all levels) */
  level?: DebugLevel;
  /** Whether this is an exclusion pattern */
  exclude: boolean;
}

/**
 * Level hierarchy for filtering
 *
 * Note: 'error' level is included for completeness but is never actually filtered
 * (DebugLoggerImpl.error() bypasses all filter checks)
 */
const LEVEL_PRIORITY: Record<DebugLevel, number> = {
  'debug': 0, // Most verbose
  'info': 1,
  'warn': 2,
  'error': 3, // Never filtered in practice
};

/**
 * Parse a DEBUG environment variable value into patterns
 *
 * Examples:
 * - "proxy-fetch" -> match proxy-fetch and children
 * - "proxy-fetch:warn" -> match proxy-fetch, warn level only
 * - "-proxy-fetch.verbose" -> exclude this namespace
 * - "proxy-fetch,rpc" -> multiple patterns
 *
 * @param filter - Raw DEBUG value
 * @returns Array of parsed patterns
 */
export function parseDebugFilter(filter: string | undefined): ParsedPattern[] {
  if (!filter) return [];

  const patterns: ParsedPattern[] = [];

  // Split on comma or whitespace (npm debug uses both)
  const parts = filter.split(/[,\s]+/).filter(p => p.length > 0);

  for (const part of parts) {
    // Check for exclusion
    const exclude = part.startsWith('-');
    const cleaned = exclude ? part.slice(1) : part;

    // Check for level specifier (namespace:level)
    const colonIndex = cleaned.lastIndexOf(':');
    let pattern: string;
    let level: DebugLevel | undefined;

    if (colonIndex > 0) {
      pattern = cleaned.slice(0, colonIndex);
      const levelStr = cleaned.slice(colonIndex + 1);
      if (levelStr === 'debug' || levelStr === 'info' || levelStr === 'warn' || levelStr === 'error') {
        level = levelStr;
      }
    } else {
      pattern = cleaned;
    }

    // Store the pattern
    patterns.push({ pattern, level, exclude });
  }

  return patterns;
}

/**
 * Check if a namespace matches a pattern
 *
 * Rules:
 * - "proxy-fetch" matches "proxy-fetch", "proxy-fetch.serialization", etc.
 * - "proxy-fetch.*" same as above (explicit wildcard)
 * - "auth*" matches "auth", "auth.LumenizeAuth", etc. (npm debug compatibility)
 * - "*" matches everything
 * - Exact match has priority
 *
 * @param namespace - The namespace to test
 * @param pattern - The pattern to match against
 * @returns true if matches
 */
function namespaceMatches(namespace: string, pattern: string): boolean {
  // Exact match
  if (namespace === pattern) return true;

  // Wildcard match everything
  if (pattern === '*') return true;

  // Pattern ends with .* (explicit wildcard)
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return namespace === prefix || namespace.startsWith(prefix + '.');
  }

  // Trailing * without dot (npm debug compatibility): "auth*" matches "auth.LumenizeAuth.login"
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return namespace === prefix || namespace.startsWith(prefix) ;
  }

  // Implicit wildcard: "proxy-fetch" matches "proxy-fetch.serialization"
  return namespace.startsWith(pattern + '.');
}

/**
 * Check if a level should be logged based on the pattern's level filter
 *
 * If pattern specifies a level, only log at that level or higher priority.
 * Examples:
 * - pattern level: warn -> logs: warn only
 * - pattern level: info -> logs: info, warn
 * - pattern level: debug -> logs: debug, info, warn (all)
 * - pattern level: undefined -> logs all
 *
 * @param logLevel - The level being logged
 * @param patternLevel - The level filter from the pattern (undefined = all)
 * @returns true if should log
 */
function levelMatches(logLevel: DebugLevel, patternLevel?: DebugLevel): boolean {
  if (!patternLevel) return true; // No level filter = all levels

  // Log if the log level is >= pattern level (higher or equal priority)
  return LEVEL_PRIORITY[logLevel] >= LEVEL_PRIORITY[patternLevel];
}

/**
 * Check if a namespace + level should be logged based on the filter
 *
 * @param namespace - The namespace to check
 * @param level - The level to check
 * @param filter - Parsed DEBUG filter patterns
 * @returns true if should log
 */
export function shouldLog(
  namespace: string,
  level: DebugLevel,
  filter: ParsedPattern[]
): boolean {
  if (filter.length === 0) return false; // No filter = disabled

  let included = false;
  let excluded = false;

  // Check each pattern
  for (const { pattern, level: patternLevel, exclude } of filter) {
    if (!namespaceMatches(namespace, pattern)) continue;

    // Check level filter
    if (!levelMatches(level, patternLevel)) continue;

    if (exclude) {
      excluded = true;
    } else {
      included = true;
    }
  }

  // Exclusions override inclusions
  return included && !excluded;
}

/**
 * Create a matcher function from a DEBUG environment variable
 *
 * @param debugEnv - Value of DEBUG environment variable
 * @returns Function that checks if namespace+level should log
 */
export function createMatcher(debugEnv: string | undefined): (namespace: string, level: DebugLevel) => boolean {
  const patterns = parseDebugFilter(debugEnv);
  return (namespace: string, level: DebugLevel) => shouldLog(namespace, level, patterns);
}
