import { describe, it, expect, vi } from 'vitest';
import { DebugLoggerImpl } from '../src/logger';
import type { DebugLogOutput } from '../src/types';

describe('DebugLoggerImpl', () => {
  it('creates logger with namespace', () => {
    const logger = new DebugLoggerImpl({
      namespace: 'test',
      shouldLog: () => true,
    });
    
    expect(logger.namespace).toBe('test');
  });

  it('reports enabled when any level is enabled', () => {
    const logger = new DebugLoggerImpl({
      namespace: 'test',
      shouldLog: (ns, level) => level === 'warn',
    });
    
    expect(logger.enabled).toBe(true);
  });

  it('reports disabled when no levels enabled', () => {
    const logger = new DebugLoggerImpl({
      namespace: 'test',
      shouldLog: () => false,
    });
    
    expect(logger.enabled).toBe(false);
  });

  it('does not log when disabled', () => {
    const output = vi.fn();
    const logger = new DebugLoggerImpl({
      namespace: 'test',
      shouldLog: () => false,
      output,
    });
    
    logger.debug('message');
    logger.info('message');
    logger.warn('message');
    
    expect(output).not.toHaveBeenCalled();
  });

  it('logs debug when enabled', () => {
    const output = vi.fn();
    const logger = new DebugLoggerImpl({
      namespace: 'test',
      shouldLog: () => true,
      output,
    });
    
    logger.debug('test message', { foo: 'bar' });
    
    expect(output).toHaveBeenCalledOnce();
    const log = output.mock.calls[0][0] as DebugLogOutput;
    expect(log.type).toBe('debug');
    expect(log.level).toBe('debug');
    expect(log.namespace).toBe('test');
    expect(log.message).toBe('test message');
    expect(log.data).toEqual({ foo: 'bar' });
    expect(log.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  });

  it('logs info when enabled', () => {
    const output = vi.fn();
    const logger = new DebugLoggerImpl({
      namespace: 'test',
      shouldLog: () => true,
      output,
    });
    
    logger.info('info message');
    
    expect(output).toHaveBeenCalledOnce();
    const log = output.mock.calls[0][0] as DebugLogOutput;
    expect(log.level).toBe('info');
    expect(log.message).toBe('info message');
  });

  it('logs warn when enabled', () => {
    const output = vi.fn();
    const logger = new DebugLoggerImpl({
      namespace: 'test',
      shouldLog: () => true,
      output,
    });
    
    logger.warn('warn message');
    
    expect(output).toHaveBeenCalledOnce();
    const log = output.mock.calls[0][0] as DebugLogOutput;
    expect(log.level).toBe('warn');
    expect(log.message).toBe('warn message');
  });

  it('omits data field when undefined', () => {
    const output = vi.fn();
    const logger = new DebugLoggerImpl({
      namespace: 'test',
      shouldLog: () => true,
      output,
    });
    
    logger.debug('message only');
    
    const log = output.mock.calls[0][0] as DebugLogOutput;
    expect(log.data).toBeUndefined();
  });

  it('respects level-specific filtering', () => {
    const output = vi.fn();
    const logger = new DebugLoggerImpl({
      namespace: 'test',
      shouldLog: (ns, level) => level === 'warn',
      output,
    });
    
    logger.debug('should not log');
    logger.info('should not log');
    logger.warn('should log');
    
    expect(output).toHaveBeenCalledOnce();
    const log = output.mock.calls[0][0] as DebugLogOutput;
    expect(log.level).toBe('warn');
  });

  it('uses default console.debug output when not provided', () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    
    const logger = new DebugLoggerImpl({
      namespace: 'test',
      shouldLog: () => true,
    });
    
    logger.debug('test');
    
    expect(consoleSpy).toHaveBeenCalledOnce();
    const arg = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.type).toBe('debug');
    expect(parsed.namespace).toBe('test');
    
    consoleSpy.mockRestore();
  });
});

