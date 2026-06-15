/**
 * createNebulaClient config resolution (jsdom) — the PURE auto-detect/defaults
 * layer, unit-testable without opening a connection. The full createNebulaClient
 * (construct → connect → `ready`) is a real-Star/browser integration probe
 * (§5.3.8 / P10); `ready`'s first-connect terminal-reject pairs with P9.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveNebulaClientConfig } from '../../src/frontend/create-nebula-client';
import type { OntologyStaleInfo } from '../../src/nebula-client';

const STALE: OntologyStaleInfo = { reason: 'ontology-stale', clientVersion: 'v1', currentVersion: 'v2' };

describe('resolveNebulaClientConfig', () => {
  it('requires appVersion', () => {
    expect(() => resolveNebulaClientConfig({ authScope: 'a.b.c' } as never)).toThrow(/appVersion/);
  });

  it('throws a clear error when authScope is omitted (URL auto-detect deferred)', () => {
    expect(() => resolveNebulaClientConfig({ appVersion: 'v1' })).toThrow(/authScope/);
  });

  it('defaults baseUrl to window.location.origin', () => {
    const { baseUrl } = resolveNebulaClientConfig({ appVersion: 'v1', authScope: 'a.b.c' });
    expect(baseUrl).toBe(window.location.origin);
  });

  it('passes an explicit baseUrl through unchanged', () => {
    const { baseUrl } = resolveNebulaClientConfig({
      appVersion: 'v1',
      authScope: 'a.b.c',
      baseUrl: 'https://admin.example.com',
    });
    expect(baseUrl).toBe('https://admin.example.com');
  });

  it('defaults activeScope to authScope; honors an explicit override', () => {
    expect(resolveNebulaClientConfig({ appVersion: 'v1', authScope: 'a.b.c' }).activeScope).toBe('a.b.c');
    expect(
      resolveNebulaClientConfig({ appVersion: 'v1', authScope: 'a.b', activeScope: 'a.b.child' }).activeScope,
    ).toBe('a.b.child');
  });

  it('uses an explicit onShouldRefreshUI; coerces undefined AND null to the default', () => {
    const custom = vi.fn();
    expect(
      resolveNebulaClientConfig({ appVersion: 'v1', authScope: 'a.b.c', onShouldRefreshUI: custom }).onShouldRefreshUI,
    ).toBe(custom);
    // null and undefined both keep the default (no "disable" sentinel by design).
    expect(
      resolveNebulaClientConfig({ appVersion: 'v1', authScope: 'a.b.c', onShouldRefreshUI: null }).onShouldRefreshUI,
    ).not.toBe(custom);
    expect(typeof resolveNebulaClientConfig({ appVersion: 'v1', authScope: 'a.b.c' }).onShouldRefreshUI).toBe(
      'function',
    );
  });
});

describe('default onShouldRefreshUI — reload-storm guard', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('a second immediate stale is suppressed by the session sentinel (no double-reload)', () => {
    // jsdom's window.location.reload is non-configurable (can't spy on it) and is
    // a no-op anyway, so we observe the guard's actual mechanism: the
    // sessionStorage sentinel that gates the reload. First stale arms it (and
    // reaches reload); the second short-circuits on it before reloading.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { onShouldRefreshUI } = resolveNebulaClientConfig({ appVersion: 'v1', authScope: 'a.b.c' });

    onShouldRefreshUI(STALE);
    onShouldRefreshUI(STALE);

    const sentinelWrites = setItem.mock.calls.filter(([k]) => k === 'lmz.ontology-stale-reloaded');
    expect(sentinelWrites).toHaveLength(1); // armed once; second call returned before re-arming/reloading
    expect(sessionStorage.getItem('lmz.ontology-stale-reloaded')).toBe('1');
    setItem.mockRestore();
  });
});
