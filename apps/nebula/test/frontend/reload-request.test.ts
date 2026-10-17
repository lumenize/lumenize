/**
 * A page framed in Studio and Studio's reload request (jsdom `frontend` project).
 *
 * In-lane, for three reasons. The decision is a pure function by design (calibration §12), so a
 * table pins every arm. A request from `window.parent` at another origin cannot be produced by a
 * running system: `frame-ancestors` lets only Studio's origin frame the dev tab, so only jsdom can
 * post from a parent at the wrong origin; the wrong-WINDOW case is a `/live` limb instead
 * (`build-reaches-every-studio`). And the order of the first `loaded` against a `login-required` is
 * a property of what the factory does at construction, which a frame with no session shows here
 * as it would in a browser.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { decideReloadRequest } from '../../../../packages/resources/src/frontend/reload-request';
import { answerReloadRequests, createNebulaClient } from '../../../../packages/resources/src/frontend/create-nebula-client';

const STUDIO = 'https://crm.acme.lumenize.dev';
const OWN = '1b7d0000';
const NEW = '9c41e000';

describe('decideReloadRequest', () => {
  // Mutation: each arm flipped reds its own row; comparing only the guard's `for` reds the
  // page that moved on.
  it.each([
    ['a request naming the build the page runs stays', { requested: OWN, own: OWN, guard: undefined }, 'stay'],
    ['a request naming another build, guard unset, refreshes', { requested: NEW, own: OWN, guard: undefined }, 'refresh'],
    ['the same request with the guard set for it stays', { requested: NEW, own: OWN, guard: { for: NEW, from: OWN } }, 'stay'],
    ['a guard set for an older build does not stop a newer one', { requested: NEW, own: OWN, guard: { for: 'aaaa0000', from: OWN } }, 'refresh'],
    ['a request for the build the guard refreshed for, from a page that has since moved, refreshes', { requested: NEW, own: 'cccc0000', guard: { for: NEW, from: OWN } }, 'refresh'],
    ['a request naming no build reloads', { requested: undefined, own: OWN, guard: undefined }, 'reload'],
    ['a request naming no build reloads even with the guard set', { requested: undefined, own: OWN, guard: { for: OWN, from: 'aaaa0000' } }, 'reload'],
    ['a page whose meta names no build refreshes for any named one', { requested: NEW, own: undefined, guard: undefined }, 'refresh'],
  ] as const)('%s', (_name, input, expected) => {
    expect(decideReloadRequest(input)).toBe(expected);
  });
});

/** A `sessionStorage` of the test's own, so the guard's key is readable. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, v); },
  };
}

const request = (origin: string, data: unknown) =>
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: window.parent }));

describe('answerReloadRequests — a frame answers only its parent, at the origin it resolved', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('posts loaded at once, echoes a request from the parent, and calls the hook with a BuildStaleInfo once', () => {
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const hook = vi.fn();
    const storage = memoryStorage();
    const remove = answerReloadRequests({ parentOrigin: STUDIO, buildVersion: OWN, onShouldRefreshUI: hook, sessionStorage: storage });
    try {
      expect(post.mock.calls).toEqual([[{ type: 'lumenize:loaded', build: OWN }, STUDIO]]);
      request(STUDIO, { type: 'lumenize:reload', id: 'r7', build: NEW });
      request(STUDIO, { type: 'lumenize:reload', id: 'r8', build: NEW });
      expect(post.mock.calls.slice(1)).toEqual([
        [{ type: 'lumenize:loaded', id: 'r7', build: OWN }, STUDIO],
        [{ type: 'lumenize:loaded', id: 'r8', build: OWN }, STUDIO],
      ]);
      expect(hook.mock.calls).toEqual([[{ reason: 'build-stale', clientVersion: OWN, currentVersion: NEW }]]);
      expect(storage.getItem('lmz.build-reloaded-for')).toBe(JSON.stringify({ for: NEW, from: OWN }));
    } finally {
      remove();
    }
  });

  it('ignores a request from the parent at another origin, and answers it with nothing', () => {
    // Mutation: drop the origin check → the request is echoed and the hook runs → red.
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const hook = vi.fn();
    const remove = answerReloadRequests({ parentOrigin: STUDIO, buildVersion: OWN, onShouldRefreshUI: hook, sessionStorage: memoryStorage() });
    try {
      post.mockClear();
      request('https://evil.example', { type: 'lumenize:reload', id: 'x1', build: NEW });
      expect(post).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
      // Positive control: the same request at the resolved origin is answered.
      request(STUDIO, { type: 'lumenize:reload', id: 'x2', build: NEW });
      expect(post).toHaveBeenCalledWith({ type: 'lumenize:loaded', id: 'x2', build: OWN }, STUDIO);
      expect(hook).toHaveBeenCalledTimes(1);
    } finally {
      remove();
    }
  });
});

describe('createNebulaClient in a frame with no session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.head.querySelectorAll('meta').forEach((m) => m.remove());
  });

  it('posts loaded before login-required', async () => {
    // Mutation: post the first `loaded` once `ready` settles → login-required comes first → red.
    const m = document.createElement('meta');
    m.name = 'nebula-scope';
    m.content = JSON.stringify({ dev: true, parentOrigin: STUDIO, buildVersion: OWN });
    document.head.appendChild(m);
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    const posts: string[] = [];
    let firstBuild: unknown;
    vi.spyOn(window.parent, 'postMessage').mockImplementation((msg: unknown) => {
      if (posts.length === 0) firstBuild = (msg as { build?: unknown }).build;
      posts.push((msg as { type: string }).type);
    });
    const { ready, dispose } = createNebulaClient({
      platformOrigin: 'https://platform.lumenize.dev',
      baseUrl: 'https://dev.crm.acme.lumenize.dev',
      fetch: async () => new Response('{"error":"no_session"}', { status: 401 }),
      sessionStorage: memoryStorage(),
    });
    try {
      await ready.catch(() => { /* the login-required path, which this test is about */ });
      await vi.waitFor(() => expect(posts).toContain('lumenize:login-required'));
      expect(posts.indexOf('lumenize:loaded')).toBe(0);
      expect(firstBuild).toBe(OWN); // read from the page's own meta by the factory
      expect(posts.indexOf('lumenize:login-required')).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });
});
