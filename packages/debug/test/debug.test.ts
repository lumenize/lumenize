import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debug } from '../src/index';

describe('@lumenize/debug', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debug.reset();
    consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    debug.reset();
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

  describe('debug.configure() for Workers', () => {
    it('enables logging for matching namespace', () => {
      debug.configure({ DEBUG: 'test' });
      const log = debug('test.namespace');
      expect(log.enabled).toBe(true);
    });

    it('logs when enabled', () => {
      debug.configure({ DEBUG: '*' });
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
      debug.configure({ DEBUG: 'app.auth' });

      const authLog = debug('app.auth.login');
      const dbLog = debug('app.database');

      expect(authLog.enabled).toBe(true);
      expect(dbLog.enabled).toBe(false);
    });

    it('respects exclusion patterns', () => {
      debug.configure({ DEBUG: 'app,-app.verbose' });

      const normalLog = debug('app.normal');
      const verboseLog = debug('app.verbose.detail');

      expect(normalLog.enabled).toBe(true);
      expect(verboseLog.enabled).toBe(false);
    });

    it('respects level filters', () => {
      debug.configure({ DEBUG: 'app:warn' });

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
      debug.configure({ DEBUG: '*' });
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
      debug.configure({ DEBUG: '*' });
      const log = debug('test');

      log.info('bigint value', { big: BigInt(12345) });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.data.big).toBe('12345n');
    });
  });

  describe('log levels', () => {
    beforeEach(() => {
      debug.configure({ DEBUG: '*' });
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

  describe('debug(doInstance) overload for DOs', () => {
    it('auto-configures from DO instance env', () => {
      // Simulate a DO instance with env
      const doInstance = { env: { DEBUG: 'mydo' } };

      // debug(doInstance) returns a factory function
      const logFactory = debug(doInstance);
      const log = logFactory('mydo.fetch');

      expect(log.enabled).toBe(true);
      expect(log.namespace).toBe('mydo.fetch');
    });

    it('works as class property initializer pattern', () => {
      // Simulate how it would be used in a DO class
      const mockDO = {
        env: { DEBUG: '*' },
      };

      // This is the pattern: #log = debug(this)('MyDO')
      const log = debug(mockDO)('MyDO');

      expect(log.enabled).toBe(true);
      log.info('test message');

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.namespace).toBe('MyDO');
    });

    it('works when env.DEBUG is undefined', () => {
      const doInstance = { env: {} as { DEBUG?: string } };

      const logFactory = debug(doInstance);
      const log = logFactory('mydo.fetch');

      // Should be disabled when DEBUG is not set
      expect(log.enabled).toBe(false);
    });
  });
});
