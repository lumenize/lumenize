import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error - cloudflare:test module types
import { env, type Env } from 'cloudflare:test';

/**
 * Tests for @lumenize/core - debug
 * 
 * TODO: Implement comprehensive tests for:
 * - Namespace filtering (wildcards, exclusions)
 * - Level filtering (debug, info, warn)
 * - JSON output format
 * - Enabled flag behavior
 * - Pattern matching edge cases
 * - Integration with LumenizeBase
 */

describe('@lumenize/core - debug', () => {
  let stub: DurableObjectStub<Env>;

  beforeEach(() => {
    stub = env.DEBUG_TEST_DO.get(env.DEBUG_TEST_DO.newUniqueId());
  });

  describe('Basic Logging', () => {
    it('logs at all levels', async () => {
      const result = await stub.testBasicLogging();
      expect(result.logged).toBe(true);
    });

    it('checks enabled flag', async () => {
      const result = await stub.testEnabledFlag();
      expect(result).toHaveProperty('enabled');
      expect(result.namespace).toBe('test.debug-do');
    });

    it('logs structured data', async () => {
      const result = await stub.testStructuredData();
      expect(result.processed).toBe(true);
    });
  });

  describe('Namespace Filtering', () => {
    it('matches exact namespace', async () => {
      const result = await stub.testNamespaceMatch('test.exact', 'test.exact', 'debug');
      expect(result.shouldLog).toBe(true);
    });

    it('matches with wildcard', async () => {
      const result = await stub.testNamespaceMatch('test.child', 'test', 'debug');
      expect(result.shouldLog).toBe(true);
    });

    it('matches with explicit wildcard (.*)', async () => {
      const result = await stub.testNamespaceMatch('test.child', 'test.*', 'debug');
      expect(result.shouldLog).toBe(true);
    });

    it('matches everything with *', async () => {
      const result = await stub.testNamespaceMatch('anything.goes', '*', 'debug');
      expect(result.shouldLog).toBe(true);
    });

    it('does not match different namespace', async () => {
      const result = await stub.testNamespaceMatch('other.namespace', 'test', 'debug');
      expect(result.shouldLog).toBe(false);
    });

    it('handles exclusion patterns', async () => {
      const result = await stub.testNamespaceMatch('test.verbose', 'test,-test.verbose', 'debug');
      expect(result.shouldLog).toBe(false);
    });
  });

  describe('Level Filtering', () => {
    it('debug level logs all', async () => {
      const resultDebug = await stub.testNamespaceMatch('test', 'test:debug', 'debug');
      const resultInfo = await stub.testNamespaceMatch('test', 'test:debug', 'info');
      const resultWarn = await stub.testNamespaceMatch('test', 'test:debug', 'warn');
      
      expect(resultDebug.shouldLog).toBe(true);
      expect(resultInfo.shouldLog).toBe(true);
      expect(resultWarn.shouldLog).toBe(true);
    });

    it('info level logs info and warn', async () => {
      const resultDebug = await stub.testNamespaceMatch('test', 'test:info', 'debug');
      const resultInfo = await stub.testNamespaceMatch('test', 'test:info', 'info');
      const resultWarn = await stub.testNamespaceMatch('test', 'test:info', 'warn');
      
      expect(resultDebug.shouldLog).toBe(false);
      expect(resultInfo.shouldLog).toBe(true);
      expect(resultWarn.shouldLog).toBe(true);
    });

    it('warn level logs warn only', async () => {
      const resultDebug = await stub.testNamespaceMatch('test', 'test:warn', 'debug');
      const resultInfo = await stub.testNamespaceMatch('test', 'test:warn', 'info');
      const resultWarn = await stub.testNamespaceMatch('test', 'test:warn', 'warn');
      
      expect(resultDebug.shouldLog).toBe(false);
      expect(resultInfo.shouldLog).toBe(false);
      expect(resultWarn.shouldLog).toBe(true);
    });

    it('no level filter logs all', async () => {
      const resultDebug = await stub.testNamespaceMatch('test', 'test', 'debug');
      const resultInfo = await stub.testNamespaceMatch('test', 'test', 'info');
      const resultWarn = await stub.testNamespaceMatch('test', 'test', 'warn');
      
      expect(resultDebug.shouldLog).toBe(true);
      expect(resultInfo.shouldLog).toBe(true);
      expect(resultWarn.shouldLog).toBe(true);
    });
  });

  describe('Pattern Matching Edge Cases', () => {
    it('handles empty filter (disabled)', async () => {
      const result = await stub.testNamespaceMatch('test', '', 'debug');
      expect(result.shouldLog).toBe(false);
    });

    it('handles multiple patterns', async () => {
      const result1 = await stub.testNamespaceMatch('test', 'test,other', 'debug');
      const result2 = await stub.testNamespaceMatch('other', 'test,other', 'debug');
      const result3 = await stub.testNamespaceMatch('unrelated', 'test,other', 'debug');
      
      expect(result1.shouldLog).toBe(true);
      expect(result2.shouldLog).toBe(true);
      expect(result3.shouldLog).toBe(false);
    });

    it('handles whitespace in filter', async () => {
      const result = await stub.testNamespaceMatch('test', 'test  other', 'debug');
      expect(result.shouldLog).toBe(true);
    });

    it('handles invalid level specifier (ignores invalid level)', async () => {
      // Invalid level is ignored, pattern still matches namespace
      const result = await stub.testNamespaceMatch('test', 'test:invalid', 'debug');
      expect(result.shouldLog).toBe(true);
    });

    it('handles colon without level (ignores empty level)', async () => {
      // Empty level is ignored, pattern still matches namespace
      const result = await stub.testNamespaceMatch('test', 'test:', 'debug');
      expect(result.shouldLog).toBe(true);
    });
  });
});

