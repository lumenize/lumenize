/**
 * A dev Star's page, framed in Studio, runs code Studio hands it (jsdom `frontend` project).
 *
 * In-lane for the reason `reload-request.test.ts` gives: what this listener refuses cannot be
 * produced by a running system. `frame-ancestors` lets only the galaxy's Studio frame a dev Star's
 * page, so only jsdom can post from a parent at another origin, or from a window that is not the
 * parent; and a tenant Star's page is never framed at all. What a running system does show, Studio
 * asking a real page and a persona's tab answering, is the `/live` scenario `persona-tabs`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { answerRunRequests, createNebulaClient } from '../../../../packages/resources/src/frontend/create-nebula-client';

const STUDIO = 'https://crm.acme.lumenize.dev';

const post = (origin: string, data: unknown, source: unknown = window.parent) =>
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }));

/** Every `lumenize:ran` the page posted to its parent, in order. */
function answers() {
  const ran: Array<{ id: unknown; ok: boolean; value?: unknown; error?: string; noSession?: boolean; to: string }> = [];
  const spy = vi.spyOn(window.parent, 'postMessage').mockImplementation(((msg: any, to: string) => {
    if (msg?.type === 'lumenize:ran') ran.push({ id: msg.id, ok: msg.ok, value: msg.value, error: msg.error, noSession: msg.noSession, to });
  }) as never);
  return { ran, spy };
}

const client = { claims: { sub: 'gerry-sub' }, double: (n: number) => n * 2 };
const store = { resources: { Deal: {} } };

describe('answerRunRequests', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('runs the code with client and store in scope, waits for its Promise, and posts the value to the parent', async () => {
    // Mutations: answer without awaiting the code → the value is a Promise → red; drop `client` or
    // `store` from the function's scope → a ReferenceError comes back → red.
    const { ran } = answers();
    const remove = answerRunRequests({ parentOrigin: STUDIO, client, store, ready: Promise.resolve() });
    try {
      post(STUDIO, {
        type: 'lumenize:run', id: 'r1',
        code: "await new Promise((r) => setTimeout(r, 5)); return { sub: client.claims.sub, four: client.double(2), types: Object.keys(store.resources) }",
      });
      await vi.waitFor(() => expect(ran).toHaveLength(1));
      expect(ran[0]).toEqual({ id: 'r1', ok: true, value: { sub: 'gerry-sub', four: 4, types: ['Deal'] }, error: undefined, noSession: undefined, to: STUDIO });
    } finally {
      remove();
    }
  });

  it('answers a throw as a result that names the error, not as silence', async () => {
    const { ran } = answers();
    const remove = answerRunRequests({ parentOrigin: STUDIO, client, store, ready: Promise.resolve() });
    try {
      post(STUDIO, { type: 'lumenize:run', id: 'r2', code: "throw new TypeError('no such deal')" });
      post(STUDIO, { type: 'lumenize:run', id: 'r3', code: 'return nope.field' });
      await vi.waitFor(() => expect(ran).toHaveLength(2));
      // A throw is the code's own answer, so it is no sign the page lacks a session.
      expect(ran.find((a) => a.id === 'r2')).toMatchObject({ ok: false, error: 'TypeError: no such deal', noSession: undefined });
      expect(ran.find((a) => a.id === 'r3')).toMatchObject({ ok: false, error: 'ReferenceError: nope is not defined' });
    } finally {
      remove();
    }
  });

  it('runs only once the client is ready, and says it has no session when it never will be', async () => {
    // Mutation: drop the wait on `ready` → the code runs before the client connects → red.
    const { ran } = answers();
    let connect!: () => void;
    const order: string[] = [];
    const ready = new Promise<void>((resolve) => { connect = () => { order.push('ready'); resolve(); }; });
    const remove = answerRunRequests({ parentOrigin: STUDIO, client: { ran: () => { order.push('ran'); return 1; } }, store, ready });
    try {
      post(STUDIO, { type: 'lumenize:run', id: 'w1', code: 'return client.ran()' });
      await Promise.resolve();
      expect(order).toEqual([]);
      connect();
      await vi.waitFor(() => expect(ran).toHaveLength(1));
      expect(order).toEqual(['ready', 'ran']);
    } finally {
      remove();
    }
    const failed = answerRunRequests({ parentOrigin: STUDIO, client, store, ready: Promise.reject(new Error('No refresh cookie covers this host')) });
    try {
      post(STUDIO, { type: 'lumenize:run', id: 'w2', code: 'return 1' });
      await vi.waitFor(() => expect(ran).toHaveLength(2));
      // `noSession` is what tells Studio to load the page again later, as for a persona not yet accepted.
      expect(ran[1]).toMatchObject({ id: 'w2', ok: false, noSession: true, error: 'Error: No refresh cookie covers this host' });
    } finally {
      failed();
    }
  });

  it('says to return plain data when the browser cannot copy the value across windows', async () => {
    const ran: any[] = [];
    vi.spyOn(window.parent, 'postMessage').mockImplementation(((msg: any) => {
      if (msg?.ok === true) throw new DOMException('#<Object> could not be cloned.', 'DataCloneError');
      ran.push(msg);
    }) as never);
    const remove = answerRunRequests({ parentOrigin: STUDIO, client, store, ready: Promise.resolve() });
    try {
      post(STUDIO, { type: 'lumenize:run', id: 'c1', code: 'return store' });
      await vi.waitFor(() => expect(ran).toHaveLength(1));
      expect(ran[0]).toMatchObject({ type: 'lumenize:ran', id: 'c1', ok: false });
      expect(ran[0].error).toContain('could not be sent back');
      expect(ran[0].error).toContain('Return plain data');
    } finally {
      remove();
    }
  });

  // Each row is a request the listener must not run. The request after it, from Studio's own
  // origin and window, is the barrier and the positive control: it is answered, and it alone.
  it.each([
    ['from the parent at another origin', () => post('https://evil.example', { type: 'lumenize:run', id: 'n', code: 'return 1' })],
    ['at Studio\'s origin from a window that is not the parent', () => post(STUDIO, { type: 'lumenize:run', id: 'n', code: 'return 1' }, {})],
    ['of another type', () => post(STUDIO, { type: 'lumenize:reload', id: 'n', code: 'return 1' })],
    ['whose code is not a string', () => post(STUDIO, { type: 'lumenize:run', id: 'n', code: { toString: () => 'return 1' } })],
  ])('runs nothing for a request %s', async (_name, refusedRequest) => {
    const { ran } = answers();
    const ranCode = vi.fn(() => 1);
    const remove = answerRunRequests({ parentOrigin: STUDIO, client: { ranCode }, store, ready: Promise.resolve() });
    try {
      refusedRequest();
      post(STUDIO, { type: 'lumenize:run', id: 'p', code: 'return client.ranCode()' });
      await vi.waitFor(() => expect(ran.some((a) => a.id === 'p')).toBe(true));
      expect(ran.map((a) => a.id)).toEqual(['p']);
      expect(ranCode).toHaveBeenCalledTimes(1);
    } finally {
      remove();
    }
  });
});

describe('createNebulaClient answers a run request only on a framed dev Star page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.head.querySelectorAll('meta').forEach((m) => m.remove());
  });

  const page = (meta: Record<string, unknown>, framed: boolean) => {
    document.head.querySelectorAll('meta').forEach((m) => m.remove());
    const m = document.createElement('meta');
    m.name = 'nebula-scope';
    m.content = JSON.stringify(meta);
    document.head.appendChild(m);
    vi.spyOn(window, 'top', 'get').mockReturnValue(framed ? {} as Window : window);
    // No session: `ready` rejects, so a page that listens answers `ok: false` with why, and the
    // answer itself is what shows it listened.
    return createNebulaClient({
      platformOrigin: 'https://platform.lumenize.dev',
      baseUrl: 'https://dev.crm.acme.lumenize.dev',
      fetch: async () => new Response('{"error":"no_session"}', { status: 401 }),
      sessionStorage: undefined,
      // A top-level page with no session would otherwise be sent to log in, which jsdom cannot do.
      onLoginRequired: () => {},
    });
  };

  // Mutation: drop the factory's `dev` condition, its frame condition or its parent-origin
  // condition → that row's page answers `n` too → red.
  it.each([
    ['is not framed', { dev: true, parentOrigin: STUDIO }, false],
    ['the serving layer did not mark as a dev Star\'s', { parentOrigin: STUDIO }, true],
    ['names no parent origin', { dev: true }, true],
  ])('a page that %s runs nothing, and a framed dev page beside it does', async (_name, meta, framed) => {
    const { ran } = answers();
    const refusing = page(meta, framed);
    await refusing.ready.catch(() => { /* no session, by construction */ });
    post(STUDIO, { type: 'lumenize:run', id: 'n', code: 'return 1' });
    const listening = page({ dev: true, parentOrigin: STUDIO }, true);
    try {
      await listening.ready.catch(() => { /* no session, by construction */ });
      post(STUDIO, { type: 'lumenize:run', id: 'p', code: 'return 1' });
      await vi.waitFor(() => expect(ran.some((a) => a.id === 'p')).toBe(true));
      // One answer to `p`, from the listening page alone, and none to `n` from either.
      expect(ran.map((a) => a.id)).toEqual(['p']);
      expect(ran[0]).toMatchObject({ ok: false, noSession: true, to: STUDIO });
    } finally {
      await refusing.dispose();
      await listening.dispose();
    }
  });
});
