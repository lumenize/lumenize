import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debug } from '../src/index';

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
});
