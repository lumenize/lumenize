import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debug, setDebugSink, clearDebugSink } from '../src/index';
import type { DebugLogOutput } from '../src/index';

describe('@lumenize/debug', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debug.reset();
    delete process.env.DEBUG;
    consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    debug.reset();
    delete process.env.DEBUG;
  });

  describe('basic functionality', () => {
    it('creates a logger with the given namespace', () => {
      const log = debug('test.namespace');
      expect(log.namespace).toBe('test.namespace');
    });

    it('is disabled by default when no DEBUG is set', () => {
      const log = debug('test.namespace');
      expect(log.enabled).toBe(false);
    });

    it('does not log when disabled', () => {
      const log = debug('test.namespace');
      log.debug('message');
      log.info('message');
      log.warn('message');
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('error() always logs even when disabled', () => {
      const log = debug('test.namespace');
      log.error('error message', { detail: 'value' });
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('error');
      expect(output.message).toBe('error message');
      expect(output.data.detail).toBe('value');
    });
  });

  describe('DEBUG environment variable', () => {
    it('enables logging for matching namespace', () => {
      process.env.DEBUG = 'test';
      debug.reset();
      const log = debug('test.namespace');
      expect(log.enabled).toBe(true);
    });

    it('logs when enabled', () => {
      process.env.DEBUG = '*';
      debug.reset();
      const log = debug('test.namespace');
      log.info('hello world', { key: 'value' });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.type).toBe('debug');
      expect(output.level).toBe('info');
      expect(output.namespace).toBe('test.namespace');
      expect(output.message).toBe('hello world');
      expect(output.data.key).toBe('value');
      expect(output.timestamp).toBeDefined();
    });

    it('respects namespace patterns', () => {
      process.env.DEBUG = 'app.auth';
      debug.reset();

      const authLog = debug('app.auth.login');
      const dbLog = debug('app.database');

      expect(authLog.enabled).toBe(true);
      expect(dbLog.enabled).toBe(false);
    });

    it('supports trailing * without dot (npm debug compatibility)', () => {
      process.env.DEBUG = 'auth*';
      debug.reset();

      const authLog = debug('auth.LumenizeAuth.login');
      const authExact = debug('auth');
      const otherLog = debug('other.thing');

      expect(authLog.enabled).toBe(true);
      expect(authExact.enabled).toBe(true);
      expect(otherLog.enabled).toBe(false);
    });

    it('respects exclusion patterns', () => {
      process.env.DEBUG = 'app,-app.verbose';
      debug.reset();

      const normalLog = debug('app.normal');
      const verboseLog = debug('app.verbose.detail');

      expect(normalLog.enabled).toBe(true);
      expect(verboseLog.enabled).toBe(false);
    });

    it('respects level filters', () => {
      process.env.DEBUG = 'app:warn';
      debug.reset();

      const log = debug('app.service');

      // Only warn+ should be enabled
      log.debug('debug message');
      log.info('info message');
      log.warn('warn message');

      // debug and info should not log (filtered)
      // warn should log
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('warn');
    });
  });

  describe('safe serialization', () => {
    it('handles circular references', () => {
      process.env.DEBUG = '*';
      debug.reset();
      const log = debug('test');

      const obj: any = { name: 'test' };
      obj.self = obj;

      log.info('circular object', obj);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.data.name).toBe('test');
      expect(output.data.self).toBe('[Circular]');
    });

    it('handles BigInt values', () => {
      process.env.DEBUG = '*';
      debug.reset();
      const log = debug('test');

      log.info('bigint value', { big: BigInt(12345) });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.data.big).toBe('12345n');
    });
  });

  // Pure serialization, so no running system is needed here. What Cloudflare's Workers Issues
  // makes of a line like this is measured on a deployed Worker in experiments/workers-issues.
  describe('Errors', () => {
    const lastLine = () => JSON.parse(consoleSpy.mock.calls.at(-1)![0]);

    it('writes an Error in data as its fields, not as {}', () => {
      const error = Object.assign(new Error('upstream 503'), { status: 503 });
      debug('test').error('pack delete failed', { host: 'h.example', error });

      const { data } = lastLine();
      expect(data.error).toMatchObject({ name: 'Error', message: 'upstream 503', status: 503 });
    });

    it('lifts the stack to the top level and does not repeat it in data', () => {
      const error = new Error('upstream 503');
      debug('test').error('pack delete failed', { error });

      const output = lastLine();
      expect(output.stack).toBe(error.stack);
      expect(output.data.error.stack).toBeUndefined();
      expect(output.message).toBe('pack delete failed');
    });

    it('lifts the stack when data is itself an Error', () => {
      const error = new TypeError('bad input');
      debug('test').error('parse failed', error);

      const output = lastLine();
      expect(output.stack).toBe(error.stack);
      expect(output.data).toEqual({ name: 'TypeError', message: 'bad input' });
    });

    it('keeps the stack of every Error it did not lift, causes included', () => {
      const cause = new Error('socket reset');
      const first = new Error('fetch failed', { cause });
      const second = new Error('retry failed');
      debug('test').error('delivery failed', { first, second });

      const output = lastLine();
      expect(output.stack).toBe(first.stack);
      expect(output.data.first.cause).toEqual({ name: 'Error', message: 'socket reset', stack: cause.stack });
      expect(output.data.second.stack).toBe(second.stack);
    });

    it('writes no stack when data holds no Error', () => {
      debug('test').error('pack delete failed', { error: 'upstream 503' });

      expect(lastLine().stack).toBeUndefined();
    });

    // A top-level stack makes Workers Issues treat a line as an error whatever its level, so a
    // warning would become an issue.
    it('lifts no stack below error level, and keeps it nested instead', () => {
      process.env.DEBUG = '*';
      debug.reset();
      const error = new Error('upstream 503');
      debug('test').warn('pack delete slow', { error });

      const output = lastLine();
      expect(output.stack).toBeUndefined();
      expect(output.data.error.stack).toBe(error.stack);
    });

    it('gives a sink entry the lifted stack', () => {
      const entries: DebugLogOutput[] = [];
      setDebugSink((e) => entries.push(e));
      try {
        const error = new Error('upstream 503');
        debug('test').error('pack delete failed', { error });
        expect(entries[0].stack).toBe(error.stack);
      } finally {
        clearDebugSink();
      }
    });
  });

  describe('log levels', () => {
    beforeEach(() => {
      process.env.DEBUG = '*';
      debug.reset();
    });

    it('logs at debug level', () => {
      const log = debug('test');
      log.debug('debug message');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('debug');
    });

    it('logs at info level', () => {
      const log = debug('test');
      log.info('info message');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('info');
    });

    it('logs at warn level', () => {
      const log = debug('test');
      log.warn('warn message');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('warn');
    });

    it('logs at error level', () => {
      const log = debug('test');
      log.error('error message');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('error');
    });
  });

  describe('test sink', () => {
    afterEach(() => {
      clearDebugSink();
    });

    it('captures all four levels and bypasses the DEBUG filter', () => {
      // DEBUG is unset (beforeEach deletes it), so without a sink the
      // filterable levels would be dropped — sink installation must bypass.
      const entries: DebugLogOutput[] = [];
      setDebugSink((e) => entries.push(e));

      const log = debug('test.sink');
      log.debug('d', { x: 1 });
      log.info('i');
      log.warn('w');
      log.error('e');

      expect(entries.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
      expect(entries[0].namespace).toBe('test.sink');
      expect(entries[0].message).toBe('d');
      expect(entries[0].data).toEqual({ x: 1 });
    });

    it('replaces console output (does not also write to console.debug)', () => {
      setDebugSink(() => {});

      const log = debug('test.sink');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('clearDebugSink restores default console behavior', () => {
      const entries: DebugLogOutput[] = [];
      setDebugSink((e) => entries.push(e));

      const log = debug('test.sink');
      log.warn('captured');
      expect(entries).toHaveLength(1);

      clearDebugSink();

      // After clearing, the DEBUG filter applies again. With DEBUG unset,
      // filterable levels are dropped, but `error()` still goes to console.
      log.warn('not-captured');
      expect(entries).toHaveLength(1);
      expect(consoleSpy).not.toHaveBeenCalled();

      log.error('to console');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.message).toBe('to console');
    });

    it('shares the sink across multiple debug() instances', () => {
      const entries: DebugLogOutput[] = [];
      setDebugSink((e) => entries.push(e));

      debug('alpha').info('from-alpha');
      debug('beta').warn('from-beta');

      expect(entries).toHaveLength(2);
      expect(entries[0].namespace).toBe('alpha');
      expect(entries[1].namespace).toBe('beta');
    });

    it('setDebugSink(null) is equivalent to clearDebugSink', () => {
      const entries: DebugLogOutput[] = [];
      setDebugSink((e) => entries.push(e));
      setDebugSink(null);

      debug('test').warn('should-not-capture');
      expect(entries).toHaveLength(0);
    });

    it('logger.enabled is true while a sink is installed', () => {
      const log = debug('test.sink');
      expect(log.enabled).toBe(false);

      setDebugSink(() => {});
      expect(log.enabled).toBe(true);

      clearDebugSink();
      expect(log.enabled).toBe(false);
    });
  });
});
