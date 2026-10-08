/**
 * createNebulaClient config resolution (jsdom) — the PURE auto-detect/defaults
 * layer, unit-testable without opening a connection. The full createNebulaClient
 * (construct → connect → `ready`) is a real-Star/browser integration probe
 * (§5.3.8 / P10); `ready`'s first-connect terminal-reject pairs with P9.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveNebulaClientConfig, defaultOnLoginRequired } from '../../../../packages/resources/src/frontend/create-nebula-client';
import type { OntologyStaleInfo } from '../../../../packages/resources/src/nebula-client';

const STALE: OntologyStaleInfo = { reason: 'ontology-stale', clientVersion: 'v1', currentVersion: 'v2' };

describe('resolveNebulaClientConfig', () => {
  const PLATFORM = 'https://platform.lumenize.dev';
  afterEach(() => { document.head.querySelectorAll('meta').forEach((m) => m.remove()); });
  const meta = (name: string, content: string) => {
    const m = document.createElement('meta');
    m.name = name;
    m.content = content;
    document.head.appendChild(m);
  };

  it('RESOLVES without an ontologyVersion — an app with no resources is still an app', () => {
    // This asserted the opposite until 2026-09-25, and the old rule is what blanked a freshly
    // generated Studio preview: the serving layer injects the Galaxy's APPLIED ontology version,
    // and before anyone runs Apply there is none, so the scaffold threw at mount and the page
    // stayed `<div id="app"></div>`. Refusal moved to the resource ops, which are the only things
    // that actually need a version.
    const resolved = resolveNebulaClientConfig({ platformOrigin: PLATFORM });
    expect(resolved.ontologyVersion).toBeUndefined();
    expect(resolved.platformOrigin).toBe(PLATFORM);
  });

  it('takes the platform host from the page\'s lumenize-origin meta, at the page\'s own port', () => {
    meta('lumenize-origin', 'http://lumenize.localhost');
    const page = new URL(window.location.origin);
    const expected = `http://platform.lumenize.localhost${page.port ? `:${page.port}` : ''}`;
    expect(resolveNebulaClientConfig({ ontologyVersion: 'v1' }).platformOrigin).toBe(expected);
  });

  it('throws a clear error outside a served page when no platformOrigin is given', () => {
    expect(() => resolveNebulaClientConfig({ ontologyVersion: 'v1' })).toThrow(/platformOrigin/);
  });

  it('defaults baseUrl to window.location.origin', () => {
    const { baseUrl } = resolveNebulaClientConfig({ ontologyVersion: 'v1', platformOrigin: PLATFORM });
    expect(baseUrl).toBe(window.location.origin);
  });

  it('passes an explicit baseUrl through unchanged', () => {
    const { baseUrl } = resolveNebulaClientConfig({
      ontologyVersion: 'v1',
      platformOrigin: PLATFORM,
      baseUrl: 'https://tenant-a.app.acme.lumenize.dev',
    });
    expect(baseUrl).toBe('https://tenant-a.app.acme.lumenize.dev');
  });

  it('reads parentOrigin from the nebula-scope meta only in a frame; an explicit one wins', () => {
    meta('nebula-scope', JSON.stringify({ dev: true, parentOrigin: 'https://crm.acme.lumenize.dev' }));
    // Top-level: no parent to report to.
    expect(resolveNebulaClientConfig({ platformOrigin: PLATFORM }).parentOrigin).toBeUndefined();
    const top = vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    try {
      expect(resolveNebulaClientConfig({ platformOrigin: PLATFORM }).parentOrigin).toBe('https://crm.acme.lumenize.dev');
      expect(resolveNebulaClientConfig({ platformOrigin: PLATFORM, parentOrigin: 'https://x.lumenize.dev' }).parentOrigin)
        .toBe('https://x.lumenize.dev');
    } finally {
      top.mockRestore();
    }
  });

  it('uses an explicit onShouldRefreshUI; coerces undefined AND null to the default', () => {
    const custom = vi.fn();
    expect(
      resolveNebulaClientConfig({ ontologyVersion: 'v1', platformOrigin: PLATFORM, onShouldRefreshUI: custom }).onShouldRefreshUI,
    ).toBe(custom);
    // null and undefined both keep the default (no "disable" sentinel by design).
    expect(
      resolveNebulaClientConfig({ ontologyVersion: 'v1', platformOrigin: PLATFORM, onShouldRefreshUI: null }).onShouldRefreshUI,
    ).not.toBe(custom);
    expect(typeof resolveNebulaClientConfig({ ontologyVersion: 'v1', platformOrigin: PLATFORM }).onShouldRefreshUI).toBe(
      'function',
    );
  });
});

describe('default onLoginRequired — a framed page posts once, to the origin it was given', () => {
  // In-lane, and no running system is needed: what a frame does on a 401 is a function of the
  // window it runs in, which jsdom stands up; `dev-tab-frame` drives the same posts in a real
  // Studio. Mutation: post to `'*'` when no origin was injected → the no-origin test reds.
  it('posts the login-required message once, to the injected origin, and never navigates', () => {
    const top = vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    try {
      const onLoginRequired = defaultOnLoginRequired('https://platform.lumenize.dev', 'https://crm.acme.lumenize.dev');
      onLoginRequired();
      onLoginRequired();
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith({ type: 'lumenize:login-required' }, 'https://crm.acme.lumenize.dev');
    } finally {
      post.mockRestore();
      top.mockRestore();
    }
  });

  it('posts nothing from a frame the serving layer gave no parent origin', () => {
    const top = vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    try {
      defaultOnLoginRequired('https://platform.lumenize.dev', undefined)();
      expect(post).not.toHaveBeenCalled();
    } finally {
      post.mockRestore();
      top.mockRestore();
    }
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
    const { onShouldRefreshUI } = resolveNebulaClientConfig({ ontologyVersion: 'v1', platformOrigin: 'https://platform.lumenize.dev' });

    onShouldRefreshUI(STALE);
    onShouldRefreshUI(STALE);

    const sentinelWrites = setItem.mock.calls.filter(([k]) => k === 'lmz.ontology-stale-reloaded');
    expect(sentinelWrites).toHaveLength(1); // armed once; second call returned before re-arming/reloading
    expect(sessionStorage.getItem('lmz.ontology-stale-reloaded')).toBe('1');
    setItem.mockRestore();
  });
});
