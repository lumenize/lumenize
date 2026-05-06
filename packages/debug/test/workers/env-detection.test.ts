import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debug } from '../../src/index';

// wrangler.jsonc sets DEBUG = "lmz.test*,-lmz.test.silenced".
// These tests verify the cloudflare:workers env auto-detection picks that up
// without any manual configuration in user code.

describe('@lumenize/debug — Workers env.DEBUG auto-detection', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debug.reset();
    consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    debug.reset();
  });

  it('enables logging for namespaces matching env.DEBUG', () => {
    expect(debug('lmz.test').enabled).toBe(true);
    expect(debug('lmz.test.foo').enabled).toBe(true);
    expect(debug('lmz.test.deeply.nested').enabled).toBe(true);
  });

  it('respects exclusion patterns from env.DEBUG', () => {
    expect(debug('lmz.test.silenced').enabled).toBe(false);
    expect(debug('lmz.test.silenced.deep').enabled).toBe(false);
  });

  it('disables logging for namespaces not matching env.DEBUG', () => {
    expect(debug('other').enabled).toBe(false);
    expect(debug('lmz.other').enabled).toBe(false);
  });

  it('emits log output when env.DEBUG matches', () => {
    const log = debug('lmz.test.worker');
    log.info('hello from workers', { runtime: 'cloudflare' });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('info');
    expect(output.namespace).toBe('lmz.test.worker');
    expect(output.message).toBe('hello from workers');
    expect(output.data.runtime).toBe('cloudflare');
  });

  it('error() always logs even when env.DEBUG excludes the namespace', () => {
    const log = debug('lmz.test.silenced');
    expect(log.enabled).toBe(false);

    log.error('forced through', { code: 'E_FORCED' });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('error');
    expect(output.data.code).toBe('E_FORCED');
  });
});
